import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { PillowRasterizer, type CardRequest } from '../src/rasterizer.js';

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
    expect(geo.width).toBe(1080);
    expect(geo.height).toBeGreaterThan(60);
    expect(geo.tokens).toHaveLength(3);
    // bbox 單調遞增且在畫布內
    const t = geo.tokens!;
    expect(t[1]!.x).toBeGreaterThan(t[0]!.x);
    expect(t[2]!.x + t[2]!.w).toBeLessThanOrEqual(1080);
    // 兩張卡都存在且非空(幾何一致由同一次排版保證)
    expect((await stat(join(dir, 'a.base.png'))).size).toBeGreaterThan(0);
    expect((await stat(join(dir, 'a.hl.png'))).size).toBeGreaterThan(0);
    // 兩卡尺寸相同(PNG IHDR 寬高 bytes 16-24 相同)
    const [b, h] = await Promise.all([
      readFile(join(dir, 'a.base.png')),
      readFile(join(dir, 'a.hl.png')),
    ]);
    expect(b.subarray(16, 24)).toEqual(h.subarray(16, 24));
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

  it('serializes concurrent requests through one worker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-ras-'));
    const reqs = Array.from({ length: 5 }, (_, i) =>
      r.rasterize(
        { text: `並發${i}`, style: { fontFamily: 'x', fontSize: 40, fill: '#fff' }, width: 1080 },
        join(dir, `c${i}.base.png`),
      ),
    );
    const geos = await Promise.all(reqs);
    for (const g of geos) expect(g.width).toBe(1080);
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
      const geo = await rk.rasterize(CARD('之後'), join(dir, 'y.base.png'));
      expect(geo.width).toBe(1080); // 失敗的請求不能讓 rasterizer 永久壞掉
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
