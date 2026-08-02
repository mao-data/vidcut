import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useEditFx } from './editFx.js';

const fx = (over: Partial<{ touched: string[]; added: string[]; minStart: number | null }> = {}) => ({
  touched: [],
  added: [],
  minStart: null,
  ...over,
});

describe('editFx store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useEditFx.getState().clear();
  });
  afterEach(() => vi.useRealTimers());

  it('trigger opens the window, bumps the stamp, and exposes ids', () => {
    useEditFx.getState().trigger(fx({ touched: ['a'], added: ['b', 'c'] }));
    const s = useEditFx.getState();
    expect(s.window).toBe(true);
    expect(s.stamp).toBe(1);
    expect(s.touched.has('a')).toBe(true);
    expect(s.added.get('b')).toBe(0);
    expect(s.added.get('c')).toBe(1); // 進場序 = stagger 索引
  });

  it('auto-clears 1.6s after the last trigger', () => {
    useEditFx.getState().trigger(fx({ touched: ['a'] }));
    vi.advanceTimersByTime(1500);
    expect(useEditFx.getState().window).toBe(true);
    vi.advanceTimersByTime(200);
    const s = useEditFx.getState();
    expect(s.window).toBe(false);
    expect(s.touched.size).toBe(0);
    expect(s.added.size).toBe(0);
  });

  it('a second trigger inside the window merges ids and resets the timer', () => {
    useEditFx.getState().trigger(fx({ touched: ['a'] }));
    vi.advanceTimersByTime(1000);
    useEditFx.getState().trigger(fx({ touched: ['b'], added: ['n'] }));
    vi.advanceTimersByTime(1000); // 距第一次 2s、距第二次 1s → 窗仍開
    const s = useEditFx.getState();
    expect(s.window).toBe(true);
    expect(s.touched.has('a')).toBe(true);
    expect(s.touched.has('b')).toBe(true);
    expect(s.stamp).toBe(2);
    vi.advanceTimersByTime(700);
    expect(useEditFx.getState().window).toBe(false);
  });

  it('consumeScroll returns minStart once, then null', () => {
    useEditFx.getState().trigger(fx({ touched: ['a'], minStart: 12.5 }));
    expect(useEditFx.getState().consumeScroll()).toBe(12.5);
    expect(useEditFx.getState().consumeScroll()).toBeNull();
  });

  it('an empty fx (nothing to animate) does not open the window', () => {
    useEditFx.getState().trigger(fx());
    expect(useEditFx.getState().window).toBe(false);
    expect(useEditFx.getState().stamp).toBe(0);
  });
});
