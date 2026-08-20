import { describe, it, expect, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { Timeline } from './Timeline.js';
import { useView } from '../stores/view.js';
import { seedProject, resetStores } from '../test/fixtures.js';
import { tickPlanFor } from './scale.js';

/**
 * 尺規密度的 DOM 層驗證（CapCut 式：標籤稀疏 + 細分點）。
 * demoProject 總長固定 10s（見 fixtures.ts），把 pxPerSecond 直接設成已知值，
 * 用 `tickPlanFor` 反推「應該長出幾個標籤／幾個點」，比對 DOM 實際節點數與
 * 「點不落在標籤位置」這個不變量——這是這次改動要守住的行為，不是實作細節。
 *
 * `.mono` class 只掛在標籤 <span>（tickLabel 文字）上，尺規豎線／細分點沒有
 * class，用高度(6px=主刻度／3px=細分點)區分（Timeline.tsx 的 ruler 區塊）。
 */

beforeEach(() => {
  resetStores();
});

/**
 * 尺規容器：`height: 20px`（RULER_H）且 `position: sticky; top: 0` 的區塊。
 * 軌頭欄的交叉格（gutterCell）用同一個高度/sticky/top 組合但**沒有子節點**
 * （純圖示格）；尺規本體才會長出一堆標籤/刻度 span，用「有子節點」排除交叉格。
 * `span.mono` 在別處也存在（播放頭時間讀數 `0:00.0 / 0:10.0`），必須先縮小範圍
 * 到尺規容器才查，否則會誤把那個一起算進標籤數。
 */
function rulerEl(container: HTMLElement): HTMLElement {
  const el = Array.from(container.querySelectorAll('div')).find(
    (d) =>
      d.style.height === '20px' &&
      d.style.position === 'sticky' &&
      d.style.top === '0px' &&
      d.children.length > 0,
  );
  if (!el) throw new Error('ruler container not found');
  return el as HTMLElement;
}

function rulerLabels(container: HTMLElement): HTMLElement[] {
  return Array.from(rulerEl(container).querySelectorAll('span.mono'));
}

/** 尺規豎線／細分點：兩者都是無 class 的 absolute span，用高度(px)分辨。 */
function rulerLines(container: HTMLElement, heightPx: number): HTMLElement[] {
  return Array.from(rulerEl(container).querySelectorAll('span:not(.mono)')).filter(
    (el) => (el as HTMLElement).style.height === `${heightPx}px`,
  ) as HTMLElement[];
}

describe('Timeline ruler：像素密度自適應（CapCut 式標籤稀疏化）', () => {
  it('高 pps（放大到底）：標籤數量對得上 tickPlanFor，不是舊制「每秒一個標籤」的密集陣列', () => {
    const { container } = render(<Timeline />);
    act(() => {
      seedProject(); // 總長 10s
    });
    act(() => {
      useView.getState().setPxPerSecond(100); // 高縮放：labelStepSec 應為 1（100px>=80）
    });

    const { labelStepSec, dotStepSec } = tickPlanFor(100);
    expect(labelStepSec).toBe(1);
    expect(dotStepSec).toBeCloseTo(0.2);

    const labels = rulerLabels(container);
    const expectedLabelCount = Math.floor(10 / labelStepSec) + 1;
    expect(labels).toHaveLength(expectedLabelCount);

    const majorTicks = rulerLines(container, 6);
    expect(majorTicks).toHaveLength(expectedLabelCount);
  });

  it('低 pps（縮到很小）：標籤稀疏——DOM 中的標籤數遠少於「每秒一個」，且間距 >=80px 換算的秒數', () => {
    const { container } = render(<Timeline />);
    act(() => {
      seedProject();
    });
    act(() => {
      useView.getState().setPxPerSecond(5); // 低縮放：5s 全長只佔 50px，1s 一標會擠爆
    });

    const { labelStepSec } = tickPlanFor(5);
    expect(labelStepSec).toBeGreaterThan(1); // 確認不是「每秒一個標籤」這種舊制密度

    const labels = rulerLabels(container);
    const expectedLabelCount = Math.floor(10 / labelStepSec) + 1;
    expect(labels).toHaveLength(expectedLabelCount);
    // 標籤數遠低於總秒數：這就是「不密集」的可觀察證據。
    expect(labels.length).toBeLessThan(10);
  });

  it('細分點不與標籤位置重合（點只補在標籤之間，不疊在主刻度上）', () => {
    const { container } = render(<Timeline />);
    act(() => {
      seedProject();
    });
    act(() => {
      useView.getState().setPxPerSecond(100);
    });

    const { labelStepSec, dotStepSec } = tickPlanFor(100);
    expect(dotStepSec).toBeDefined();

    const majorLeftPx = new Set(
      rulerLines(container, 6).map((el) => Math.round(parseFloat(el.style.left))),
    );
    const dots = rulerLines(container, 3);
    expect(dots.length).toBeGreaterThan(0);
    for (const dot of dots) {
      const leftPx = Math.round(parseFloat(dot.style.left));
      expect(majorLeftPx.has(leftPx)).toBe(false);
    }

    // 額外交叉驗證：每個點的時間都不是 labelStepSec 的整數倍。
    for (const dot of dots) {
      const t = parseFloat(dot.style.left) / 100; // pps=100
      const dotsPerLabel = Math.round(labelStepSec / (dotStepSec ?? 1));
      const idx = Math.round(t / (dotStepSec ?? 1));
      expect(idx % dotsPerLabel).not.toBe(0);
    }
  });

  it('中低 pps 時若像素太窄，dotStepSec 可能是 undefined——此時尺規不畫任何細分點', () => {
    const { container } = render(<Timeline />);
    act(() => {
      seedProject();
    });
    act(() => {
      useView.getState().setPxPerSecond(useView.getState().zoomBounds.min);
    });

    const pps = useView.getState().pxPerSecond;
    const { dotStepSec } = tickPlanFor(pps);
    const dots = rulerLines(container, 3);
    if (dotStepSec === undefined) {
      expect(dots).toHaveLength(0);
    } else {
      expect(dots.length).toBeGreaterThan(0);
    }
  });
});
