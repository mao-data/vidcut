import { describe, it, expect } from 'vitest';
import {
  timeToPx,
  pxToTime,
  clampPps,
  snapTime,
  fitPps,
  DEFAULT_PX_PER_SECOND,
  MIN_PX_PER_SECOND,
  MAX_PX_PER_SECOND,
} from './scale.js';

describe('timeline scale', () => {
  it('round-trips at any zoom', () => {
    expect(timeToPx(2.5, 60)).toBe(150);
    expect(pxToTime(timeToPx(7.3, 137), 137)).toBeCloseTo(7.3);
  });

  it('clamps zoom into range', () => {
    expect(clampPps(1)).toBe(MIN_PX_PER_SECOND);
    expect(clampPps(9999)).toBe(MAX_PX_PER_SECOND);
    expect(clampPps(60)).toBe(60);
  });
});

describe('snapTime', () => {
  const candidates = [0, 4, 8, 12];

  it('snaps when within the pixel threshold', () => {
    // pps=60 → 8px = 0.133s
    expect(snapTime(4.05, candidates, 60)).toBe(4);
    expect(snapTime(7.95, candidates, 60)).toBe(8);
  });

  it('leaves the value alone when too far', () => {
    expect(snapTime(4.5, candidates, 60)).toBe(4.5);
  });

  it('threshold scales with zoom (zoomed in = finer snapping)', () => {
    // pps=400 → 8px = 0.02s，0.05s 的距離就不該吸附
    expect(snapTime(4.05, candidates, 400)).toBe(4.05);
    expect(snapTime(4.01, candidates, 400)).toBe(4);
  });

  it('picks the nearest candidate', () => {
    expect(snapTime(4.06, [4, 4.1], 60)).toBe(4.1);
  });
});

describe('fitPps', () => {
  it('fits the whole timeline into the container', () => {
    expect(fitPps(10, 640, 40)).toBe(60); // (640-40)/10
  });

  it('falls back to default for an empty timeline and clamps extremes', () => {
    expect(fitPps(0, 800)).toBe(DEFAULT_PX_PER_SECOND);
    expect(fitPps(10_000, 800)).toBe(MIN_PX_PER_SECOND);
  });
});
