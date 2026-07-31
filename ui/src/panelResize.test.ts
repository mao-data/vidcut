import { describe, it, expect } from 'vitest';
import { resolvePanelDrag, PANEL } from './panelResize.js';

describe('resolvePanelDrag', () => {
  it('clamps to [min, max]', () => {
    expect(resolvePanelDrag('left', 9999)).toBe(PANEL.left.max);
    expect(resolvePanelDrag('right', 9999)).toBe(PANEL.right.max);
    expect(resolvePanelDrag('left', 150)).toBe(PANEL.left.min);
    expect(resolvePanelDrag('right', 150)).toBe(PANEL.right.min);
  });

  it('never collapses — even dragged to zero it stays at min', () => {
    expect(resolvePanelDrag('left', 0)).toBe(PANEL.left.min);
    expect(resolvePanelDrag('right', -50)).toBe(PANEL.right.min);
  });

  it('passes through widths in the normal range (rounded)', () => {
    expect(resolvePanelDrag('left', 300)).toBe(300);
    expect(resolvePanelDrag('right', 400.6)).toBe(401);
  });
});
