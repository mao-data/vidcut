import { describe, it, expect } from 'vitest';
import { trimIn, trimOut, reorderByDrag, MIN_CLIP_DURATION } from './dragMath.js';

describe('trimIn', () => {
  const clip = { in: 5, duration: 6 }; // 右界 = 11

  it('moving in right shrinks duration, keeps right edge', () => {
    expect(trimIn(clip, 2)).toEqual({ in: 7, duration: 4 });
  });

  it('moving in left grows duration', () => {
    expect(trimIn(clip, -3)).toEqual({ in: 2, duration: 9 });
  });

  it('clamps in to >= 0', () => {
    expect(trimIn(clip, -10)).toEqual({ in: 0, duration: 11 });
  });

  it('clamps so duration never below MIN', () => {
    const r = trimIn(clip, 100);
    expect(r.duration).toBeCloseTo(MIN_CLIP_DURATION);
    expect(r.in).toBeCloseTo(11 - MIN_CLIP_DURATION);
  });
});

describe('trimOut', () => {
  const clip = { in: 5, duration: 6 };

  it('extends duration up to media length', () => {
    expect(trimOut(clip, 2, 20)).toEqual({ duration: 8 });
  });

  it('clamps duration to media boundary (in+duration <= mediaDuration)', () => {
    expect(trimOut(clip, 100, 20)).toEqual({ duration: 15 }); // 5+15=20
  });

  it('clamps to MIN', () => {
    expect(trimOut(clip, -100, 20).duration).toBeCloseTo(MIN_CLIP_DURATION);
  });
});

describe('reorderByDrag', () => {
  const layout = [
    { id: 'a', left: 0, width: 100 },
    { id: 'b', left: 100, width: 100 },
    { id: 'c', left: 200, width: 100 },
  ];

  it('drops before b when pointer left of b center', () => {
    // dragging 'c', pointer at 120 (< b center 150) → c goes before b
    expect(reorderByDrag(['a', 'b', 'c'], 'c', 120, layout)).toEqual(['a', 'c', 'b']);
  });

  it('drops at end when pointer past everything', () => {
    expect(reorderByDrag(['a', 'b', 'c'], 'a', 999, layout)).toEqual(['b', 'c', 'a']);
  });

  it('drops at start when pointer before first center', () => {
    expect(reorderByDrag(['a', 'b', 'c'], 'c', 10, layout)).toEqual(['c', 'a', 'b']);
  });
});
