import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { createElement } from 'react';
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
 *
 * review round 1 Critical 2：純數學層的 `quantizeVisibleRange` 測試只能證明
 * 「數值收斂到同一網格」，不能證明「memo 化的 ClipBlock 不會逐幀重渲染」——
 * 那個屬性只活在 `setVisibleRange` 的 functional updater 那一層（`Timeline.tsx`
 * 的 `prev.start===next.start && prev.end===next.end ? prev : next`），必須在
 * 這一層量。這裡用 `vi.mock` 包一層計數 wrapper 蓋掉 `ClipBlock` 模組——保留
 * 真實渲染邏輯（`importOriginal` 拿真的元件），只加一個呼叫計數器。
 */

// 這個檔案的四個案例都掛整棵 Timeline 真元件樹、渲染到 69–97 個真 filmstrip-tile
// div（見下方 seedLongClip + 各案例的手算窗界），不是隔離的純函數測試。單獨跑
// 每案例 <1s，但 vitest 預設檔案級平行時，這個檔案常與其他重量元件測試檔
// （App.test.tsx、Timeline.test.tsx 等）同時佔用 CPU，實測在 shuffle seed=1/2
// 下第一個案例卡到 5895ms，撞穿預設 5000ms 逾時（其餘三案例也逼近 4000–4500ms，
// 同一個成因）——是 CPU 排隊時間，不是掛住或邏輯錯誤（獨立跑穩定 <1s／案例）。
// 只放寬這個檔案的逾時，不動全域設定，避免真正掛住的測試被這個數字蓋掉。
vi.setConfig({ testTimeout: 15000 });

let clipBlockRenderCount = 0;

vi.mock('./ClipBlock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ClipBlock.js')>();
  const Counting = (props: Record<string, unknown>) => {
    clipBlockRenderCount++;
    return createElement(actual.ClipBlock, props as never);
  };
  return { ...actual, ClipBlock: Counting };
});

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
  clipBlockRenderCount = 0;
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
  it('視窗外的格不進 DOM，且窗界精確（非只驗證「比全部少」）', () => {
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

    const tiles = container.querySelectorAll<HTMLElement>('[data-testid="filmstrip-tile"]');
    // 600s * 40pps = 24000px 寬；frameW = (70-4)*1080/1920 = 37.125 → 全渲染 647 格。
    // review round 1 Important 4：只斷言「比全部少」放不住視窗算錯幾百 px 的回歸，
    // 這裡照 Timeline.tsx 的實際算式（viewportW=clientWidth-GUTTER_W=1168、
    // buffer=一屏=1168、quantize 到 256px 網格）手算精確值：
    //   raw=[0-1168, 0+1168+1168]=[-1168,2336] → quantized=[-1280,2560]
    //   firstSlot=floor(-1280/37.125)=0（clamp 到 0）
    //   lastSlot=floor(2560/37.125)=68 → 69 格，x∈[0, 68*37.125=2524.5]
    expect(tiles).toHaveLength(69);
    const xs = Array.from(tiles)
      .map((el) => parseFloat(el.style.left))
      .sort((a, b) => a - b);
    expect(xs[0]).toBe(0);
    expect(xs[xs.length - 1]).toBeCloseTo(2524.5, 5);
  });

  it('scrollLeft 變化（模擬使用者捲動）後，視窗精確移動到手算的新範圍', () => {
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

    // 捲動到 scrollLeft=15000（clip 總寬 24000px 內）
    act(() => {
      Object.defineProperty(well, 'scrollLeft', { configurable: true, value: 15000 });
      fireEvent.scroll(well);
    });
    act(() => {
      flushRaf();
    });

    // 手算：raw=[15000-1168, 15000+1168+1168]=[13832,17336] →
    // quantized=[13824,17408]（floor/ceil 到 256 網格）
    // firstSlot=floor(13824/37.125)=372, lastSlot=floor(17408/37.125)=468 → 97 格
    // x∈[372*37.125=13810.5, 468*37.125=17374.5]
    const tiles = container.querySelectorAll<HTMLElement>('[data-testid="filmstrip-tile"]');
    expect(tiles).toHaveLength(97);
    const xs = Array.from(tiles)
      .map((el) => parseFloat(el.style.left))
      .sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(13810.5, 5);
    expect(xs[xs.length - 1]).toBeCloseTo(17374.5, 5);
  });
});

describe('filmstrip windowing：memo 化 ClipBlock 在 quantum 內不逐幀重渲染（Critical 2）', () => {
  it('同一個 256px 量子內的多次 scroll，ClipBlock 完全不重渲染（render-count spy）', () => {
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

    const countAfterSettle = clipBlockRenderCount;
    expect(countAfterSettle).toBeGreaterThan(0); // 掛載本身當然渲染過

    // 同一個 256px 量子內的三次小幅捲動。手算（見上一個 describe 的算式）：
    // scrollLeft=0 時 quantized=[-1280,2560]；scrollLeft∈[0,100] 算出來的
    // quantized 範圍都還是同一組（下一個量子邊界在 scrollLeft≈150 才跨過，
    // 見 raw=[sl-1168, sl+1168+1168] 量化到 256 網格的邊界）——若
    // setVisibleRange 的 bail-out 失效，這三次 scroll 事件會各自觸發一次
    // 額外的 Timeline 重渲染，ClipBlock 的 render count 會跟著往上跳。
    for (const sl of [10, 50, 90]) {
      act(() => {
        Object.defineProperty(well, 'scrollLeft', { configurable: true, value: sl });
        fireEvent.scroll(well);
      });
      act(() => {
        flushRaf();
      });
    }

    expect(clipBlockRenderCount).toBe(countAfterSettle);
  });

  it('跨量子邊界的 scroll 仍然會（且應該）觸發一次重渲染——上一條測試不是「永遠不渲染」的假陽性', () => {
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

    const countAfterSettle = clipBlockRenderCount;

    // 遠距離捲動，跨越多個 256px 量子邊界——量化後的 {start,end} 必然改變，
    // bail-out 不該擋下這次，ClipBlock 應該重渲染。
    act(() => {
      Object.defineProperty(well, 'scrollLeft', { configurable: true, value: 15000 });
      fireEvent.scroll(well);
    });
    act(() => {
      flushRaf();
    });

    expect(clipBlockRenderCount).toBeGreaterThan(countAfterSettle);
  });
});
