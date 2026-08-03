import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PillowRasterizer } from '../src/rasterizer.js';

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
