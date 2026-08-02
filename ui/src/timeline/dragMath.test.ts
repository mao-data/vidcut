import { describe, it, expect } from 'vitest';
import {
  trimIn,
  trimOut,
  reorderByDrag,
  layoutByOrder,
  clampStart,
  trimSpanIn,
  trimSpanOut,
  trimAudioIn,
  MIN_CLIP_DURATION,
} from './dragMath.js';

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

describe('clampStart', () => {
  it('moves by delta and clamps at 0', () => {
    expect(clampStart(7)).toBe(7);
    expect(clampStart(3)).toBe(3);
    expect(clampStart(-4)).toBe(0);
  });
});

describe('trimSpanIn (caption 左緣：右緣不動)', () => {
  const cap = { start: 4, duration: 3 }; // 右緣 = 7

  it('moving right shrinks duration, keeps right edge', () => {
    expect(trimSpanIn(cap, 1)).toEqual({ start: 5, duration: 2 });
  });

  it('moving left grows duration', () => {
    expect(trimSpanIn(cap, -2)).toEqual({ start: 2, duration: 5 });
  });

  it('clamps start at 0', () => {
    expect(trimSpanIn(cap, -10)).toEqual({ start: 0, duration: 7 });
  });

  it('never below MIN duration', () => {
    const r = trimSpanIn(cap, 100);
    expect(r.duration).toBeCloseTo(MIN_CLIP_DURATION);
    expect(r.start).toBeCloseTo(7 - MIN_CLIP_DURATION);
  });
});

describe('trimSpanOut (右緣：只改 duration)', () => {
  it('grows and shrinks with optional max', () => {
    expect(trimSpanOut({ duration: 3 }, 2)).toEqual({ duration: 5 });
    expect(trimSpanOut({ duration: 3 }, 2, 4)).toEqual({ duration: 4 });
    expect(trimSpanOut({ duration: 3 }, -100).duration).toBeCloseTo(MIN_CLIP_DURATION);
  });
});

describe('trimAudioIn (音訊左緣：start/in/duration 連動，右緣不動)', () => {
  const a = { start: 5, in: 2, duration: 4 }; // 時間軸右緣 9、來源右緣 6

  it('moving right advances start+in together', () => {
    expect(trimAudioIn(a, 1)).toEqual({ start: 6, in: 3, duration: 3 });
  });

  it('moving left is limited by in >= 0', () => {
    // delta -3 但 in 只剩 2 → 實際只能 -2
    expect(trimAudioIn(a, -3)).toEqual({ start: 3, in: 0, duration: 6 });
  });

  it('moving left is limited by start >= 0 too', () => {
    const b = { start: 1, in: 5, duration: 2 };
    expect(trimAudioIn(b, -3)).toEqual({ start: 0, in: 4, duration: 3 });
  });

  it('never below MIN duration', () => {
    const r = trimAudioIn(a, 100);
    expect(r.duration).toBeCloseTo(MIN_CLIP_DURATION);
    expect(r.start).toBeCloseTo(9 - MIN_CLIP_DURATION);
    expect(r.in).toBeCloseTo(6 - MIN_CLIP_DURATION);
  });
});
