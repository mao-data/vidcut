import { describe, it, expect } from 'vitest';
import { dragOverlay, dragCaption } from './dragLayer.js';

const CANVAS = { w: 1080, h: 1920 };

describe('dragOverlay', () => {
  it('位移換算 position；錨點不對稱正確（x 中心/y 上緣）', () => {
    // 起點 {0.5, 0.4}，bbox 400×100，拖 +108px/-192px
    const r = dragOverlay({ x: 0.5, y: 0.4 }, { dx: 108, dy: -192 }, { w: 400, h: 100 }, CANVAS);
    // 未觸發吸附時：x = 0.5+0.1 = 0.6, y = 0.4-0.1 = 0.3
    expect(r.position.x).toBeCloseTo(0.6);
    expect(r.position.y).toBeCloseTo(0.3);
  });
  it('拖近水平中心會吸回 0.5 並給導線', () => {
    const r = dragOverlay({ x: 0.5, y: 0.4 }, { dx: 10, dy: 0 }, { w: 400, h: 100 }, CANVAS);
    expect(r.position.x).toBeCloseTo(0.5);
    expect(r.guides.some((g) => g.axis === 'x')).toBe(true);
  });
});

describe('dragCaption', () => {
  it('y 位移換算 + 夾限', () => {
    expect(dragCaption(0.72, 192, 92, 1920).y).toBeCloseTo(0.82);
    expect(dragCaption(0.9, 500, 92, 1920).y).toBeLessThanOrEqual(1 - 92 / 1920);
    expect(dragCaption(0.1, -500, 92, 1920).y).toBeGreaterThanOrEqual(0);
  });
});
