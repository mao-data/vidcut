import { describe, it, expect } from 'vitest';
import { snapBBox } from './snap.js';

const CANVAS = { w: 1080, h: 1920 };

describe('snapBBox', () => {
  it('bbox 中心接近畫布水平中心 → 吸附並回 x 導線', () => {
    // bbox 寬 200,中心在 550(離 540 差 10 < 16)
    const r = snapBBox({ x: 450, y: 100, w: 200, h: 80 }, CANVAS);
    expect(r.x).toBe(440); // 中心對齊 540
    expect(r.guides).toContainEqual({ axis: 'x', pos: 540 });
  });
  it('超出閾值不動、無導線', () => {
    // x 中心 400,離水平中心 540 差 140(> 閾值);y=500,bbox 中心 540、離三個
    // 垂直候選(中心 960、上緣 96、下緣 1824)都遠超閾值——雙軸都不該吸附
    const r = snapBBox({ x: 300, y: 500, w: 200, h: 80 }, CANVAS);
    expect(r.x).toBe(300);
    expect(r.guides).toHaveLength(0);
  });
  it('上緣接近安全邊距(96)→ 吸 y', () => {
    const r = snapBBox({ x: 0, y: 90, w: 100, h: 100 }, CANVAS);
    expect(r.y).toBe(96);
    expect(r.guides).toContainEqual({ axis: 'y', pos: 96 });
  });
  it('下緣接近 95% 線(1824)→ 吸 y(以下緣對齊)', () => {
    const r = snapBBox({ x: 0, y: 1730, w: 100, h: 100 }, CANVAS);
    expect(r.y).toBe(1724);
  });
  it('垂直中心吸附', () => {
    const r = snapBBox({ x: 0, y: 915, w: 100, h: 100 }, CANVAS); // 中心 965,離 960 差 5
    expect(r.y).toBe(910);
    expect(r.guides).toContainEqual({ axis: 'y', pos: 960 });
  });
});
