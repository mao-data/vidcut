import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderCaptionCard, setCaptionFontResolver } from '../src/render.js';
import { PillowRasterizer } from '../src/rasterizer.js';
import { loadFontTable, fontResolver } from '../src/fonts.js';
import { DEFAULT_CAPTION_STYLE } from '@vidcut/shared';

afterEach(() => setCaptionFontResolver(() => undefined)); // 測試間不互相污染

const cap = { id: 'c1', text: '字型測試', start: 0, duration: 1, style: DEFAULT_CAPTION_STYLE };

describe('匯出字卡的字型解析', () => {
  it('注入 resolver 後,匯出字卡與預覽字卡走同一個字型檔(視覺輸出一致)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-rf-'));
    await mkdir(join(dir, 'derived', 'captions'), { recursive: true });
    const raster = new PillowRasterizer(() => undefined);
    try {
      const table = await loadFontTable(raster);
      const resolve = fontResolver(table);
      raster.resolveFontPath = resolve;
      setCaptionFontResolver(resolve);

      // 匯出路徑產一張
      const rel = await renderCaptionCard(dir, cap, 1080);
      // 預覽路徑產一張(同文字/同樣式/同寬)
      const previewPath = join(dir, 'preview.png');
      await raster.rasterize(
        {
          text: cap.text,
          style: {
            fontFamily: cap.style.fontFamily,
            fontSize: cap.style.fontSize,
            fill: cap.style.fill,
            stroke: cap.style.stroke,
          },
          width: 1080,
        },
        previewPath,
      );
      // 同字型 → 同排版 → PNG 尺寸(IHDR 寬高)必相同
      const [exp, prev] = await Promise.all([
        readFile(join(dir, rel)),
        readFile(previewPath),
      ]);
      expect(exp.subarray(16, 24)).toEqual(prev.subarray(16, 24));
    } finally {
      raster.dispose();
    }
  }, 30_000);

  it('未注入 resolver 時仍可產卡(舊行為不壞)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-rf-'));
    await mkdir(join(dir, 'derived', 'captions'), { recursive: true });
    const rel = await renderCaptionCard(dir, cap, 1080);
    expect(rel).toContain('derived/captions');
  }, 30_000);
});
