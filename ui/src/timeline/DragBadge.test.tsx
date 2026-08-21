import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { DragBadge, formatDragBadge } from './DragBadge.js';

describe('formatDragBadge（純函數：內容格式）', () => {
  it('trim：時長 (帶號增減)，秒數 <60s 用一位小數', () => {
    // 3.2s，delta -0.8s（見裁決 2 範例）
    expect(formatDragBadge({ kind: 'trim', duration: 3.2, delta: -0.8 })).toBe('3.2s (−0.8s)');
  });

  it('trim：正向增量帶正號', () => {
    expect(formatDragBadge({ kind: 'trim', duration: 5, delta: 1.5 })).toBe('5.0s (+1.5s)');
  });

  it('trim：零增量仍帶正號（與正向同格式，不特判 0）', () => {
    expect(formatDragBadge({ kind: 'trim', duration: 4, delta: 0 })).toBe('4.0s (+0.0s)');
  });

  it('trim：時長 >=60s 改用 m:ss（delta 仍用秒數 <60s 一位小數，delta 本身不是絕對時長）', () => {
    expect(formatDragBadge({ kind: 'trim', duration: 65, delta: 5 })).toBe('1:05 (+5.0s)');
  });

  it('trim：delta 也可能 >=60（極端拖曳），一樣走秒數顯示（規格只講 duration 的 m:ss 門檻）', () => {
    expect(formatDragBadge({ kind: 'trim', duration: 3, delta: -65 })).toBe('3.0s (−65.0s)');
  });

  it('move：顯示項目起點時間，<60s 一位小數', () => {
    expect(formatDragBadge({ kind: 'move', start: 2.567 })).toBe('2.6s');
  });

  it('move：起點 >=60s 改用 m:ss', () => {
    expect(formatDragBadge({ kind: 'move', start: 125 })).toBe('2:05');
  });

  it('move：起點 0', () => {
    expect(formatDragBadge({ kind: 'move', start: 0 })).toBe('0.0s');
  });
});

describe('DragBadge（呈現層）', () => {
  it('沒有 drag 時不畫任何東西', () => {
    const { container } = render(<DragBadge drag={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('有 drag 時畫在指定座標附近，內容是格式化字串，pointer-events none', () => {
    const { container, getByText } = render(
      <DragBadge drag={{ leftPx: 120, topPx: 40, content: { kind: 'move', start: 2 } }} />,
    );
    const el = getByText('2.0s');
    expect(el).toBeTruthy();
    // pointer-events:none —— 不擋底下的拖曳互動
    expect(container.querySelector('[style*="pointer-events: none"]')).not.toBeNull();
  });

  it('不吃 CSS transition（拖曳中 1:1 跟手，既有紀律）', () => {
    const { container } = render(
      <DragBadge drag={{ leftPx: 0, topPx: 0, content: { kind: 'move', start: 0 } }} />,
    );
    const el = container.firstChild as HTMLElement;
    expect(el.style.transition).toBe('');
  });
});
