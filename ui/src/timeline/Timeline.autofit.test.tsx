import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, fireEvent } from '@testing-library/react';
import { Timeline } from './Timeline.js';
import { useView } from '../stores/view.js';
import { useProject } from '../stores/project.js';
import { demoProject, seedProject, resetStores } from '../test/fixtures.js';
import { zoomBoundsFor } from './scale.js';

/**
 * 自動 fit 政策（Plan 9 範圍裁決 #4）：
 *   (a) 專案載入（WS full doc）→ fit
 *   (b) 總時長變化（加/刪 clip）且使用者自上次 fit 後未手動縮放 → 重新 fit
 *   (c) 拖曳進行中 → 絕不自動 fit
 *   (d) resize → 重算 zoomBounds；!userZoomed 時一併重新 fit
 *
 * jsdom 沒有版面，`clientWidth` 恆為 0——測試裡對 scroll 容器 stub 一個固定寬度
 * （waveform.test.ts 已有這個手法的先例）。ResizeObserver 的全域 polyfill
 * （test/setup.ts）是空殼、不會真的觸發 callback，這裡另外 stub 一份「可控」版本，
 * 讓測試能手動觸發 resize 事件。
 *
 * 每個 act() 只做一件事：seed 專案（讓 DOM 長出來）跟 stub clientWidth 分開兩輪，
 * 否則 `container.querySelector` 會在 React 還沒 flush seedProject 的那一輪
 * state 更新前就跑，抓不到剛長出來的 scroll 容器。
 */

const VIEWPORT_W = 1200; // stub 的 scroll 容器 clientWidth
/**
 * 左側軌頭欄寬（同 Timeline.tsx 的 GUTTER_W）：`clientWidth` 是 scroll 容器的，
 * 含左側軌頭欄，但 fit 要餵的是 content 的可視寬——效果內部會扣掉這個常數，
 * 這裡的預期值算式必須跟著扣，否則會拿「含 gutter 的寬度」去驗「扣過 gutter」
 * 的結果，永遠對不上。
 */
const GUTTER_W = 32;

/** 找到 Timeline 的 scroll 容器（overflow:auto 那層）並 stub clientWidth。 */
function stubViewport(container: HTMLElement, width = VIEWPORT_W): HTMLElement {
  const well = container.querySelector('div[style*="overflow: auto"]') as HTMLElement;
  Object.defineProperty(well, 'clientWidth', { configurable: true, value: width });
  return well;
}

let roCallback: (() => void) | null = null;

beforeEach(() => {
  resetStores();
  roCallback = null;
  // 可控的 ResizeObserver：記住 callback，測試手動觸發。
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('自動 fit：專案載入', () => {
  it('載入 full doc → pxPerSecond 落在 fit 值', () => {
    const { container } = render(<Timeline />);
    act(() => {
      seedProject(); // c1(0-6s)+c2(6-10s，凍結)= 總長 10s
    });
    act(() => {
      stubViewport(container);
      roCallback?.();
    });
    // 扣 GUTTER_W 再扣 FIT_PADDING_PX=40 → (1200-32-40)/10 = 112.8，未超過 max=120
    const expected = (VIEWPORT_W - GUTTER_W - 40) / 10;
    expect(useView.getState().pxPerSecond).toBeCloseTo(expected, 5);
    expect(useView.getState().userZoomed).toBe(false);
  });
});

describe('自動 fit：總時長變化', () => {
  it('加 clip（總時長變長）且未手動縮放過 → 重新 fit', () => {
    const { container } = render(<Timeline />);
    let doc = demoProject();
    act(() => {
      doc = seedProject(doc);
    });
    act(() => {
      stubViewport(container);
      roCallback?.();
    });
    const before = useView.getState().pxPerSecond;

    // 模擬 addClip：總長從 10s 變 20s（新增一段 10s 的 clip）
    const grown = {
      ...doc,
      tracks: {
        ...doc.tracks,
        video: [
          ...doc.tracks.video,
          { id: 'c3', mediaId: 'm1', in: 0, duration: 10, volume: 1, label: 'clip three' },
        ],
      },
    };
    act(() => {
      useProject.getState().applyServerMsg({ type: 'full', version: 2, doc: grown, history: [] });
    });

    const after = useView.getState().pxPerSecond;
    const expectedFit = (VIEWPORT_W - GUTTER_W - 40) / 20;
    expect(after).toBeCloseTo(expectedFit, 5);
    expect(after).not.toBeCloseTo(before, 5);
    expect(useView.getState().userZoomed).toBe(false);
  });

  it('加 clip 但使用者先手動縮放過 → pxPerSecond 不因總時長變化而改變', () => {
    const { container } = render(<Timeline />);
    let doc = demoProject();
    act(() => {
      doc = seedProject(doc);
    });
    act(() => {
      stubViewport(container);
      roCallback?.();
    });

    // 使用者手動縮放
    act(() => {
      useView.getState().zoomBy(1.5);
    });
    const zoomed = useView.getState().pxPerSecond;
    expect(useView.getState().userZoomed).toBe(true);

    const grown = {
      ...doc,
      tracks: {
        ...doc.tracks,
        video: [
          ...doc.tracks.video,
          { id: 'c3', mediaId: 'm1', in: 0, duration: 10, volume: 1, label: 'clip three' },
        ],
      },
    };
    act(() => {
      useProject.getState().applyServerMsg({ type: 'full', version: 2, doc: grown, history: [] });
    });

    expect(useView.getState().pxPerSecond).toBeCloseTo(zoomed, 5);
    expect(useView.getState().userZoomed).toBe(true);
  });
});

describe('自動 fit：拖曳中不 fit', () => {
  it('拖曳進行中,總時長變化不觸發自動 fit', () => {
    const { container } = render(<Timeline />);
    let doc = demoProject();
    act(() => {
      doc = seedProject(doc);
    });
    act(() => {
      stubViewport(container);
      roCallback?.();
    });
    const before = useView.getState().pxPerSecond;

    // 啟動一段 trim 拖曳（不放手）：drag.current 在這期間非 null。
    // 任一段 clip 的把手都行——這裡只需要「拖曳中」這個狀態，不關心拖哪段。
    const handle = container.querySelector('.handle');
    expect(handle).toBeTruthy();
    act(() => {
      fireEvent.pointerDown(handle!, { clientX: 100, pointerId: 1, bubbles: true });
    });

    const grown = {
      ...doc,
      tracks: {
        ...doc.tracks,
        video: [
          ...doc.tracks.video,
          { id: 'c3', mediaId: 'm1', in: 0, duration: 10, volume: 1, label: 'clip three' },
        ],
      },
    };
    act(() => {
      useProject.getState().applyServerMsg({ type: 'full', version: 2, doc: grown, history: [] });
    });

    // 拖曳還沒結束：不應該自動 fit
    expect(useView.getState().pxPerSecond).toBeCloseTo(before, 5);

    act(() => {
      fireEvent.pointerUp(handle!, { clientX: 100, pointerId: 1, bubbles: true });
    });
  });

  it('拖曳結束後,即使總時長沒有再變,也會補上被拖曳擋下來的那次 fit', () => {
    const { container } = render(<Timeline />);
    let doc = demoProject();
    act(() => {
      doc = seedProject(doc);
    });
    act(() => {
      stubViewport(container);
      roCallback?.();
    });
    const before = useView.getState().pxPerSecond;

    const handle = container.querySelector('.handle');
    act(() => {
      fireEvent.pointerDown(handle!, { clientX: 100, pointerId: 1, bubbles: true });
    });

    const grown = {
      ...doc,
      tracks: {
        ...doc.tracks,
        video: [
          ...doc.tracks.video,
          { id: 'c3', mediaId: 'm1', in: 0, duration: 10, volume: 1, label: 'clip three' },
        ],
      },
    };
    act(() => {
      useProject.getState().applyServerMsg({ type: 'full', version: 2, doc: grown, history: [] });
    });
    expect(useView.getState().pxPerSecond).toBeCloseTo(before, 5); // 拖曳中被擋下

    act(() => {
      fireEvent.pointerUp(handle!, { clientX: 100, pointerId: 1, bubbles: true });
    });

    // 拖曳結束後、doc 再抵達一次(總時長仍是 20s、沒有再變)——應該補上剛才錯過的 fit,
    // 不是永遠停在拖曳前的舊值。用新 object reference 模擬真正的 server echo
    // (`applyServerMsg({type:'full'})` 直接拿 msg.doc 當新 state,同一個 reference
    // 再送一次的話 React 的 `[doc]` deps 比對是 Object.is,偵測不到「變了」，
    // effect 根本不會重跑——這是測試要如實模擬的地方，不是產品碼的判斷依據)。
    act(() => {
      useProject
        .getState()
        .applyServerMsg({ type: 'full', version: 3, doc: { ...grown }, history: [] });
    });

    const expectedFit = (VIEWPORT_W - GUTTER_W - 40) / 20;
    expect(useView.getState().pxPerSecond).toBeCloseTo(expectedFit, 5);
  });
});

describe('自動 fit：resize', () => {
  it('resize 後重算 zoomBounds；未手動縮放過 → 重新 fit', () => {
    const { container } = render(<Timeline />);
    act(() => {
      seedProject(); // 總長 10s
    });
    act(() => {
      stubViewport(container, 1200);
      roCallback?.();
    });
    const before = useView.getState().pxPerSecond;

    act(() => {
      stubViewport(container, 600);
      roCallback?.();
    });

    const expectedBounds = zoomBoundsFor(10, 600 - GUTTER_W);
    expect(useView.getState().zoomBounds.min).toBeCloseTo(expectedBounds.min, 5);
    expect(useView.getState().zoomBounds.max).toBe(expectedBounds.max);
    const expectedFit = (600 - GUTTER_W - 40) / 10;
    expect(useView.getState().pxPerSecond).toBeCloseTo(expectedFit, 5);
    expect(useView.getState().pxPerSecond).not.toBeCloseTo(before, 5);
  });

  it('resize 後,使用者已手動縮放過 → 只重算 bounds,不重新 fit(除非現值落在界外)', () => {
    const { container } = render(<Timeline />);
    act(() => {
      seedProject();
    });
    act(() => {
      stubViewport(container, 1200);
      roCallback?.();
    });
    act(() => {
      useView.getState().zoomBy(1.01); // 隨便動一下，讓 userZoomed=true 且值不等於 fit 值
    });
    const zoomed = useView.getState().pxPerSecond;

    act(() => {
      stubViewport(container, 1180); // 小幅 resize，不足以把 zoomed 值夾出界
      roCallback?.();
    });

    expect(useView.getState().pxPerSecond).toBeCloseTo(zoomed, 5);
    expect(useView.getState().userZoomed).toBe(true);
  });
});
