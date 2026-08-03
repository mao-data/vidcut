import { describe, it, expect } from 'vitest';
import { syncAction } from './sync.js';

describe('syncAction（spec B1）', () => {
  it('大漂移（≥0.25s）→ seek，含邊界值與負向', () => {
    expect(syncAction(0.25)).toEqual({ kind: 'seek' });
    expect(syncAction(-0.4)).toEqual({ kind: 'seek' });
    expect(syncAction(1.5)).toEqual({ kind: 'seek' });
  });

  it('死區（|drift| ≤ 0.02）→ 復速 rate 1，含邊界值', () => {
    expect(syncAction(0)).toEqual({ kind: 'rate', rate: 1 });
    expect(syncAction(0.02)).toEqual({ kind: 'rate', rate: 1 });
    expect(syncAction(-0.015)).toEqual({ kind: 'rate', rate: 1 });
  });

  it('落後（drift > 0）→ 加速：比例 0.5', () => {
    expect(syncAction(0.1)).toEqual({ kind: 'rate', rate: 1.05 });
    expect(syncAction(0.06)).toEqual({ kind: 'rate', rate: 1.03 });
  });

  it('超前（drift < 0）→ 減速', () => {
    expect(syncAction(-0.1)).toEqual({ kind: 'rate', rate: 0.95 });
  });

  it('調速上限 ±8%（0.16s < |drift| < 0.25s 撞 clamp）', () => {
    expect(syncAction(0.2)).toEqual({ kind: 'rate', rate: 1.08 });
    expect(syncAction(-0.2)).toEqual({ kind: 'rate', rate: 0.92 });
  });
});
