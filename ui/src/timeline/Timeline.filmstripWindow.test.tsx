import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { Timeline } from './Timeline.js';
import { useView } from '../stores/view.js';
import { demoProject, seedProject, resetStores } from '../test/fixtures.js';

/**
 * Plan 9 Task 3 範圍裁決 #6：ClipBlock 只渲染捲動視窗內（±一屏 buffer）的
 * filmstrip tile，Timeline 負責把 scrollLeft/viewport 換算成 visibleRange 傳下去。
 * 純數學（windowing 相交、quantize）已由 filmstripTiles.test.ts 蓋住，這裡驗證
 * Timeline ↔ ClipBlock 的實際接線：長 clip 的 tile 一開始就是裁窗過的、
 * scroll 之後窗口跟著移動。
 *
 * jsdom 沒有版面：`clientWidth`/`scrollLeft` 都要手動 stub（同
 * Timeline.autofit.test.tsx 的 stubViewport 手法）。
 */

const VIEWPORT_W = 1200;
const PPS = 40;

function stubViewport(container: HTMLElement, width = VIEWPORT_W): HTMLElement {
  const well = container.querySelector('div[style*="overflow: auto"]') as HTMLElement;
  Object.defineProperty(well, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(well, 'scrollLeft', {
    configurable: true,
    writable: true,
    value: 0,
  });
  return well;
}

let roCallback: (() => void) | null = null;
let rafCallbacks: FrameRequestCallback[] = [];

beforeEach(() => {
  resetStores();
  roCallback = null;
  rafCallbacks = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        roCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // rAF 節流：測試手動 flush，避免真的等一個動畫幀。
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function flushRaf() {
  const cbs = rafCallbacks;
  rafCallbacks = [];
  cbs.forEach((cb) => cb(0));
}

/** 造一個長 clip（撐開 tile 數）並讓時間軸總長遠超過一個可視窗。 */
function seedLongClip() {
  const doc = demoProject();
  doc.tracks.video[0] = { ...doc.tracks.video[0], in: 0, duration: 600 }; // 600s，遠超一屏
  doc.tracks.video = [doc.tracks.video[0]!]; // 只留一段，避免 c2 干擾
  return seedProject(doc);
}

describe('filmstrip windowing：Timeline → ClipBlock 接線', () => {
  it('視窗外的格不進 DOM（長 clip 一開始渲染的 tile 數遠少於全部格數）', () => {
    const { container } = render(<Timeline />);
    act(() => {
      seedLongClip();
    });
    act(() => {
      stubViewport(container);
      roCallback?.(); // 首次掛載的自動 fit（範圍裁決 #4a），之後才是我們要測的手動縮放
    });
    // 手動縮放到固定 pps，模擬使用者滾輪放大——userZoomed=true 之後自動 fit 不會再搶
    act(() => {
      useView.setState({ pxPerSecond: PPS, userZoomed: true });
    });
    act(() => {
      flushRaf();
    });

    const tiles = container.querySelectorAll('[data-testid="filmstrip-tile"]');
    // 600s * 40pps = 24000px 寬；frameW ≈ 37px → 全渲染會有 ~650 格。
    // 視窗只有 1200px（+前後各一屏 buffer），裁窗後應該遠少於全部格數。
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThan(300);
  });

  it('scrollLeft 變化（模擬使用者捲動）後，視窗跟著移動：畫出來的 tile x 範圍改變', () => {
    const { container } = render(<Timeline />);
    act(() => {
      seedLongClip();
    });
    let well!: HTMLElement;
    act(() => {
      well = stubViewport(container);
      roCallback?.();
    });
    act(() => {
      useView.setState({ pxPerSecond: PPS, userZoomed: true });
    });
    act(() => {
      flushRaf();
    });

    const leftXs = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="filmstrip-tile"]'),
    ).map((el) => parseFloat(el.style.left));
    expect(leftXs.length).toBeGreaterThan(0);

    // 捲動到很後面（clip 總寬 24000px）
    act(() => {
      Object.defineProperty(well, 'scrollLeft', { configurable: true, value: 15000 });
      fireEvent.scroll(well);
    });
    act(() => {
      flushRaf();
    });

    const rightXs = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="filmstrip-tile"]'),
    ).map((el) => parseFloat(el.style.left));
    expect(rightXs.length).toBeGreaterThan(0);

    const minLeft = Math.min(...leftXs);
    const minRight = Math.min(...rightXs);
    expect(minRight).toBeGreaterThan(minLeft);
  });
});
