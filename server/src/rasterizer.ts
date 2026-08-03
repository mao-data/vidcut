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
  /** 換行寬 0–1,預設 0.9(= text_card 既有 margin 預設) */
  maxWidthFrac?: number;
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

export class PillowRasterizer {
  readonly id = 'pillow-1';
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  // public 可變:啟動時字型表要靠 rasterizer 自己 probe,表建好後回頭換上真 resolver(Task 2)
  constructor(public resolveFontPath: (family: string) => string | undefined) {}

  private ensureChild(): void {
    if (this.child && this.child.exitCode === null) return;
    this.child = spawn('python3', [TEXT_CARD_PY, '--worker'], { stdio: 'pipe' });
    this.rl = createInterface({ input: this.child.stdout });
  }

  /** 單一 in-flight:請求排隊送 worker,一問一答。worker 掛了下個請求自動重啟。 */
  private request<T extends WorkerReply>(payload: Record<string, unknown>): Promise<T> {
    const run = async (): Promise<T> => {
      this.ensureChild();
      const child = this.child!;
      const reply = new Promise<string>((res, rej) => {
        const onExit = () => rej(new Error('rasterizer worker died'));
        child.once('exit', onExit);
        this.rl!.once('line', (l) => {
          child.removeListener('exit', onExit);
          res(l);
        });
      });
      child.stdin.write(JSON.stringify(payload) + '\n');
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
    const margin = Math.round((req.width * (1 - (req.maxWidthFrac ?? 0.9))) / 2);
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
    this.child?.kill();
    this.child = null;
  }
}
