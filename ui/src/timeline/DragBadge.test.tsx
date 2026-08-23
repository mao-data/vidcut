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

describe('formatDragBadge：來源上限 max 標記（Plan 11 Task 3 裁決 5）', () => {
  it('trim + atMax：附加 " · max"（choice documented in task-3-report）', () => {
    expect(formatDragBadge({ kind: 'trim', duration: 8, delta: 2, atMax: true })).toBe(
      '8.0s (+2.0s) · max',
    );
  });

  it('trim 不帶 atMax（省略）：格式不變，沒有 max 字樣', () => {
    expect(formatDragBadge({ kind: 'trim', duration: 8, delta: 2 })).toBe('8.0s (+2.0s)');
  });

  it('trim + atMax:false：等同不帶，沒有 max 字樣', () => {
    expect(formatDragBadge({ kind: 'trim', duration: 8, delta: 2, atMax: false })).toBe(
      '8.0s (+2.0s)',
    );
  });
});

describe('formatDragBadge：黑墊標記（Plan 14 Task 4，取代舊的 atMin/「min」硬停語意）', () => {
  it('trim + pad>0：附加 " · black +X.Xs"（英文，一位小數）', () => {
    expect(formatDragBadge({ kind: 'trim', duration: 4, delta: -2, pad: 1.2 })).toBe(
      '4.0s (−2.0s) · black +1.2s',
    );
  });

  it('trim 不帶 pad（省略）：格式不變，沒有 black 字樣', () => {
    expect(formatDragBadge({ kind: 'trim', duration: 4, delta: -2 })).toBe('4.0s (−2.0s)');
  });

  it('trim + pad:0：等同不帶，沒有 black 字樣（黑墊剛好吸附回 0）', () => {
    expect(formatDragBadge({ kind: 'trim', duration: 4, delta: -2, pad: 0 })).toBe('4.0s (−2.0s)');
  });

  it('pad 四捨五入到一位小數', () => {
    expect(formatDragBadge({ kind: 'trim', duration: 4, delta: -2, pad: 1.249 })).toBe(
      '4.0s (−2.0s) · black +1.2s',
    );
  });
});

describe('formatDragBadge：邊界修正（fix round 1 I4/I5）', () => {
  it('I4：delta 微幅為負但捨入後為 0 → 顯示 +0.0s，不顯示 −0.0s', () => {
    expect(formatDragBadge({ kind: 'trim', duration: 5, delta: -0.04 })).toBe('5.0s (+0.0s)');
  });

  it('I4：delta 微幅為正但捨入後為 0 → 顯示 +0.0s（先捨入後定號的另一側）', () => {
    expect(formatDragBadge({ kind: 'trim', duration: 5, delta: 0.04 })).toBe('5.0s (+0.0s)');
  });

  it('I4：delta 捨入後仍非 0 的負值 → 維持 −（不因修法誤傷正常負值）', () => {
    expect(formatDragBadge({ kind: 'trim', duration: 5, delta: -0.06 })).toBe('5.0s (−0.1s)');
  });

  it('I5：59.96 捨入到顯示精度後跨過 60 秒門檻 → 顯示 1:00，不是 60.0s', () => {
    expect(formatDragBadge({ kind: 'move', start: 59.96 })).toBe('1:00');
  });

  it('I5：59.94 捨入後仍在 60 秒內 → 維持 59.9s', () => {
    expect(formatDragBadge({ kind: 'move', start: 59.94 })).toBe('59.9s');
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
