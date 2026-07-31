import { describe, it, expect } from 'vitest';
import { resolvePanelDrag, PANEL } from './panelResize.js';

describe('resolvePanelDrag', () => {
  it('keeps width inside [min, max]', () => {
    expect(resolvePanelDrag('left', 9999)).toEqual({ open: true, width: PANEL.left.max });
    expect(resolvePanelDrag('right', 9999)).toEqual({ open: true, width: PANEL.right.max });
    // min 與收合門檻之間 → 夾到 min（還不到收合）
    expect(resolvePanelDrag('left', 150)).toEqual({ open: true, width: PANEL.left.min });
    expect(resolvePanelDrag('right', 150)).toEqual({ open: true, width: PANEL.right.min });
  });

  it('passes through widths in the normal range', () => {
    expect(resolvePanelDrag('left', 300)).toEqual({ open: true, width: 300 });
    expect(resolvePanelDrag('right', 400)).toEqual({ open: true, width: 400 });
  });

  it('collapses below the threshold without touching width', () => {
    expect(resolvePanelDrag('left', 139)).toEqual({ open: false });
    expect(resolvePanelDrag('right', 20)).toEqual({ open: false });
    expect(resolvePanelDrag('left', -50)).toEqual({ open: false });
  });

  it('rounds fractional pixels', () => {
    expect(resolvePanelDrag('left', 300.6)).toEqual({ open: true, width: 301 });
  });
});
