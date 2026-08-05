import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { cardMargin, PillowRasterizer, type CardRequest } from '../src/rasterizer.js';

/**
 * 最小 PNG 解碼器——只認 Pillow 產出的那一種（8-bit RGBA、非交錯）。
 *
 * 為什麼要自己解：base/hl 兩張卡「幾何一致」的唯一有意義證據是**逐像素**的
 * alpha 相同（同一套字形、同一個位置，只有顏色不同）。比 PNG 檔頭的 IHDR
 * 寬高位元組（bytes 16–24）等於什麼都沒驗：兩張圖出自 render_cards() 同一次
 * 排版、同一組 (width, height) 區域變數、同一行 Image.new，沒有任何程式路徑
 * 能讓它們的檔頭不同。為了測試多拉一個 PNG 相依進來不划算，這裡 40 行搞定。
 */
function decodeRgba(buf: Buffer): { width: number; height: number; data: Buffer } {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let p = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, interlace] = [body[8]!, body[9]!, body[12]!];
      if (depth !== 8 || colour !== 6 || interlace !== 0) {
        throw new Error(`只支援 8-bit RGBA 非交錯 PNG（depth=${depth} colour=${colour})`);
      }
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body));
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len; // len(4) + type(4) + data + crc(4)
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp]! : 0; // 左
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0; // 上
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp]! : 0; // 左上
      let v = line[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const [pa, pb, pc] = [Math.abs(pp - a), Math.abs(pp - b), Math.abs(pp - c)];
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`未知的 PNG filter ${filter}`);
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, data: out };
}

/** 取出私有的 child 來做「真的用訊號殺掉 worker」的測試——沒有別的方法能模擬 OOM kill。 */
function childOf(r: PillowRasterizer): ChildProcess {
  const c = (r as unknown as { child: ChildProcess | null }).child;
  if (!c) throw new Error('worker 尚未啟動');
  return c;
}
const CARD = (text: string): CardRequest => ({
  text,
  style: { fontFamily: 'x', fontSize: 40, fill: '#fff' },
  width: 1080,
});

const r = new PillowRasterizer(() => undefined); // 無字型表 → text_card 既有候選鏈
afterAll(() => r.dispose());

describe('PillowRasterizer', () => {
  it('renders base+highlight cards with identical geometry and per-token bboxes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-ras-'));
    const geo = await r.rasterize(
      {
        text: '這是測試字幕',
        tokens: ['這是', '測試', '字幕'],
        style: {
          fontFamily: 'PingFang TC',
          fontSize: 64,
          fill: '#ffffff',
          stroke: '#000000',
          highlight: '#FCDE5A',
        },
        width: 1080,
      },
      join(dir, 'a.base.png'),
      join(dir, 'a.hl.png'),
    );
    expect(geo.height).toBeGreaterThan(60);
    expect(geo.tokens).toHaveLength(3);
    // bbox 單調遞增且在畫布內
    const t = geo.tokens!;
    expect(t[1]!.x).toBeGreaterThan(t[0]!.x);
    expect(t[2]!.x + t[2]!.w).toBeLessThanOrEqual(1080);

    const [b, h] = await Promise.all([
      readFile(join(dir, 'a.base.png')),
      readFile(join(dir, 'a.hl.png')),
    ]);
    const [bPng, hPng] = [decodeRgba(b), decodeRgba(h)];
    // 回報的 geometry 必須是圖**真正的**尺寸,不是把請求的 width 原封抄回來。
    // （舊版寫 `expect(geo.width).toBe(1080)`：rasterizer.ts 把 req.width 直接放進
    // 回覆,那條斷言只是把自己的輸入讀回來,任何排版錯誤都攔不到。）
    expect([bPng.width, bPng.height]).toEqual([geo.width, geo.height]);
    expect(bPng.width).toBe(1080);
    expect([hPng.width, hPng.height]).toEqual([bPng.width, bPng.height]);

    // ---- 「兩卡幾何一致」的真證據：alpha 通道逐像素相同 ----
    // 同一套字形、同一個位置,只有顏色不同 → 覆蓋率(alpha)必須完全重合。
    // clip-path 揭色的前提就是這個:hl 疊在 base 上,任何位移/換行差異都會露餡。
    let alphaDiff = 0;
    for (let i = 3; i < bPng.data.length; i += 4) {
      if (bPng.data[i] !== hPng.data[i]) alphaDiff++;
    }
    expect(alphaDiff).toBe(0);
    // 但**不是**同一張圖:每個 token 的 bbox 內都要有筆畫(alpha>0),而且 base 與 hl
    // 在該處的顏色不同(base=fill #ffffff、hl=highlight #FCDE5A)——bbox 若標錯位置,
    // 這裡就找不到那個「同形不同色」的區域。
    for (const [i, box] of t.entries()) {
      let ink = 0;
      let coloured = 0;
      for (let y = box.y; y < Math.min(box.y + box.h, bPng.height); y++) {
        for (let x = Math.round(box.x); x < Math.min(box.x + box.w, bPng.width); x++) {
          const o = (y * bPng.width + x) * 4;
          if (bPng.data[o + 3]! > 0) ink++;
          if (bPng.data[o + 2] !== hPng.data[o + 2]) coloured++; // 藍通道:ff vs 5a
        }
      }
      expect(ink, `token ${i} 的 bbox 內沒有任何筆畫`).toBeGreaterThan(0);
      expect(coloured, `token ${i} 的 bbox 內 base/hl 顏色完全相同`).toBeGreaterThan(0);
    }
  }, 30_000);

  it('renders a plain card (no tokens) without hl output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-ras-'));
    const geo = await r.rasterize(
      { text: 'plain', style: { fontFamily: 'x', fontSize: 48, fill: '#fff' }, width: 1080 },
      join(dir, 'p.base.png'),
    );
    expect(geo.tokens).toBeUndefined();
    expect(geo.lines).toBe(1);
  }, 30_000);

  // `ink` 是預覽端字幕卡的**命中框**（ui/src/player/CaptionLayer.tsx 的 inkStyle）：
  // 卡片一律畫布全寬、文字水平置中，短字幕的 PNG 兩側是一大片透明，而瀏覽器的命中測試
  // 只看盒子不看 alpha——用整張卡當命中框的話，那條橫貫畫布的帶子會吃掉底下 overlay
  // 的所有 pointer 事件（2026-08-05 修）。所以這裡釘的是**確切的數字**，不是「有這個鍵」。
  it('ink：墨跡的水平範圍，水平置中且把描邊算進去', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-ras-'));
    const one = (stroke?: string) =>
      r.rasterize(
        {
          text: '嗨',
          style: {
            fontFamily: 'Heiti TC',
            fontSize: 64,
            fill: '#fff',
            ...(stroke ? { stroke } : {}),
          },
          width: 1080,
        },
        join(dir, `ink${stroke ? '-s' : ''}.base.png`),
      );

    const plain = await one();
    expect(plain.ink).toEqual({ x: 508, w: 64 }); // 一個全形字＝一個 em；508+64/2 = 540 ＝畫布中線
    expect(plain.ink!.w).toBeLessThan(plain.width / 10); // 命中框只有整張卡的 6%

    // 描邊往外長 stroke_w（= max(2, 64//16) = 4）：左右各多 4px
    const stroked = await one('#000');
    expect(stroked.ink).toEqual({ x: 504, w: 72 });

    // 折到滿版的長文字：ink 寬 = 可用寬（1080 - cardMargin(1080,0.9)*2 = 1080 - 120）。
    // 這個方向不該「變窄」——真的有那麼寬的墨跡，命中框就該有那麼寬。
    const wrapped = await r.rasterize(
      {
        text: '這是一段很長的字幕會被自動折行成好幾行所以每一行的寬度都逼近可用寬',
        style: { fontFamily: 'Heiti TC', fontSize: 64, fill: '#fff' },
        width: 1080,
      },
      join(dir, 'ink-wrap.base.png'),
    );
    expect(wrapped.lines).toBeGreaterThan(1);
    expect(wrapped.ink).toEqual({ x: 60, w: 960 });
  }, 30_000);

  it('probeFont: 開得了的字型 true、開不了的 false', async () => {
    expect(await r.probeFont('/System/Library/Fonts/STHeiti Medium.ttc')).toBe(true);
    expect(await r.probeFont('/nonexistent.ttf')).toBe(false);
  }, 30_000);

  // 每一筆用**不同的字級**送出:這樣「回覆有沒有配對到正確的請求」才驗得到。
  // 全部同字級的話,回覆張冠李戴也看不出來——而那正是拿掉 queue 的實際症狀:
  // 5 個請求都往同一個 readline 掛 'line' listener,worker 吐出的第一行會同時
  // resolve 全部 5 個 promise,五筆拿到一模一樣的幾何。
  it('serializes concurrent requests through one worker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-ras-'));
    const sizes = [40, 48, 56, 64, 72]; // height = size + max(6, size//5) + 8 → 嚴格遞增
    const geos = await Promise.all(
      sizes.map((fontSize, i) =>
        r.rasterize(
          { text: `並發${i}`, style: { fontFamily: 'x', fontSize, fill: '#fff' }, width: 1080 },
          join(dir, `c${i}.base.png`),
        ),
      ),
    );
    for (const [i, g] of geos.entries()) {
      expect(g.height, `第 ${i} 筆的回覆對不上它自己的字級`).toBe(
        sizes[i]! + Math.max(6, Math.floor(sizes[i]! / 5)) + 8,
      );
      expect((await stat(join(dir, `c${i}.base.png`))).size).toBeGreaterThan(0);
    }
  }, 30_000);
});

/**
 * 無 tokens 的自動換行（2026-08-04）。在這之前 `maxWidth`/`maxWidthFrac` 是**死欄位**：
 * `text_card.py` 只在 `layout_tokens()`（＝只有 karaoke 字幕會跑）裡用它折行，
 * 文字 overlay 與一般字幕走的是 `text.split("\n")`，長文字被畫布邊緣裁掉、沒有任何警告。
 *
 * 這一組測試全部是**行為性**的（比 PNG 位元組、比 lines、比墨跡外框），
 * 把 `wrap_text()` 換回 `split("\n")` 每一條都會紅——沒有「只是護欄、不可能失敗」那種。
 *
 * ⚠️ **這一組紅了、而且是你故意改排版造成的話，一併把 `PillowRasterizer.id` 往上加。**
 * 字卡是內容定址的：不加號碼，既有專案的字卡永遠停在舊排版，使用者重打一模一樣的字
 * 也救不回來（同輸入→同 key→命中舊卡）。加了自動換行卻忘了加號碼，正是 2026-08-04
 * 使用者回報「字太多前面被吃掉」的成因。
 */
describe('無 tokens 的自動換行（maxWidth 不再是死欄位）', () => {
  const LONG = '這是一段很長的中文字幕測試自動換行行為，混合 Latin words 與中文標點。';
  const style = { fontFamily: 'x', fontSize: 64, fill: '#ffffff' };

  /** 同一段文字、只差 maxWidthFrac → 以前輸出逐位元組相同，這正是「死欄位」的實測證據。 */
  it('maxWidthFrac 真的影響輸出：0.9 與 0.3 的行數、高度、PNG 位元組都不同', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-wrap-'));
    const wide = await r.rasterize(
      { text: LONG, style, width: 1080, maxWidthFrac: 0.9 },
      join(dir, 'wide.base.png'),
    );
    const narrow = await r.rasterize(
      { text: LONG, style, width: 1080, maxWidthFrac: 0.3 },
      join(dir, 'narrow.base.png'),
    );
    expect(wide.lines).toBeGreaterThan(1); // 0.9 就已經放不下這段話
    expect(narrow.lines).toBeGreaterThan(wide.lines);
    expect(narrow.height).toBeGreaterThan(wide.height);
    const [a, b] = await Promise.all([
      readFile(join(dir, 'wide.base.png')),
      readFile(join(dir, 'narrow.base.png')),
    ]);
    expect(a.equals(b)).toBe(false);
  }, 30_000);

  /**
   * 「折行點正確」最強的斷言：自動折出來的結果必須跟「在同一個位置手打 \n」
   * **逐位元組相同**。折錯一個字（或把空白留在行尾害置中偏移）就會不同。
   *
   * CJK 用得起這種精確斷言是因為全形字的 advance 恰好 = 1em：fontSize 64、
   * 可用寬 972（frac 0.9）→ 15 字 960px 放得下、16 字 1024px 放不下 → 每行 15 字。
   */
  it('CJK 逐字斷行：自動折 30 字 ≡ 手打 \\n 折在第 15 字（PNG 位元組相同）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-wrap-cjk-'));
    const chars = '一二三四五六七八九十壹貳參肆伍陸柒捌玖拾甲乙丙丁戊己庚辛壬癸';
    expect(chars).toHaveLength(30);
    const auto = await r.rasterize(
      { text: chars, style, width: 1080, maxWidthFrac: 0.9 },
      join(dir, 'auto.base.png'),
    );
    const manual = await r.rasterize(
      // frac 1 → 可用寬 1080，兩段各 15 字（960px）都不會再被折一次
      {
        text: `${chars.slice(0, 15)}\n${chars.slice(15)}`,
        style,
        width: 1080,
        maxWidthFrac: 1,
      },
      join(dir, 'manual.base.png'),
    );
    expect(auto.lines).toBe(2);
    expect(manual.lines).toBe(2);
    const [a, b] = await Promise.all([
      readFile(join(dir, 'auto.base.png')),
      readFile(join(dir, 'manual.base.png')),
    ]);
    expect(a.equals(b)).toBe(true);
  }, 30_000);

  /**
   * 拉丁在空白處斷、不從單字中間斷。同樣用「≡ 手打 \n」當斷言：
   * 若折進單字裡（例如 `xxxxxxxxxx y` / `yyyyyyyyy`），位元組必然不同。
   * 可用寬取 486px：10 個 x 約 310px 放得下，整串 21 字約 666px 放不下 → 必須折一次。
   */
  it('拉丁在空白處斷行、不切進單字中間（≡ 手打 \\n，PNG 位元組相同）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-wrap-latin-'));
    const auto = await r.rasterize(
      { text: 'xxxxxxxxxx yyyyyyyyyy', style, width: 1080, maxWidthFrac: 0.45 },
      join(dir, 'auto.base.png'),
    );
    const manual = await r.rasterize(
      { text: 'xxxxxxxxxx\nyyyyyyyyyy', style, width: 1080, maxWidthFrac: 1 },
      join(dir, 'manual.base.png'),
    );
    expect(auto.lines).toBe(2);
    expect(manual.lines).toBe(2);
    const [a, b] = await Promise.all([
      readFile(join(dir, 'auto.base.png')),
      readFile(join(dir, 'manual.base.png')),
    ]);
    expect(a.equals(b)).toBe(true);
  }, 30_000);

  /**
   * 換行邏輯不得吃掉任何非空白字元。這條擋的是一個真的踩到過的實作 bug：
   * 行首禁則字元（。，」…）本來無條件黏回「前一個原子」，而前一個原子若是空白，
   * 空白原子在行首整個會被丟掉——連黏上去的標點一起消失（`" 。"` 曾經排成空字串）。
   * 斷言用「≡ 沒有那個前導空白的版本」：行首空白本來就該被丟掉，所以兩者應該
   * 逐位元組相同；標點若被吞掉，這張卡會是全透明的，位元組立刻不同。
   */
  it('行首空白丟掉但不吃字：" 。" 與 "。" 的 PNG 位元組相同（不是空白卡）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-wrap-punct-'));
    await r.rasterize({ text: ' 。', style, width: 1080 }, join(dir, 'lead.base.png'));
    await r.rasterize({ text: '。', style, width: 1080 }, join(dir, 'bare.base.png'));
    const [lead, bare] = await Promise.all([
      readFile(join(dir, 'lead.base.png')),
      readFile(join(dir, 'bare.base.png')),
    ]);
    expect(lead.equals(bare)).toBe(true);
    // 判別性：這張卡真的畫了東西（否則「兩張都是空白卡」也會通過）
    const png = decodeRgba(bare);
    let ink = 0;
    for (let i = 3; i < png.data.length; i += 4) if (png.data[i]! > 0) ink++;
    expect(ink).toBeGreaterThan(0);
  }, 30_000);

  it('顯式 \\n 仍然強制換行（就算兩行都放得下同一行）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-wrap-nl-'));
    const geo = await r.rasterize(
      { text: 'A\nB', style, width: 1080, maxWidthFrac: 1 },
      join(dir, 'nl.base.png'),
    );
    expect(geo.lines).toBe(2);
    // 連續 \n 的空段落也照樣佔一行（舊行為，換行實作不得吃掉它）
    const blank = await r.rasterize(
      { text: 'A\n\nB', style, width: 1080, maxWidthFrac: 1 },
      join(dir, 'blank.base.png'),
    );
    expect(blank.lines).toBe(3);
  }, 30_000);

  /**
   * 單一「不可斷」原子比可用寬還長（超長英文網址、maxWidthFrac 調到極小）：
   * 決策是**逐字硬切**（等同 CSS break-word），不是讓它整條溢出被裁掉、也不是無窮迴圈。
   * 斷言用墨跡外框：硬切之後每一行都在可用寬之內，所以整張圖的墨跡寬 ≤ 可用寬。
   * 舊行為（不換行）在同一個輸入下墨跡會撐滿並超出 1080 被裁掉。
   */
  it('超長不可斷單字 → 逐字硬切，墨跡不超出可用寬（不是溢出被裁掉，也不會卡住）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-wrap-break-'));
    const width = 1080;
    const frac = 0.5;
    const geo = await r.rasterize(
      { text: 'x'.repeat(200), style, width, maxWidthFrac: frac },
      join(dir, 'b.base.png'),
    );
    expect(geo.lines).toBeGreaterThan(1);
    const png = decodeRgba(await readFile(join(dir, 'b.base.png')));
    let minX = png.width;
    let maxX = -1;
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        if (png.data[(y * png.width + x) * 4 + 3]! > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    expect(maxX).toBeGreaterThan(0); // 真的有畫東西
    // 可用寬 = width - margin*2（margin = round(width*(1-frac)/2)）；+2px 容差給反鋸齒
    const usable = width - cardMargin(width, frac) * 2;
    expect(maxX - minX + 1).toBeLessThanOrEqual(usable + 2);
  }, 30_000);
});

describe('PillowRasterizer 的存活性（worker 死掉不能拖垮整個編輯器）', () => {
  // 超時刻意設短：這組 bug 的症狀是「永遠 pending」，超時要快點炸出來而不是卡住整批測試。
  it('worker 被訊號殺死（SIGKILL，等同 OOM killer）後，之後的請求會重啟新 worker 並成功', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-ras-kill-'));
    const rk = new PillowRasterizer(() => undefined);
    try {
      await rk.rasterize(CARD('第一張'), join(dir, 'a.base.png'));
      const dead = childOf(rk);
      const deadPid = dead.pid;
      dead.kill('SIGKILL');
      await new Promise<void>((res) => dead.once('exit', () => res()));
      // 這兩行就是 bug 的根：被訊號殺死時 exitCode 永遠是 null，
      // 用 `exitCode === null` 當存活判斷會把屍體當活人。
      expect(dead.exitCode).toBeNull();
      expect(dead.signalCode).toBe('SIGKILL');

      // 佇列不能被卡住：字卡與 probeFont（字型表路徑）都要在時限內 settle。
      const [g1, g2, ok] = await Promise.all([
        rk.rasterize(CARD('復活一'), join(dir, 'b.base.png')),
        rk.rasterize(CARD('復活二'), join(dir, 'c.base.png')),
        rk.probeFont('/System/Library/Fonts/STHeiti Medium.ttc'),
      ]);
      // 註:這裡的 `width === 1080` 不具鑑別力(rasterizer.ts 把請求的 width 原封抄回
      // 回覆),它們的作用只是「這個 promise 真的 resolve 了」——本測試要抓的失敗模式
      // 是永遠 pending / reject,不是幾何算錯。真正有內容的斷言是下面的檔案大小與 pid。
      expect(g1.width).toBe(1080);
      expect(g2.width).toBe(1080);
      expect(ok).toBe(true);
      expect((await stat(join(dir, 'b.base.png'))).size).toBeGreaterThan(0);
      expect(childOf(rk).pid).not.toBe(deadPid); // 真的換了一個新 worker
    } finally {
      rk.dispose();
    }
  }, 15_000);

  it('worker 在請求進行中死掉 → 該請求 reject（不是永遠 pending），下一個請求仍成功', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-ras-inflight-'));
    const rk = new PillowRasterizer(() => undefined);
    try {
      await rk.rasterize(CARD('暖機'), join(dir, 'w.base.png'));
      const dead = childOf(rk);
      const inflight = rk.rasterize(CARD('進行中'), join(dir, 'x.base.png'));
      dead.kill('SIGKILL'); // 排隊中的 run() 還沒跑，它會拿到這具正在斷氣的 child
      await expect(inflight).rejects.toThrow(/rasterizer/);
      // 「resolve 了」本身就是斷言(失敗的請求不能讓 rasterizer 永久壞掉);width 只是
      // 順手看一眼回覆結構完整,它等於 1080 是因為 rasterizer 把請求的 width 抄回來,
      // 不具鑑別力。真正的證據是圖有落盤。
      const geo = await rk.rasterize(CARD('之後'), join(dir, 'y.base.png'));
      expect(geo.width).toBe(1080);
      expect((await stat(join(dir, 'y.base.png'))).size).toBeGreaterThan(0);
    } finally {
      rk.dispose();
    }
  }, 15_000);

  it('worker 的 stderr 有被抽掉（沒人讀 → pipe 緩衝滿了 python 就卡在 write，回覆永遠出不來）', async () => {
    const rk = new PillowRasterizer(() => undefined);
    try {
      await rk.probeFont('/nonexistent.ttf'); // 起 worker
      // 白箱斷言：stderr 必須處於 flowing 模式。實測 64KB 的 stderr 就足以讓 worker 永久卡住。
      expect(childOf(rk).stderr?.listenerCount('data') ?? 0).toBeGreaterThan(0);
    } finally {
      rk.dispose();
    }
  }, 15_000);

  // 這組修正整批存在的理由就是消滅「請求永遠 pending → queue 串在它後面 → 整個 rasterizer
  // 永久死掉」。teardown() 若先 removeAllListeners() 再 kill()，in-flight 請求唯一的醒來路徑
  // 會在 kill 之前就被拔掉，dispose() 等於把那個 wedge 原封不動裝回來。
  it('dispose() 撞上「已送出、正在等回覆」的請求 → 該請求 reject（不是永遠 pending）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-ras-dispose-'));
    const rk = new PillowRasterizer(() => undefined);
    await rk.rasterize(CARD('暖機'), join(dir, 'w.base.png')); // 確保 worker 已在跑
    const inflight = rk.rasterize(CARD('進行中'), join(dir, 'i.base.png'));
    // 等到 run() 真的把 payload 寫出去、正在等 worker 那一行回覆的瞬間才 dispose
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    rk.dispose();
    // 超時設短：症狀是「永遠不 settle」，卡住比失敗更難查，要讓它快點炸出來。
    await expect(inflight).rejects.toThrow(/disposed|rasterizer/);
    rk.dispose();
  }, 15_000);

  it('dispose() 之後 rasterizer 沒有壞掉：新的請求會重開 worker 並成功', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-ras-dispose2-'));
    const rk = new PillowRasterizer(() => undefined);
    try {
      await rk.rasterize(CARD('暖機'), join(dir, 'w.base.png'));
      const inflight = rk.rasterize(CARD('進行中'), join(dir, 'i.base.png'));
      await new Promise((res) => setImmediate(res));
      await new Promise((res) => setImmediate(res));
      rk.dispose();
      await expect(inflight).rejects.toThrow();
      // queue 串在上一個 promise 後面：上一個若沒 settle，這一個永遠不會開始。
      // 同上:這條測的是「還會不會動」,`geo.width` 只是回覆結構的煙霧測試,
      // 有內容的斷言是圖真的落盤了。
      const geo = await rk.rasterize(CARD('之後'), join(dir, 'a.base.png'));
      expect(geo.width).toBe(1080);
      expect((await stat(join(dir, 'a.base.png'))).size).toBeGreaterThan(0);
    } finally {
      rk.dispose();
    }
  }, 20_000);

  it('spawn 失敗（PATH 上沒有 python3）→ 請求 reject，不是 uncaughtException 也不是卡住', async () => {
    const prevPath = process.env.PATH;
    process.env.PATH = '/nonexistent-bin-for-vidcut-test';
    const rk = new PillowRasterizer(() => undefined);
    try {
      // spawn ENOENT 是 EventEmitter 的 'error' 事件；沒有 listener 就是 uncaughtException，
      // 整個 server 會在 index.ts 的 loadFontTable（listen 之前）就死掉。
      await expect(rk.probeFont('/System/Library/Fonts/STHeiti Medium.ttc')).rejects.toThrow(
        /ENOENT/,
      );
    } finally {
      process.env.PATH = prevPath;
      rk.dispose();
    }
  }, 15_000);
});
