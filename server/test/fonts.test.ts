import { describe, it, expect, afterAll } from 'vitest';
import { loadFontTable, fontResolver } from '../src/fonts.js';
import { PillowRasterizer } from '../src/rasterizer.js';

const r = new PillowRasterizer(() => undefined);
afterAll(() => r.dispose());

describe('font table', () => {
  it('probes candidates and keeps only loadable fonts', async () => {
    const table = await loadFontTable(r);
    expect(table.length).toBeGreaterThan(0);
    // 這台機器 PingFang.ttc 開不了(HANDOFF 記錄)——不得出現在表裡
    expect(table.some((f) => f.path.includes('PingFang'))).toBe(false);
    expect(table.some((f) => f.path.includes('STHeiti'))).toBe(true);
  }, 30_000);

  it('resolver: 完全比對命中,未知 family 落到表首位', async () => {
    const table = await loadFontTable(r);
    const resolve = fontResolver(table);
    expect(resolve(table[0]!.family)).toBe(table[0]!.path);
    expect(resolve('沒有這個字型')).toBe(table[0]!.path);
    expect(fontResolver([])('x')).toBeUndefined();
  }, 30_000);
});
