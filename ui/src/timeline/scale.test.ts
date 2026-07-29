import { describe, it, expect } from 'vitest';
import { timeToPx, pxToTime, PX_PER_SECOND } from './scale.js';

describe('timeline scale', () => {
  it('round-trips', () => {
    expect(timeToPx(2.5)).toBe(2.5 * PX_PER_SECOND);
    expect(pxToTime(timeToPx(7.3))).toBeCloseTo(7.3);
  });
});
