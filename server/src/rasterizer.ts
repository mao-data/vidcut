// server/src/rasterizer.ts — Pillow 常駐 worker(7ms/張;逐次 spawn 要 50-70ms)
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_CARD_PY = join(dirname(fileURLToPath(import.meta.url)), '../scripts/text_card.py');

export interface TextCardStyle {
  fontFamily: string;
  fontSize: number;
  fill: string;
  stroke?: string;
  highlight?: string;
}
export interface CardRequest {
  text: string;
  tokens?: string[];
  style: TextCardStyle;
  /** 畫布寬(1080) */
  width: number;
  /**
   * 自動換行的可用寬,相對畫布寬的分數,0–1,預設 0.9。
   * **真的會折行**(2026-08-04 起):可用寬 = `width - cardMargin() * 2`,
   * 有無 tokens 都吃這個值。CJK 逐字斷、拉丁在空白處斷(不切進單字中間)、
   * 真的 `\n` 仍強制換行、單一超寬原子逐字硬切。規則在 `text_card.py` 的
   * `wrap_text()`。在這之前它只影響 `layout_tokens()`(＝只有 karaoke 字幕),
   * 對文字 overlay 與一般字幕是死欄位。
   */
  maxWidthFrac?: number;
}

/**
 * 換行寬 → text_card.py 的 `margin`(單側留白 px)。**唯一的換算來源**:預覽路徑
 * (`rasterize()`)與匯出路徑(`render.ts` 的 `renderCaptionCard`)都得用它,
 * 兩邊才會折在同一個位置、輸出同一張 PNG。
 *
 * 曾經只有預覽端傳 `margin`,匯出端靠 python 的預設 `max(32, width // 20)`
 * ——1080/720/640 寬時兩式剛好同值(54/36/32),所以「不換行」的年代看不出差別;
 * 一旦真的折行,畫布寬 < 640 的專案就會出現「預覽折三行、成品折兩行」。
 */
export function cardMargin(width: number, maxWidthFrac = 0.9): number {
  return Math.round((width * (1 - maxWidthFrac)) / 2);
}
export interface TokenBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface CardGeometry {
  width: number;
  height: number;
  lines: number;
  tokens?: TokenBox[];
}
interface WorkerReply extends Omit<Partial<CardGeometry>, 'tokens'> {
  ok: boolean;
  error?: string;
  tokens?: TokenBox[] | null;
}

/** stderr 尾巴保留量:只是為了讓錯誤訊息有線索(python traceback 通常夠短),不無限吃記憶體。 */
const STDERR_TAIL = 4096;

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export class PillowRasterizer {
  /**
   * 進 `cardKey` 的引擎版本。**改變輸出像素的任何行為都必須把這個號碼往上加**——
   * 字卡是內容定址的，同一組輸入永遠算出同一把鑰匙，所以舊卡不會自己重畫：
   * 忘了加號碼，既有專案就永遠停在舊排版，而且使用者在 UI 上做什麼都修不好它
   * （2026-08-04 實例：加了自動換行卻沒動這個號碼，長文字的既有字卡繼續維持
   * 「排成一行、頭尾被畫布切掉」的樣子，重打一模一樣的字也照樣命中舊卡）。
   *
   * pillow-1 → pillow-2：無 tokens 路徑加入自動換行（見 text_card.py 的 wrap_text）。
   */
  readonly id = 'pillow-2';
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * 這個 worker 還活著嗎。**不要用 `child.exitCode === null` 判斷**:被訊號殺死
   * (SIGKILL / SIGSEGV / OOM killer)時 `exitCode` 永遠是 null、訊號在 `signalCode`,
   * 用 exitCode 判斷會把屍體當活人 → 不重啟 worker、往死掉的 stdout 掛 line listener,
   * 請求永遠不 settle;而 wsHub 的 command queue 串在這條 promise 上,
   * 之後所有 WS 命令(連拖片段、刪片段這種跟文字無關的)都會靜默不執行也不報錯。
   * 用旗標統一涵蓋「正常結束 / 被訊號殺 / spawn 失敗 / stdio 出錯」四種死法。
   */
  private alive = false;
  /** 死因:讓 in-flight 與後續請求 reject 出有用訊息,而不是卡住。 */
  private deadReason: Error | null = null;
  private stderrTail = '';
  /**
   * in-flight 請求的死訊接收端。請求掛在**這裡**(rasterizer 層級),不是掛在 child 的
   * 'exit'/'error' 事件上——teardown() 為了不讓舊 child 的事件汙染新 child 會
   * removeAllListeners(),若請求直接掛 child 事件,那一行會連同它唯一的「醒來路徑」
   * 一起拔掉:kill() 之後沒有任何 listener 會 reject 它,這個請求永遠 pending;
   * 而 this.queue 串在它後面,整個 rasterizer 從此永久卡死(dispose() 就是這樣重新
   * 引入了這批修正原本要消滅的那個 wedge)。
   * 改成單一出口:不管誰宣告死亡(exit / error / EPIPE / dispose),都走 markDead 通知。
   */
  private deathWaiters = new Set<(e: Error) => void>();

  // public 可變:啟動時字型表要靠 rasterizer 自己 probe,表建好後回頭換上真 resolver(Task 2)
  constructor(public resolveFontPath: (family: string) => string | undefined) {}

  private markDead(err: Error): void {
    // 保留第一個死因(最接近根因),但**每次都要通知等待者**——
    // 「已經死過了」不代表現在沒有人在等(dispose 一具早就死掉的 worker 也要叫醒 in-flight)。
    if (this.alive || !this.deadReason) this.deadReason = err;
    this.alive = false;
    const reason = this.deadReason;
    const waiters = [...this.deathWaiters];
    this.deathWaiters.clear();
    for (const w of waiters) w(reason);
  }

  private teardown(reason: Error): void {
    // 順序是關鍵:**先宣告死亡**(叫醒 in-flight 請求),再拆 listener、再 kill。
    // 反過來寫的話 removeAllListeners() 會先把 in-flight 的死訊路徑拔掉,
    // 之後的 kill() 就再也沒有人聽得到 → 永遠 pending。
    this.markDead(reason);
    const c = this.child;
    this.rl?.close();
    this.rl = null;
    if (c) {
      c.removeAllListeners();
      c.stdin.removeAllListeners();
      c.stderr.removeAllListeners();
      c.kill();
    }
    this.child = null;
  }

  private ensureChild(): void {
    if (this.child && this.alive) return;
    this.teardown(this.deadReason ?? new Error('rasterizer worker restarting'));
    this.deadReason = null;
    this.stderrTail = '';
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('python3', [TEXT_CARD_PY, '--worker'], { stdio: 'pipe' });
    } catch (e) {
      // spawn 也可能同步丟(參數/選項不合法)。記成死亡,讓 request 直接 reject。
      this.markDead(new Error(`rasterizer worker spawn failed: ${toError(e).message}`));
      return;
    }
    this.child = child;
    this.alive = true;
    this.rl = createInterface({ input: child.stdout });
    // spawn ENOENT(PATH 上沒有 python3)是 EventEmitter 的 'error' 事件,沒有 listener
    // 就是 uncaughtException——整個 server 會在 listen() 之前就死掉(見 index.ts 的降級)。
    child.on('error', (e) => this.markDead(new Error(`rasterizer worker error: ${e.message}`)));
    // 往死掉的 pipe 寫會 EPIPE,一樣是沒人接就炸的 EventEmitter error。
    child.stdin.on('error', (e) =>
      this.markDead(new Error(`rasterizer stdin error: ${e.message}`)),
    );
    const died = (code: number | null, signal: NodeJS.Signals | null): void =>
      this.markDead(
        new Error(
          `rasterizer worker died (code=${code}, signal=${signal})` +
            (this.stderrTail ? `: ${this.stderrTail.trim().slice(-500)}` : ''),
        ),
      );
    child.on('exit', died);
    // 'close'(stdio 全關)當保險:理論上 exit 一定先到,但少一個「只關 pipe 不 exit」
    // 的縫隙,代價只是一次 no-op(markDead 保留第一個死因)。
    child.on('close', died);
    // stderr 一定要抽掉:pipe 沒人讀,緩衝區(macOS 64KB)填滿後 python 會卡在 write,
    // 於是連 stdout 的回覆都送不出來——又是一種永遠不 settle。順便留尾巴當死因線索。
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-STDERR_TAIL);
    });
  }

  /** 單一 in-flight:請求排隊送 worker,一問一答。worker 掛了下個請求自動重啟。 */
  private request<T extends WorkerReply>(payload: Record<string, unknown>): Promise<T> {
    const run = async (): Promise<T> => {
      this.ensureChild();
      const child = this.child;
      const rl = this.rl;
      if (!child || !rl || !this.alive) {
        throw this.deadReason ?? new Error('rasterizer worker unavailable');
      }
      let cleanup = (): void => {};
      const reply = new Promise<string>((res, rej) => {
        const onLine = (l: string): void => {
          cleanup();
          res(l);
        };
        // 任何一種死法都必須讓這個請求 reject(而不是永遠 pending)。死訊只從
        // deathWaiters 這一個出口來(見上面的欄位註解),所以 teardown() 拆 child
        // listener 不會影響它。
        const onDeath = (e: Error): void => {
          cleanup();
          rej(e);
        };
        cleanup = () => {
          rl.removeListener('line', onLine);
          this.deathWaiters.delete(onDeath);
        };
        this.deathWaiters.add(onDeath);
        rl.on('line', onLine);
      });
      try {
        child.stdin.write(JSON.stringify(payload) + '\n');
      } catch (e) {
        cleanup();
        this.markDead(new Error(`rasterizer write failed: ${toError(e).message}`));
        throw this.deadReason;
      }
      return JSON.parse(await reply) as T;
    };
    const p = this.queue.then(run, run);
    this.queue = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  async probeFont(path: string): Promise<boolean> {
    return (await this.request({ op: 'probeFont', path })).ok;
  }

  async rasterize(req: CardRequest, outBase: string, outHl?: string): Promise<CardGeometry> {
    const margin = cardMargin(req.width, req.maxWidthFrac ?? 0.9);
    const r = await this.request({
      text: req.text,
      tokens: req.tokens ?? null,
      fontSize: req.style.fontSize,
      fill: req.style.fill,
      stroke: req.style.stroke ?? null,
      highlight: req.style.highlight ?? null,
      width: req.width,
      margin,
      fontPath: this.resolveFontPath(req.style.fontFamily) ?? null,
      outBase,
      outHl: outHl ?? null,
    });
    if (!r.ok) throw new Error(`rasterize failed: ${r.error}`);
    return {
      width: r.width!,
      height: r.height!,
      lines: r.lines!,
      ...(r.tokens ? { tokens: r.tokens } : {}),
    };
  }

  dispose(): void {
    // teardown 會先叫醒 in-flight 請求(帶這個死因)再殺 child——所以「dispose 撞上
    // 正在等回覆的請求」會得到一個 reject,不是永遠 pending。
    this.teardown(new Error('rasterizer disposed'));
    // dispose 後若還有人呼叫,ensureChild 會重開一個新 worker(既有行為)。
    this.deadReason = null;
  }
}
