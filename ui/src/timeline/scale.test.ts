import { describe, it, expect } from 'vitest';
import {
  timeToPx,
  pxToTime,
  clampPps,
  snapTime,
  fitPps,
  zoomBoundsFor,
  tickStepFor,
  tickLabel,
  DEFAULT_PX_PER_SECOND,
  MIN_PX_PER_SECOND,
  MAX_PX_PER_SECOND,
} from './scale.js';

describe('timeline scale', () => {
  it('round-trips at any zoom', () => {
    expect(timeToPx(2.5, 60)).toBe(150);
    expect(pxToTime(timeToPx(7.3, 137), 137)).toBeCloseTo(7.3);
  });

  it('clamps zoom into range using default bounds', () => {
    expect(clampPps(1)).toBe(MIN_PX_PER_SECOND);
    expect(clampPps(9999)).toBe(MAX_PX_PER_SECOND);
    expect(clampPps(60)).toBe(60);
  });

  it('clamps zoom into caller-supplied bounds', () => {
    expect(clampPps(0.3, { min: 0.69, max: 120 })).toBeCloseTo(0.69);
    expect(clampPps(9999, { min: 0.69, max: 120 })).toBe(120);
    expect(clampPps(50, { min: 0.69, max: 120 })).toBe(50);
  });
});

describe('zoomBoundsFor', () => {
  it('long project: whole-project-fit becomes the floor (below the old MIN=5)', () => {
    const { min, max } = zoomBoundsFor(1687, 1200);
    expect(min).toBeCloseTo(0.6876111440426793, 5);
    expect(max).toBe(120);
  });

  it('short project: floor stays at 5 (fit would be far above 5)', () => {
    const { min, max } = zoomBoundsFor(10, 640);
    expect(min).toBe(5);
    expect(max).toBe(120);
  });

  it('empty project (totalSeconds=0): falls back to {min:5, max:120}, no divide-by-zero', () => {
    const { min, max } = zoomBoundsFor(0, 1200);
    expect(min).toBe(5);
    expect(max).toBe(120);
    expect(Number.isFinite(min)).toBe(true);
  });

  it('tiny viewport: min still finite and clamped sanely, never exceeds max', () => {
    const { min, max } = zoomBoundsFor(1687, 1);
    expect(Number.isFinite(min)).toBe(true);
    expect(min).toBeGreaterThan(0);
    expect(min).toBeLessThanOrEqual(max);
  });

  it('max is always 120 regardless of inputs', () => {
    expect(zoomBoundsFor(3, 400).max).toBe(120);
    expect(zoomBoundsFor(99999, 50).max).toBe(120);
  });
});

describe('tickStepFor (刻度表六檔門檻)', () => {
  it('pps>=40 → 1s', () => {
    expect(tickStepFor(40)).toBe(1);
    expect(tickStepFor(120)).toBe(1);
  });

  it('pps>=15 → 5s', () => {
    expect(tickStepFor(15)).toBe(5);
    expect(tickStepFor(39.9)).toBe(5);
  });

  it('pps>=5 → 10s', () => {
    expect(tickStepFor(5)).toBe(10);
    expect(tickStepFor(14.9)).toBe(10);
  });

  it('pps>=1.5 → 30s', () => {
    expect(tickStepFor(1.5)).toBe(30);
    expect(tickStepFor(4.9)).toBe(30);
  });

  it('pps>=0.5 → 60s', () => {
    expect(tickStepFor(0.5)).toBe(60);
    expect(tickStepFor(1.4)).toBe(60);
  });

  it('else → 300s', () => {
    expect(tickStepFor(0.49)).toBe(300);
    expect(tickStepFor(0.01)).toBe(300);
  });
});

describe('tickLabel (m:ss)', () => {
  it('renders sub-minute seconds as plain seconds', () => {
    expect(tickLabel(0)).toBe('0s');
    expect(tickLabel(45)).toBe('45s');
  });

  it('renders minute-and-above as m:ss', () => {
    expect(tickLabel(60)).toBe('1:00');
    expect(tickLabel(90)).toBe('1:30');
    expect(tickLabel(605)).toBe('10:05');
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
