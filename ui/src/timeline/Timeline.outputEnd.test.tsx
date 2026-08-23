import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import type { Command } from '@vidcut/shared';
import { outputDuration } from '@vidcut/shared';
import { Timeline } from './Timeline.js';
import { useView } from '../stores/view.js';
import { useProject } from '../stores/project.js';
import { usePlayback } from '../stores/playback.js';
import * as ws from '../ws.js';
import { demoProject, seedProject, resetStores } from '../test/fixtures.js';
import { zoomBoundsFor } from './scale.js';

/**
 * Plan 13 Task 4（裁決 5a/5b/10）：END 柱、黑尾帶、死區降暗、寬度/fit/min-zoom
 * 換基準到 outputDuration、永遠填滿、jump-to-end 換目標、teardownDrag clamp
 * 只在非 commit 路徑跑。
 *
 * jsdom 版面陷阱（見 .claude/rules/ui-verification.md）：`clientWidth` 恆為 0，
 * 借用 Timeline.test.tsx 的 stub 手法——固定 clientWidth，反推 pxPerSecond。
 */
const PPS = 40;
const GUTTER_W = 32;
const STUB_CLIENT_WIDTH = 472; // (472-32-40)/10 = 40，與 demoProject 總長 10s 對齊

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return STUB_CLIENT_WIDTH;
    },
  });
});

/** 有黑尾的專案：主軌總長 10s（c1 0-6 + c2 6-10），audio a1 撐到 15s（超出主軌 5s）。 */
function projectWithBlackTail() {
  const doc = demoProject();
  doc.tracks.audio = [
    { id: 'a1', mediaId: 'm2', start: 10, in: 0, duration: 5, volume: 0.8, label: 'bgm' },
  ];
  return doc;
}

let sent: Command[];

function stubViewport(container: HTMLElement, width = STUB_CLIENT_WIDTH): HTMLElement {
  const well = container.querySelector('div[style*="overflow: auto"]') as HTMLElement;
  Object.defineProperty(well, 'clientWidth', { configurable: true, value: width });
  return well;
}

describe('END 柱與黑尾帶（裁決 5a/5b）', () => {
  beforeEach(() => {
    resetStores();
    useView.setState({ pxPerSecond: PPS, snapEnabled: false });
  });

  it('無黑尾時：END 柱落在主軌結尾，且沒有黑尾帶', () => {
    const doc = seedProject();
    const { container } = render(<Timeline />);
    // 掛載時的自動 fit 會覆蓋 beforeEach 設的 pps（見同檔案其餘測試同款註解）——
    // 掛載後再顯式設回整數 PPS，只驗證 END 柱位置這件事本身。
    act(() => {
      useView.setState({ pxPerSecond: PPS, snapEnabled: false });
    });
    const end = container.querySelector('[data-testid="tl-end-marker"]') as HTMLElement;
    expect(end).toBeTruthy();
    // -1：同 Playhead 的置中慣例，2px 線置中在該時間點的像素位置上。
    expect(end.style.left).toBe(`${outputDuration(doc) * PPS - 1}px`);
    expect(container.querySelector('[data-testid="tl-blacktail"]')).toBeNull();
  });

  it('有黑尾時：END 柱落在 outputDuration（超出主軌總長），黑尾帶出現在 [total, outputDuration)', () => {
    const doc = projectWithBlackTail();
    seedProject(doc);
    const { container } = render(<Timeline />);
    act(() => {
      useView.setState({ pxPerSecond: PPS, snapEnabled: false });
    });
    const end = container.querySelector('[data-testid="tl-end-marker"]') as HTMLElement;
    const out = outputDuration(doc); // 15
    expect(out).toBe(15);
    expect(end.style.left).toBe(`${out * PPS - 1}px`); // -1：同 Playhead 的置中慣例

    const tail = container.querySelector('[data-testid="tl-blacktail"]') as HTMLElement;
    expect(tail).toBeTruthy();
    expect(tail.style.left).toBe(`${10 * PPS}px`); // 主軌總長
    expect(tail.style.width).toBe(`${(out - 10) * PPS}px`);
    expect(tail.style.pointerEvents).toBe('none'); // 純視覺、不可互動
  });

  it('END 旗標顯示總長，格式與 DragBadge/Timecode 一致（<60s 用 Ns）', () => {
    const doc = projectWithBlackTail(); // outputDuration 15s
    seedProject(doc);
    const { container } = render(<Timeline />);
    const flag = container.querySelector('[data-testid="tl-end-flag"]');
    expect(flag?.textContent).toContain('15.0s');
  });

  it('死區（END 之後）視覺上降暗：死區區塊存在且緊接在 END 柱之後', () => {
    const doc = seedProject();
    const { container } = render(<Timeline />);
    const dead = container.querySelector('[data-testid="tl-deadzone"]') as HTMLElement;
    expect(dead).toBeTruthy();
    expect(dead.style.left).toBe(`${outputDuration(doc) * PPS}px`);
  });

  it('END 柱視覺與 playhead 區分（不使用 playhead 的 accent token）', () => {
    seedProject();
    const { container } = render(<Timeline />);
    const end = container.querySelector('[data-testid="tl-end-marker"]') as HTMLElement;
    expect(end.style.background).not.toContain('--accent-bright');
  });
});

/**
 * review round 1 Medium（binding ruling）：to-end overlay（duration:null）拖曳的
 * `effectiveSpan` 基準——Task 1 起 `overlayWindow` 對 to-end overlay 的 end 已經
 * 改成跟隨 outputDuration（shared/src/timeline.ts 的不變式註解），但 Timeline.tsx
 * 三處算「目前有效時長」的地方（onPointerMove 的 in/zero-move/out 三分支共用同一個
 * `effectiveSpan`、dragBadgeRaw 的 `origSpan`/`previewSpan`）當時沿用了舊的
 * `totalDuration(doc)`——黑尾專案上這個基準比實際渲染的視窗結尾（output）短，
 * 拖曳中的 badge 顯示與放手材料化的 duration 因此與畫面上看到的不一致。
 * 修法：三處全部改讀render body 已經算好的 `output`（=outputDuration(doc)）。
 */
describe('to-end overlay 拖曳基準（review round 1 Medium：Task 1 起 overlayWindow 已用 outputDuration）', () => {
  beforeEach(() => {
    resetStores();
    useView.setState({ pxPerSecond: PPS, snapEnabled: false });
    sent = [];
    vi.spyOn(ws, 'sendCommand').mockImplementation((c: Command) => {
      sent.push(c);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  function chipByText(c: HTMLElement, text: string): HTMLElement {
    const hits = Array.from(c.querySelectorAll('div')).filter((d) =>
      d.textContent?.trim().startsWith(text),
    );
    const el = hits.find((d) => !hits.some((o) => o !== d && d.contains(o)));
    if (!el) throw new Error(`chip not found: ${text}`);
    return el;
  }
  function handles(el: Element): Element[] {
    return Array.from(el.querySelectorAll('.handle'));
  }

  it('黑尾專案：to-end overlay 的起始有效時長吃 output（不是主軌 total），badge 與材料化 duration 一致', () => {
    // projectWithBlackTail：主軌 total=10，output=15（audio a1 撐到 15）。
    // to-end overlay start=5 → 正確的「目前有效時長」= output-5 = 10（修好之前是
    // total-5 = 5）。拖 out 把手 +1s（40px）：修好後 badge 應顯示 11.0s
    // （10+1），材料化後送出的 duration 也該是 11——修之前這裡會是 6（5+1）。
    const doc = projectWithBlackTail();
    doc.tracks.overlays.push({
      id: 'ovToEnd',
      imagePath: 'assets/lower.png',
      start: 5,
      duration: null,
      position: { x: 0.5, y: 0.9, scale: 1 },
    });
    seedProject(doc);
    const { container } = render(<Timeline />);
    // 這個專案的 outputDuration（15）與 STUB_CLIENT_WIDTH（472，反推自無黑尾的
    // demoProject 總長 10s）搭配算出的掛載自動 fit pps 不是整數——顯式覆蓋回
    // 40，讓下面的像素位移換算保持可讀（同檔案其餘黑尾情境測試的既有手法）。
    act(() => {
      useView.setState({ pxPerSecond: PPS, snapEnabled: false });
    });
    const [, right] = handles(chipByText(container, 'lower.png'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true }); // +1s
    });
    // 拖曳中：badge 顯示的時長已經吃到 output 基準（11.0s，不是舊基準的 6.0s）
    expect(container.textContent).toContain('11.0s (+1.0s)');
    act(() => {
      fireEvent.pointerUp(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    // 放手材料化：送出的 duration 與 badge 顯示一致
    expect(sent).toEqual([{ name: 'updateOverlay', id: 'ovToEnd', patch: { duration: 11 } }]);
  });

  it('無黑尾專案：outputDuration 與主軌 total 重合，行為不變（既有測試同款情境的對照組）', () => {
    // demoProject：total=output=10。to-end overlay start=5 → 有效時長=5，
    // 與修之前用 totalDuration 算出的值完全相同——這裡釘住「兩個函式重合時
    // 沒有可觀察差異」，不是重新驗證既有行為（Timeline.test.tsx 的
    // 'a to-end overlay (duration=null) only shows an out-handle behavior
    // that materializes duration' 已經覆蓋同一情境）。
    const doc = demoProject();
    doc.tracks.overlays.push({
      id: 'ovToEnd',
      imagePath: 'assets/lower.png',
      start: 5,
      duration: null,
      position: { x: 0.5, y: 0.9, scale: 1 },
    });
    seedProject(doc);
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'lower.png'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true }); // +1s
    });
    expect(container.textContent).toContain('6.0s (+1.0s)');
    act(() => {
      fireEvent.pointerUp(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    expect(sent).toEqual([{ name: 'updateOverlay', id: 'ovToEnd', patch: { duration: 6 } }]);
  });
});

describe('寬度/fit/min-zoom 換基準到 outputDuration（裁決 5a 尾+10a）', () => {
  beforeEach(() => {
    resetStores();
  });

  it('內容寬鍵到 outputDuration：超出主軌的黑尾/chip 捲得到', () => {
    const doc = projectWithBlackTail(); // outputDuration 15
    seedProject(doc);
    const { container } = render(<Timeline />);
    // 掛載時的自動 fit 已經把 pps 夾到動態下限（jsdom clientWidth stub 值與這裡的
    // 總長不對齊，不是這個測試要驗的東西）——掛載後再顯式設 pps，只驗證「width
    // 這個算式吃的是 output，不是主軌 total」這件事本身。
    act(() => {
      useView.setState({ pxPerSecond: PPS, snapEnabled: false });
    });
    const content = container.querySelector(
      '[data-tl-blank][style*="touch-action"]',
    ) as HTMLElement;
    // width = max(timeToPx(outputDuration)+120, 600)
    const expectedWidth = Math.max(15 * PPS + 120, 600);
    expect(content.style.width).toBe(`${expectedWidth}px`);
  });

  it('Shift+Z fit（toolbar onFit）用 outputDuration 當基準，不是主軌總長', () => {
    const doc = projectWithBlackTail(); // total 10, output 15
    seedProject(doc);
    const { container } = render(<Timeline />);
    act(() => {
      stubViewport(container);
    });
    const fitBtn = container.querySelector<HTMLButtonElement>(
      'button[title="Fit timeline (Shift+Z)"]',
    )!;
    act(() => {
      fireEvent.click(fitBtn);
    });
    const expected = (STUB_CLIENT_WIDTH - GUTTER_W - 40) / 15; // outputDuration=15
    expect(useView.getState().pxPerSecond).toBeCloseTo(expected, 5);
  });

  it('min zoom（zoomBounds.min）鍵到 outputDuration，不是主軌總長', () => {
    const doc = projectWithBlackTail(); // total 10, output 15
    seedProject(doc);
    const { container } = render(<Timeline />);
    act(() => {
      stubViewport(container, 1200);
    });
    // resize 觸發（ResizeObserver 真實環境會呼叫；這裡直接驗證 fit 之後的 bounds）
    act(() => {
      useView.getState().fit(outputDuration(doc), 1200 - GUTTER_W);
    });
    const expectedBounds = zoomBoundsFor(15, 1200 - GUTTER_W);
    expect(useView.getState().zoomBounds.min).toBeCloseTo(expectedBounds.min, 5);
  });

  it('__vidcutFit 全域掛鉤也改鍵到 outputDuration', () => {
    const doc = projectWithBlackTail();
    seedProject(doc);
    const { container } = render(<Timeline />);
    act(() => {
      stubViewport(container);
    });
    act(() => {
      (window as unknown as { __vidcutFit: () => void }).__vidcutFit();
    });
    const expected = (STUB_CLIENT_WIDTH - GUTTER_W - 40) / 15;
    expect(useView.getState().pxPerSecond).toBeCloseTo(expected, 5);
  });
});

describe('永遠填滿（裁決 10）', () => {
  let roCallback: (() => void) | null = null;

  beforeEach(() => {
    resetStores();
    roCallback = null;
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

  afterEach(() => vi.unstubAllGlobals());

  it('內容因刪除/修剪縮短、比視口窄時自動重新 fit 填滿', () => {
    const { container } = render(<Timeline />);
    let doc = demoProject(); // 總長 10s
    act(() => {
      doc = seedProject(doc);
    });
    act(() => {
      stubViewport(container, 1200);
      roCallback?.();
    });
    // 手動縮放，讓 pxPerSecond 遠大於「填滿視口」所需（模擬「刪除後變窄」的前置態）
    act(() => {
      useView.getState().zoomBy(0.5); // 縮小一半，userZoomed=true
    });
    const zoomedPps = useView.getState().pxPerSecond;

    // 模擬 clip 大幅縮短：總長從 10s 變成 1s（在目前 pps 下遠比視口窄）
    const shrunk = {
      ...doc,
      tracks: {
        ...doc.tracks,
        video: [{ ...doc.tracks.video[0]!, duration: 1 }],
      },
    };
    act(() => {
      useProject.getState().applyServerMsg({ type: 'full', version: 2, doc: shrunk, history: [] });
    });

    // 應該自動重新 fit 填滿視口，不再維持縮小前的 pps（即使 userZoomed 曾是 true）
    const after = useView.getState().pxPerSecond;
    expect(after).not.toBeCloseTo(zoomedPps, 3);
    const expectedFit = (1200 - GUTTER_W - 40) / 1;
    expect(after).toBeCloseTo(Math.min(expectedFit, 120), 3); // MAX_PX_PER_SECOND=120 可能封顶
  });

  it('拖曳中：內容縮短也不觸發自動重 fit（沿用既有 (c) 守門）', () => {
    const { container } = render(<Timeline />);
    let doc = demoProject();
    act(() => {
      doc = seedProject(doc);
    });
    act(() => {
      stubViewport(container, 1200);
      roCallback?.();
    });
    act(() => {
      useView.getState().zoomBy(0.5);
    });
    const zoomedPps = useView.getState().pxPerSecond;

    const handle = container.querySelector('.handle');
    expect(handle).toBeTruthy();
    act(() => {
      fireEvent.pointerDown(handle!, { clientX: 100, pointerId: 1, bubbles: true });
    });

    const shrunk = {
      ...doc,
      tracks: {
        ...doc.tracks,
        video: [{ ...doc.tracks.video[0]!, duration: 1 }],
      },
    };
    act(() => {
      useProject.getState().applyServerMsg({ type: 'full', version: 2, doc: shrunk, history: [] });
    });

    expect(useView.getState().pxPerSecond).toBeCloseTo(zoomedPps, 5); // 拖曳中被擋下

    act(() => {
      fireEvent.pointerUp(handle!, { clientX: 100, pointerId: 1, bubbles: true });
    });
  });

  it('視口 resize 後同樣保持填滿（既有 resize fit 換基準，含黑尾情境）', () => {
    const { container } = render(<Timeline />);
    let doc = projectWithBlackTail(); // total 10, output 15
    act(() => {
      doc = seedProject(doc);
    });
    act(() => {
      stubViewport(container, 1200);
      roCallback?.();
    });

    act(() => {
      stubViewport(container, 600);
      roCallback?.();
    });

    const expectedFit = (600 - GUTTER_W - 40) / outputDuration(doc); // 15
    expect(useView.getState().pxPerSecond).toBeCloseTo(expectedFit, 5);
  });

  it('放大（比視口寬）時不受影響——不會被強制拉回填滿值', () => {
    const { container } = render(<Timeline />);
    act(() => {
      seedProject(); // 10s
    });
    act(() => {
      stubViewport(container, 1200);
      roCallback?.();
    });
    act(() => {
      useView.getState().zoomBy(2); // 放大，內容變得比視口寬
    });
    const zoomedIn = useView.getState().pxPerSecond;

    // 一個不改變總長的 patch（模擬純內容變化）不該觸發重新 fit
    const doc = useProject.getState().doc!;
    act(() => {
      useProject
        .getState()
        .applyServerMsg({ type: 'full', version: 3, doc: { ...doc }, history: [] });
    });

    expect(useView.getState().pxPerSecond).toBeCloseTo(zoomedIn, 5);
  });
});

describe('Jump to end 改鍵到 outputDuration（Task 3 延後項）', () => {
  it('點擊 toolbar 的 Jump to end 會 seek 到 outputDuration，不是主軌總長', () => {
    const doc = projectWithBlackTail(); // total 10, output 15
    seedProject(doc);
    // 正式環境下 Player 掛載時的 doc-echo effect 會把 usePlayback().total 設成
    // outputDuration（Task 3）；這裡不掛載 Player，手動模擬同一件事——否則
    // seek() 會被舊的 usePlayback total（=主軌 totalDuration）clamp 掉，測不出
    // 「Jump to end 的目標换成 output」這件事本身。
    act(() => usePlayback.getState().setTotal(outputDuration(doc)));
    const { container } = render(<Timeline />);
    const btn = container.querySelector<HTMLButtonElement>('button[title="Jump to end"]')!;
    act(() => {
      fireEvent.click(btn);
    });
    expect(usePlayback.getState().time).toBe(outputDuration(doc));
  });
});

describe('teardownDrag 的 playhead clamp 只在非 commit 路徑跑（承接 Task 3 review 裁決）', () => {
  let rafCallbacks: FrameRequestCallback[] = [];

  beforeEach(() => {
    resetStores();
    useView.setState({ pxPerSecond: PPS, snapEnabled: false });
    sent = [];
    rafCallbacks = [];
    vi.spyOn(ws, 'sendCommand').mockImplementation((c: Command) => {
      sent.push(c);
    });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      const idx = id - 1;
      if (idx >= 0 && idx < rafCallbacks.length) rafCallbacks[idx] = () => {};
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function flushRaf() {
    const cbs = rafCallbacks;
    rafCallbacks = [];
    cbs.forEach((cb) => cb(0));
  }

  function chipByText(c: HTMLElement, text: string): HTMLElement {
    const hits = Array.from(c.querySelectorAll('div')).filter((d) =>
      d.textContent?.trim().startsWith(text),
    );
    const el = hits.find((d) => !hits.some((o) => o !== d && d.contains(o)));
    if (!el) throw new Error(`chip not found: ${text}`);
    return el;
  }
  function handles(el: Element): Element[] {
    return Array.from(el.querySelectorAll('.handle'));
  }

  /**
   * 承接 Task 3 review 的裁決：audio overhang 專案（outputDuration=15 > 主軌總長 10）
   * 下，trim-out 把主軌總長從 10 拉到 12（超過手勢開始時 committed 的 total=10，
   * scheduleFollow 因此墊高 usePlayback.total 到 12、playhead 跟到 12）。放手 commit
   * 時，`gestureOrigTotal` 記錄的手勢起點值是 10（trim-out 拖曳開始時 usePlayback
   * 的 committed total，此時還沒被黑尾邏輯改到 15——這正是 Task 3 review 抓到的
   * 情境：舊行為在這裡把 total 還原成 10、且對 `time=12` 做 `time > restoredTotal`
   * clamp，會把 playhead 從 12 夾回 10，畫面上看起來像瞬間倒退，直到隨後的 doc
   * echo（Player 的 outputDuration effect）把 total 重新推回 12/15 才恢復——這一次
   * WS round-trip之間的閃回正是要修的 bug。commit 路徑上這個 clamp 不該跑。
   */
  it('audio overhang + trim-out commit：放手後 playhead 不被夾回舊 total（不閃回）', () => {
    const doc = projectWithBlackTail(); // 主軌總長 10，outputDuration 15（audio a1 撐到 15）
    seedProject(doc);
    expect(usePlayback.getState().total).toBe(10); // 尚未經過 Player 的 doc-echo（此測試不掛載 Player）

    const { container } = render(<Timeline />);
    // 這個專案的 outputDuration（15）與 STUB_CLIENT_WIDTH（472）搭配算出的動態
    // fit pps 不是整數——掛載時的自動 fit 已經套用過一次，這裡再顯式覆蓋回整數的
    // PPS，讓下面的像素位移換算保持可讀（40px/s，同檔案其餘測試的慣例）。
    act(() => {
      useView.setState({ pxPerSecond: PPS, snapEnabled: false });
    });
    const [, right] = handles(chipByText(container, 'clip two')); // c2 起點=6 duration=4 右緣=10
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // +2s：c2 duration 4→6，右緣 6+6=12，超過 committed total=10 → scheduleFollow 墊高 total
      fireEvent.pointerMove(right!, { clientX: 180, pointerId: 1, bubbles: true });
    });
    act(() => flushRaf());
    expect(usePlayback.getState().total).toBe(12);
    expect(usePlayback.getState().time).toBe(12); // playhead 追到墊高後的邊

    act(() => {
      fireEvent.pointerUp(right!, { clientX: 180, pointerId: 1, bubbles: true });
    });

    // commit 路徑：確實送出了 updateClip（Plan 14 Task 4：trim-out 也帶 leadPad，
    // 這裡是 trim-out 手勢、preview.leadPad 沿用 onTrimStart 灌進去的原值＝0）。
    expect(sent).toEqual([
      { name: 'updateClip', clipId: 'c2', patch: { in: 0, duration: 6, leadPad: 0 } },
    ]);
    // total 一樣會還原（保底，隨後由 doc echo 覆寫，這部分行為不變）……
    expect(usePlayback.getState().total).toBe(10);
    // ……但 playhead **不能**在放手當下被夾回 10——這正是要修的 bug：commit 路徑上
    // 不該跑「time > restoredTotal → seek(restoredTotal)」那段 clamp。
    expect(usePlayback.getState().time).toBe(12);
  });

  /** 對照組：pointercancel（不 commit）維持既有行為——playhead 仍會被夾回。 */
  it('pointercancel（不 commit）：playhead 仍會被夾回手勢開始時的 total（既有行為不變，final-review Fix 1）', () => {
    seedProject(); // 主軌總長 10（無黑尾也適用，沿用既有 pinned 測試的專案）
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'clip two'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 180, pointerId: 1, bubbles: true }); // 墊高 total 到 12
    });
    act(() => flushRaf());
    expect(usePlayback.getState().time).toBe(12);

    act(() => {
      fireEvent.pointerCancel(right!, { clientX: 180, pointerId: 1, bubbles: true });
    });

    expect(sent).toEqual([]); // 不 commit
    expect(usePlayback.getState().total).toBe(10);
    expect(usePlayback.getState().time).toBe(10); // 沒有 echo 兜底，必須被夾回
  });
});
