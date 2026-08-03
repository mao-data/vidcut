import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardKey, TextCardService } from '../src/textCards.js';
import { PillowRasterizer, type CardRequest } from '../src/rasterizer.js';

const raster = new PillowRasterizer(() => undefined);
afterAll(() => raster.dispose());

const REQ: CardRequest = {
  text: '哈囉世界',
  tokens: ['哈囉', '世界'],
  style: { fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff', stroke: '#000000', highlight: '#FCDE5A' },
  width: 1080,
};

describe('cardKey', () => {
  it('same input → same key; 與時間無關的欄位不影響 key', () => {
    expect(cardKey(REQ, 'pillow-1')).toBe(cardKey({ ...REQ }, 'pillow-1'));
  });
  it('改字必變;換 rasterizerId 必變', () => {
    expect(cardKey({ ...REQ, text: '改了' }, 'pillow-1')).not.toBe(cardKey(REQ, 'pillow-1'));
    expect(cardKey(REQ, 'chromium-1')).not.toBe(cardKey(REQ, 'pillow-1'));
  });
});

describe('TextCardService', () => {
  it('ensure 產卡落盤;第二次命中快取(檔案 mtime 不變)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-tcs-'));
    const svc = new TextCardService(dir, raster);
    const a = await svc.ensure(REQ);
    expect(a.tokens).toHaveLength(2);
    const baseAbs = join(dir, svc.relBasePath(a.hash));
    const m1 = (await stat(baseAbs)).mtimeMs;
    const b = await svc.ensure(REQ);
    expect(b.hash).toBe(a.hash);
    expect((await stat(baseAbs)).mtimeMs).toBe(m1); // 沒重畫
  }, 30_000);
});
