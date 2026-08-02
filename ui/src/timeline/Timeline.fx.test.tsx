import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { Timeline } from './Timeline.js';
import { useEditFx } from '../stores/editFx.js';
import { useView } from '../stores/view.js';
import * as ws from '../ws.js';
import { seedProject, resetStores } from '../test/fixtures.js';
import { scrollTargetFor } from '../fx/scroll.js';

function chip(c: HTMLElement, text: string): HTMLElement {
  const hits = Array.from(c.querySelectorAll('div')).filter((d) =>
    d.textContent?.trim().startsWith(text),
  );
  const el = hits.find((d) => !hits.some((o) => o !== d && d.contains(o)));
  if (!el) throw new Error(`chip not found: ${text}`);
  return el;
}

const fire = (over: Partial<{ touched: string[]; added: string[]; minStart: number | null }>) =>
  act(() => {
    useEditFx.getState().trigger({ touched: [], added: [], minStart: null, ...over });
  });

describe('Timeline AI edit fx', () => {
  beforeEach(() => {
    resetStores();
    useView.setState({ pxPerSecond: 40, snapEnabled: false });
    seedProject();
    vi.spyOn(ws, 'sendCommand').mockImplementation(() => {});
  });
  afterEach(() => {
    act(() => useEditFx.getState().clear());
    vi.restoreAllMocks();
  });

  it('marks all four track containers ai-anim while the fx window is open', () => {
    const { container } = render(<Timeline />);
    expect(container.querySelectorAll('.ai-anim')).toHaveLength(0);
    fire({ touched: ['cap1'] });
    expect(container.querySelectorAll('.ai-anim').length).toBeGreaterThanOrEqual(4);
  });

  it('gives a touched chip the glow class, alternating with the stamp', () => {
    const { container } = render(<Timeline />);
    fire({ touched: ['cap1'] });
    const first = chip(container, 'first line').className;
    expect(first).toMatch(/fx-glow-(a|b)/);

    fire({ touched: ['cap1'] }); // 第二發 → 交替，動畫可重播
    const second = chip(container, 'first line').className;
    expect(second).toMatch(/fx-glow-(a|b)/);
    expect(second).not.toBe(first);
  });

  it('gives added chips the entrance class with a 40ms stagger', () => {
    const { container } = render(<Timeline />);
    fire({ added: ['cap1', 'cap2'] });
    const c1 = chip(container, 'first line');
    const c2 = chip(container, 'second line');
    expect(c1.className).toContain('fx-enter');
    expect(c2.className).toContain('fx-enter');
    expect(c1.style.animationDelay).toBe('0ms');
    expect(c2.style.animationDelay).toBe('40ms');
  });

  it('suppresses ai-anim while a human drag is in progress (1:1 tracking is sacred)', () => {
    const { container } = render(<Timeline />);
    const target = chip(container, 'first line');
    act(() => {
      fireEvent.pointerDown(target, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(target, { clientX: 120, pointerId: 1, bubbles: true });
    });
    fire({ touched: ['cap2'] });
    expect(container.querySelectorAll('.ai-anim')).toHaveLength(0);

    act(() => {
      fireEvent.pointerUp(target, { clientX: 120, pointerId: 1, bubbles: true });
    });
    expect(container.querySelectorAll('.ai-anim').length).toBeGreaterThanOrEqual(4);
  });

  it('glow applies to clips and audio chips too', () => {
    const { container } = render(<Timeline />);
    fire({ touched: ['c1', 'a1'] });
    expect(chip(container, 'clip one').className).toMatch(/fx-glow/);
    expect(chip(container, 'bgm').className).toMatch(/fx-glow/);
  });
});

describe('scrollTargetFor', () => {
  it('returns null when the target is already visible', () => {
    expect(scrollTargetFor(500, 400, 800)).toBeNull();
  });
  it('scrolls so the target sits at one third of the viewport', () => {
    expect(scrollTargetFor(2000, 0, 900)).toBe(1700);
  });
  it('clamps at zero for targets near the start', () => {
    expect(scrollTargetFor(100, 2000, 900)).toBe(0);
  });
  it('returns null when the viewport cannot be measured', () => {
    expect(scrollTargetFor(2000, 0, 0)).toBeNull();
  });
});
