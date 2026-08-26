import { describe, it, expect } from 'vitest';
import { CANVAS_PRESETS, findCanvasPreset } from './canvasPresets.js';

describe('CANVAS_PRESETS', () => {
  it('portrait 是陣列第一筆,且為 1080x1920(現狀行為的錨點/預設值)', () => {
    expect(CANVAS_PRESETS[0]).toEqual({
      id: 'portrait',
      width: 1080,
      height: 1920,
      label: 'Portrait 9:16',
    });
  });

  it('四檔 preset 的 width/height 都是偶數——h264 不接受奇數尺寸,奇數會在 render 時炸掉', () => {
    for (const p of CANVAS_PRESETS) {
      expect(p.width % 2, `${p.id} width 應為偶數`).toBe(0);
      expect(p.height % 2, `${p.id} height 應為偶數`).toBe(0);
    }
  });

  it('剛好四檔', () => {
    expect(CANVAS_PRESETS).toHaveLength(4);
  });
});

describe('findCanvasPreset', () => {
  it.each(CANVAS_PRESETS)('$id 用自己的 width/height 能反查回自己(往返)', (preset) => {
    expect(findCanvasPreset(preset.width, preset.height)).toEqual(preset);
  });

  it('非 preset 尺寸回傳 undefined', () => {
    expect(findCanvasPreset(999, 999)).toBeUndefined();
  });

  it('比尺寸不比名字——尺寸相符即命中,不需額外傳 id', () => {
    expect(findCanvasPreset(1920, 1080)?.id).toBe('landscape');
  });
});
