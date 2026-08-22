import { describe, it, expect, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { TimelineToolbar } from './Toolbar.js';
import { usePlayback } from '../stores/playback.js';
import { resetStores, seedProject, demoProject } from '../test/fixtures.js';

/**
 * 工具列 current/total 讀數（Plan 13 Task 3，裁決 5c）：格式要與 DragBadge 的
 * `formatSeconds` 慣例一致——<60s 用一位小數的 `Ns`，>=60s 用 `m:ss`（見 DragBadge.tsx
 * 的 formatSeconds）。Timecode 元件本身在 Plan 13 之前就已經存在（只讀 usePlayback().time
 * 訂閱、獨立於 Timeline/Toolbar 其餘部分），這裡把它的格式改成與 DragBadge 一致，
 * 並改成直接讀 usePlayback().total（黑尾播完後 = outputDuration），不再依賴呼叫端傳入的
 * `total` prop（那個 prop 綁的是 Timeline.tsx 的主軌 totalDuration，Task 4 的 fit 基準，
 * 語意不同——見 task-3-brief 裁決 4/5c）。
 */
describe('TimelineToolbar readout（current/total，Plan 13 Task 3 裁決 5c）', () => {
  beforeEach(() => {
    resetStores();
    seedProject();
  });

  it('sub-minute: renders as `Ns` with one decimal, matching DragBadge formatSeconds', () => {
    seedProject(demoProject());
    act(() => usePlayback.getState().setTotal(10));
    act(() => usePlayback.getState().seek(3.14));
    const { container } = render(<TimelineToolbar total={10} onFit={() => {}} />);
    expect(container.textContent).toContain('3.1s');
    expect(container.textContent).toContain('10.0s');
  });

  it('>=60s: renders as m:ss (rounded to whole seconds), matching DragBadge formatSeconds', () => {
    act(() => usePlayback.getState().setTotal(125));
    act(() => usePlayback.getState().seek(65));
    const { container } = render(<TimelineToolbar total={125} onFit={() => {}} />);
    expect(container.textContent).toContain('1:05');
    expect(container.textContent).toContain('2:05');
  });

  it('reflects usePlayback().total, not the total prop — matters once total becomes outputDuration', () => {
    // total prop（Timeline.tsx 的主軌 totalDuration）與 usePlayback().total（Player 設定的
    // outputDuration）分岔時，讀數要跟 usePlayback().total，不是 prop——這正是黑尾情境。
    act(() => usePlayback.getState().setTotal(13)); // outputDuration（有黑尾）
    act(() => usePlayback.getState().seek(11));
    const { container } = render(<TimelineToolbar total={10} onFit={() => {}} />);
    expect(container.textContent).toContain('11.0s');
    expect(container.textContent).toContain('13.0s');
    expect(container.textContent).not.toContain('10.0s');
  });

  it('updates as playback time advances (tick)', () => {
    act(() => usePlayback.getState().setTotal(10));
    act(() => usePlayback.getState().seek(1));
    const { container } = render(<TimelineToolbar total={10} onFit={() => {}} />);
    expect(container.textContent).toContain('1.0s');

    act(() => usePlayback.getState().tick(1, 2)); // → time=3
    expect(container.textContent).toContain('3.0s');
  });
});
