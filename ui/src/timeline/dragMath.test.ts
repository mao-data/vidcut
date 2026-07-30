import { describe, it, expect } from 'vitest';
import { trimIn, trimOut, reorderByDrag, layoutByOrder, MIN_CLIP_DURATION } from './dragMath.js';

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

describe('layoutByOrder', () => {
  const clips = [
    { id: 'a', duration: 2 },
    { id: 'b', duration: 3 },
    { id: 'c', duration: 1 },
  ];

  it('lays out in array order when no reorder is pending', () => {
    const m = layoutByOrder(clips, null, 10);
    expect([...m]).toEqual([
      ['a', 0],
      ['b', 20],
      ['c', 50],
    ]);
  });

  it('shifts the others aside for the pending order (this is the 讓位 animation target)', () => {
    // 把 c 拖到最前面：c 佔 0，a 被推到 10，b 被推到 30
    const m = layoutByOrder(clips, ['c', 'a', 'b'], 10);
    expect(m.get('c')).toBe(0);
    expect(m.get('a')).toBe(10);
    expect(m.get('b')).toBe(30);
  });

  it('ignores ids that no longer exist', () => {
    const m = layoutByOrder(clips, ['zz', 'a', 'b', 'c'], 10);
    expect(m.get('a')).toBe(0);
    expect(m.size).toBe(3);
  });
});
