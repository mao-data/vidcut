import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { PillowRasterizer, type CardRequest } from '../src/rasterizer.js';

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
