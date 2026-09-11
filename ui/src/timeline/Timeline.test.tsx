import { describe, it, expect, beforeEach, beforeAll, vi, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import type { Command } from '@vidcut/shared';
import { Timeline } from './Timeline.js';
import { useSelection } from '../stores/selection.js';
import { useView } from '../stores/view.js';
import { useProject } from '../stores/project.js';
import { usePlayback } from '../stores/playback.js';
import * as ws from '../ws.js';
import { demoProject, seedProject, resetStores } from '../test/fixtures.js';

/**
 * 拖曳測試的座標換算：測試把 pxPerSecond 固定為 40，所以 1 秒 = 40px。
 * jsdom 沒有版面，getBoundingClientRect 一律回 0——絕對時間軌的拖曳只看
 * 「位移量」（clientX 差），不受影響；主軌重排序需要 rect，另以 stub 提供。
 *
 * Plan 9 Task 2 之後 Timeline 掛載會自動 fit 一次（範圍裁決 #4a：專案載入 → fit），
 * 讀的是 scroll 容器的 `clientWidth`——jsdom 沒有版面，這個值恆為 0，若不 stub，
 * 掛載時的自動 fit 會把 pxPerSecond 夾到動態下限（≈0），蓋掉這裡假設的 40。
 * `demoProject()` 總長固定 10s，反推 clientWidth=472 能讓 `(472-32-40)/10=40`，
 * 剛好落在這份測試原本假設的 PPS 上——GUTTER_W/FIT_PADDING_PX 見 scale.ts/Timeline.tsx。
 */
const PPS = 40;
const sec = (px: number) => px / PPS;
const STUB_CLIENT_WIDTH = 472;

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return STUB_CLIENT_WIDTH;
    },
  });
});

let sent: Command[];

/** 對某元素跑完整的 pointerdown → move → up 序列。 */
function drag(el: Element, fromX: number, toX: number) {
  act(() => {
    fireEvent.pointerDown(el, { clientX: fromX, pointerId: 1, bubbles: true });
  });
  act(() => {
    fireEvent.pointerMove(el, { clientX: toX, pointerId: 1, bubbles: true });
  });
  act(() => {
    fireEvent.pointerUp(el, { clientX: toX, pointerId: 1, bubbles: true });
  });
}

/**
 * 依顯示文字取 chip。軌道容器的 textContent 也會以同一段文字開頭，
 * 而 querySelectorAll 是文件順序（祖先先出現）——所以必須取**最深**的那個，
 * 否則抓到的是整條軌道而不是單一 chip。
 */
function chipByText(c: HTMLElement, text: string): HTMLElement {
  const hits = Array.from(c.querySelectorAll('div')).filter((d) =>
    d.textContent?.trim().startsWith(text),
  );
  const el = hits.find((d) => !hits.some((o) => o !== d && d.contains(o)));
  if (!el) throw new Error(`chip not found: ${text}`);
  return el;
}

/** 元素上的 trim 把手（左/右各一個，class=handle）。 */
function handles(el: Element): Element[] {
  return Array.from(el.querySelectorAll('.handle'));
}

describe('Timeline drags', () => {
  beforeEach(() => {
    resetStores();
    useView.setState({ pxPerSecond: PPS, snapEnabled: false });
    seedProject();
    sent = [];
    vi.spyOn(ws, 'sendCommand').mockImplementation((c: Command) => {
      sent.push(c);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders nothing without a project', () => {
    useProject.setState({ doc: null });
    const { container } = render(<Timeline />);
    expect(container.firstChild).toBeNull();
  });

  it('caption drag shifts start by the pointer delta', () => {
    const { container } = render(<Timeline />);
    // cap1 start=1；往右拖 80px = +2s → start 3
    drag(chipByText(container, 'first line'), 100, 180);
    expect(sent).toEqual([{ name: 'updateCaption', id: 'cap1', patch: { start: 3, duration: 3 } }]);
  });

  it('caption trim-out changes duration, leaving start put', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'first line'));
    drag(right!, 100, 140); // +1s
    expect(sent).toEqual([{ name: 'updateCaption', id: 'cap1', patch: { start: 1, duration: 4 } }]);
  });

  it('caption trim-in moves start while the right edge stays fixed', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'first line'));
    drag(left!, 100, 140); // start 1→2，右緣仍在 4 → duration 2
    expect(sent).toEqual([{ name: 'updateCaption', id: 'cap1', patch: { start: 2, duration: 2 } }]);
  });

  it('caption drag clamps at the timeline start (never negative)', () => {
    const { container } = render(<Timeline />);
    drag(chipByText(container, 'first line'), 100, 0); // 想拖到 -1.5s
    expect(sent[0]).toMatchObject({ patch: { start: 0 } });
  });

  it('audio drag shifts start, leaving in/duration alone', () => {
    const { container } = render(<Timeline />);
    drag(chipByText(container, 'bgm'), 100, 140); // a1 start 2 → 3
    expect(sent).toEqual([
      { name: 'updateAudio', id: 'a1', patch: { start: 3, in: 1, duration: 5 } },
    ]);
  });

  it('audio trim-in moves start, source in, and duration together', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'bgm'));
    drag(left!, 100, 120); // +0.5s：start 2→2.5、in 1→1.5、duration 5→4.5
    expect(sent).toEqual([
      { name: 'updateAudio', id: 'a1', patch: { start: 2.5, in: 1.5, duration: 4.5 } },
    ]);
  });

  it('a second drag starts from the pending position, not the stale doc', () => {
    // pending 覆蓋不只是畫面：再拖一次必須以「上次放手的位置」為原點，
    // 否則連續兩次拖曳會把第一次的位移吃掉。
    const { container } = render(<Timeline />);
    drag(chipByText(container, 'bgm'), 100, 140); // start 2 → 3（doc 尚未更新）
    sent.length = 0;
    drag(chipByText(container, 'bgm'), 100, 140); // 再 +1s → 4，而不是回到 3
    expect(sent).toEqual([
      { name: 'updateAudio', id: 'a1', patch: { start: 4, in: 1, duration: 5 } },
    ]);
  });

  it('absolute overlay drag sends a new start', () => {
    const { container } = render(<Timeline />);
    drag(chipByText(container, 'title.png'), 100, 180); // start 1 → 3
    expect(sent).toEqual([{ name: 'updateOverlay', id: 'ovAbs', patch: { start: 3 } }]);
  });

  it('marks only the anchored overlay chip with the anchor icon', () => {
    // 舊斷言靠 chip 文字裡的 📎 定位；圖示化之後標記不再是文字，改斷圖示本身。
    const { container } = render(<Timeline />);
    expect(
      chipByText(container, 'badge.png').querySelector('[aria-label="anchored"]'),
    ).not.toBeNull();
    expect(chipByText(container, 'title.png').querySelector('[aria-label="anchored"]')).toBeNull();
  });

  it('anchored overlay drag sends an offset, not an absolute start', () => {
    const { container } = render(<Timeline />);
    // ovAnchor 錨在 c2（起點 6s），offset .5 → 絕對 6.5s；往右 40px = +1s → offset 1.5
    drag(chipByText(container, 'badge.png'), 100, 140);
    expect(sent).toEqual([
      { name: 'updateOverlay', id: 'ovAnchor', patch: { anchor: { clipId: 'c2', offset: 1.5 } } },
    ]);
  });

  it('anchored overlay can be dragged before its clip start (negative offset)', () => {
    const { container } = render(<Timeline />);
    // ovAnchor 錨在 c2（起點 6s），offset .5 → 絕對 6.5s；往左 80px = -2s → offset -1.5
    drag(chipByText(container, 'badge.png'), 100, 20);
    expect(sent).toEqual([
      { name: 'updateOverlay', id: 'ovAnchor', patch: { anchor: { clipId: 'c2', offset: -1.5 } } },
    ]);
  });

  it('keeps a backward-dragged anchored overlay at its released position until the server echoes', () => {
    // 放手時的 pending 必須跟拖曳中的 preview 同值，否則 chip 會先跟手、放手瞬間彈走
    const { container } = render(<Timeline />);
    drag(chipByText(container, 'badge.png'), 100, 20); // 絕對 6.5s → 4.5s
    expect(chipByText(container, 'badge.png').style.left).toBe(`${4.5 * PPS}px`);
  });

  /**
   * Plan 11 Task 1（裁決 4）：overlay 補上與 caption chip 同款的 trim 把手，
   * 拖曳純函數沿用既有的 trimSpanIn/trimSpanOut；anchor 模式的 offset 換算
   * 沿用現行 move 路徑（見上面 `anchored overlay drag sends an offset` 那組）。
   */
  describe('overlay trim handles (Plan 11 Task 1，裁決 4)', () => {
    it('overlay chip has two trim handles (same idiom as caption chip)', () => {
      const { container } = render(<Timeline />);
      expect(handles(chipByText(container, 'title.png'))).toHaveLength(2);
    });

    it('overlay in-handle trim moves start, keeps the right edge fixed', () => {
      const { container } = render(<Timeline />);
      // ovAbs: start=1 duration=3（右緣 4）；in 把手 +1s → start 2, duration 4-2=2
      const [left] = handles(chipByText(container, 'title.png'));
      drag(left!, 100, 140);
      expect(sent).toEqual([
        { name: 'updateOverlay', id: 'ovAbs', patch: { start: 2, duration: 2 } },
      ]);
    });

    it('overlay out-handle trim changes only duration, start stays put', () => {
      const { container } = render(<Timeline />);
      // ovAbs: duration 3 → 4，start 不變
      const [, right] = handles(chipByText(container, 'title.png'));
      drag(right!, 100, 140);
      expect(sent).toEqual([{ name: 'updateOverlay', id: 'ovAbs', patch: { duration: 4 } }]);
    });

    it('anchored overlay in-handle trim re-expresses the new start as an offset (mirrors move)', () => {
      const { container } = render(<Timeline />);
      // ovAnchor：錨在 c2（起點 6s），offset .5 → 絕對 6.5，duration 2（右緣 8.5）
      // in 把手 +1s → 絕對 start 7.5，duration 8.5-7.5=1 → offset = 7.5-6 = 1.5
      const [left] = handles(chipByText(container, 'badge.png'));
      drag(left!, 100, 140);
      expect(sent).toEqual([
        {
          name: 'updateOverlay',
          id: 'ovAnchor',
          patch: { anchor: { clipId: 'c2', offset: 1.5 }, duration: 1 },
        },
      ]);
    });

    it('anchored overlay out-handle trim only sends duration (offset untouched)', () => {
      const { container } = render(<Timeline />);
      // out 把手 +1s → duration 2 → 3，anchor 不變
      const [, right] = handles(chipByText(container, 'badge.png'));
      drag(right!, 100, 140);
      expect(sent).toEqual([{ name: 'updateOverlay', id: 'ovAnchor', patch: { duration: 3 } }]);
    });

    it('a to-end overlay (duration=null) only shows an out-handle behavior that materializes duration', () => {
      // ovToEnd：start=5，duration=null（到片尾，總長 10s → window 5–10）。
      // 拖 out 把手 +1s：從「目前有效 duration」(10-5=5) 出發長成具體的 6。
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
      drag(right!, 100, 140);
      expect(sent).toEqual([{ name: 'updateOverlay', id: 'ovToEnd', patch: { duration: 6 } }]);
    });

    it('a to-end overlay: zero-movement out-handle click sends no command and leaves duration null (review round 1 Critical 2)', () => {
      // 純點擊（pointerdown→move 同座標→pointerup，deltaSec===0）不該把 to-end
      // 材料化——鏡射 in 把手的 null 保護。之前的實作在 deltaSec===0 時仍會算出
      // 一個具體的 effectiveSpan，release guard（preview.span !== orig.span，
      // number !== null）因此誤判成「有變化」而發出 updateOverlay。
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
      drag(right!, 100, 100); // 零位移
      expect(sent).toEqual([]);
      expect(
        useProject.getState().doc!.tracks.overlays.find((o) => o.id === 'ovToEnd')!.duration,
      ).toBeNull();
    });

    it('a to-end overlay in-handle drag works normally and does not materialize duration', () => {
      // in 把手只動 start，null duration 不受影響（「to end」語意仍是到片尾）
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
      const [left] = handles(chipByText(container, 'lower.png'));
      drag(left!, 100, 140); // start 5 → 6
      expect(sent).toEqual([{ name: 'updateOverlay', id: 'ovToEnd', patch: { start: 6 } }]);
    });
  });

  it('clip trim-out sends updateClip with the new duration', () => {
    const { container } = render(<Timeline />);
    const clip = chipByText(container, 'clip one');
    const [, right] = handles(clip);
    drag(right!, 100, 140); // c1 duration 6 → 7
    expect(sent).toEqual([{ name: 'updateClip', clipId: 'c1', patch: { in: 2, duration: 7 } }]);
  });

  it('a drag that does not move sends no command', () => {
    const { container } = render(<Timeline />);
    drag(chipByText(container, 'first line'), 100, 100);
    expect(sent).toEqual([]);
  });

  it('keeps the dragged caption at its released position until the server echoes', () => {
    // 「放手閃回原位」的回歸盔甲：pointerup 後 doc 還是舊值，
    // pending 覆蓋必須讓 chip 留在新位置。
    const { container } = render(<Timeline />);
    const chip = chipByText(container, 'first line');
    drag(chip, 100, 180); // start 1 → 3
    // doc 完全沒更新（server 尚未回 patch）
    expect(useProject.getState().doc!.tracks.captions[0]!.start).toBe(1);
    // 但畫面已在 3s 的位置
    expect(chipByText(container, 'first line').style.left).toBe(`${3 * PPS}px`);
  });

  it('releases the pending override once the doc matches', () => {
    const { container } = render(<Timeline />);
    drag(chipByText(container, 'first line'), 100, 180);

    const next = demoProject();
    next.tracks.captions[0] = { ...next.tracks.captions[0]!, start: 3 };
    act(() => {
      seedProject(next, 2);
    });
    expect(chipByText(container, 'first line').style.left).toBe(`${3 * PPS}px`);
  });

  it('snapping is off by default in these tests but pulls to whole seconds when on', () => {
    useView.setState({ snapEnabled: true });
    const { container } = render(<Timeline />);
    // 拖 +1.9s（76px）→ 吸到整秒 3
    drag(chipByText(container, 'first line'), 100, 176);
    expect(sent[0]).toMatchObject({ patch: { start: 3 } });
  });

  it('selects the item that was pressed', () => {
    const { container } = render(<Timeline />);
    act(() => {
      fireEvent.pointerDown(chipByText(container, 'bgm'), { clientX: 10, pointerId: 1 });
    });
    expect(useSelection.getState().selected).toEqual({ kind: 'audio', id: 'a1' });
  });

  /**
   * 取消選取的第二條路徑（agent-presence 階段 4 的工項 0）。
   * 只有**明確標成空白**的層才清（`data-tl-blank`）：軌道內容層與四條軌道的空處。
   * clip/chip/ruler/把手都不帶那個標記，所以既有的選取與 seek 行為一格都沒動。
   */
  describe('blank-area deselect', () => {
    const blanks = (c: HTMLElement) => Array.from(c.querySelectorAll('[data-tl-blank]'));

    it('clicking an empty track row clears the selection', () => {
      const { container } = render(<Timeline />);
      act(() => {
        useSelection.getState().select({ kind: 'clip', id: 'c1' });
      });
      const rows = blanks(container);
      expect(rows.length).toBeGreaterThan(0);
      act(() => {
        fireEvent.click(rows[rows.length - 1]!, { clientX: 500 });
      });
      expect(useSelection.getState().selected).toBeNull();
    });

    it('every blank layer clears it (content well and each track row)', () => {
      const { container } = render(<Timeline />);
      for (const el of blanks(container)) {
        act(() => {
          useSelection.getState().select({ kind: 'clip', id: 'c1' });
        });
        act(() => {
          fireEvent.click(el, { clientX: 500 });
        });
        expect(useSelection.getState().selected).toBeNull();
      }
    });

    it('clicking a clip still selects it (a chip click must not bubble into a deselect)', () => {
      const { container } = render(<Timeline />);
      act(() => {
        fireEvent.pointerDown(chipByText(container, 'bgm'), { clientX: 10, pointerId: 1 });
      });
      act(() => {
        fireEvent.click(chipByText(container, 'bgm'), { clientX: 10, bubbles: true });
      });
      expect(useSelection.getState().selected).toEqual({ kind: 'audio', id: 'a1' });
    });

    it('the ruler is not a blank layer (its click is a seek, and it must keep the selection)', () => {
      const { container } = render(<Timeline />);
      const ruler = container.querySelector('[style*="cursor: text"]')!;
      expect(ruler.hasAttribute('data-tl-blank')).toBe(false);
      act(() => {
        useSelection.getState().select({ kind: 'clip', id: 'c1' });
      });
      act(() => {
        fireEvent.click(ruler, { clientX: 4 * PPS, bubbles: true });
      });
      expect(usePlayback.getState().time).toBe(4);
      expect(useSelection.getState().selected).toEqual({ kind: 'clip', id: 'c1' });
    });

    it('a drag that ends on blank space keeps the selection (drop is not a deselect)', () => {
      // chip 拖曳的 pointerup 之後瀏覽器仍會補一發 click；若那發 click 落在空白層上
      // （拖到軌道空處放手就是這種情況），選取不能被自己的拖曳清掉。
      const { container } = render(<Timeline />);
      const chip = chipByText(container, 'bgm');
      drag(chip, 100, 140);
      expect(useSelection.getState().selected).toEqual({ kind: 'audio', id: 'a1' });
    });
  });

  it('ruler click seeks the playhead', () => {
    const { container } = render(<Timeline />);
    const ruler = container.querySelector('[style*="cursor: text"]')!;
    act(() => {
      fireEvent.click(ruler, { clientX: 4 * PPS });
    });
    // jsdom 的 rect.left = 0，故 clientX 直接換算成秒
    expect(sec(4 * PPS)).toBe(4);
  });

  it('Toolbar 的 Text 鈕在 playhead 加一個文字 overlay 並選取它', () => {
    usePlayback.getState().seek(2);
    const { container } = render(<Timeline />);
    const btn = container.querySelector<HTMLButtonElement>(
      'button[title="Add a text overlay at playhead"]',
    )!;
    act(() => {
      fireEvent.click(btn);
    });
    expect(sent).toHaveLength(1);
    const cmd = sent[0] as Extract<Command, { name: 'addOverlay' }>;
    expect(cmd.name).toBe('addOverlay');
    expect(cmd.overlay.text).toMatchObject({ text: 'New text' });
    expect(cmd.overlay.start).toBe(2);
    expect(useSelection.getState().selected).toEqual({ kind: 'overlay', id: cmd.overlay.id });
  });
});

/**
 * Plan 11 Task 1（裁決 3a）：選取項把手常駐可見——四種軌道（caption/audio/overlay）
 * 都靠同一個 `selected` class 觸發（.handle 規則共用，theme.css）。ClipBlock 已有
 * 專門的單元測試（見 ClipBlock.test.tsx），這裡只補 Timeline 層級把 `selected` 狀態
 * 正確轉成 caption/audio/overlay chip 的 class 這件事——回歸盔甲，避免漏了某一種軌道。
 */
describe('Timeline 選取項把手常駐 class（Plan 11 Task 1）', () => {
  beforeEach(() => {
    resetStores();
    useView.setState({ pxPerSecond: PPS, snapEnabled: false });
    seedProject();
    sent = [];
    vi.spyOn(ws, 'sendCommand').mockImplementation((c: Command) => {
      sent.push(c);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('未選取的 caption/audio/overlay chip 都沒有 selected class', () => {
    const { container } = render(<Timeline />);
    expect(chipByText(container, 'first line').className.split(' ')).not.toContain('selected');
    expect(chipByText(container, 'bgm').className.split(' ')).not.toContain('selected');
    expect(chipByText(container, 'title.png').className.split(' ')).not.toContain('selected');
  });

  it('選取 caption chip 後帶 selected class，其餘不受影響', () => {
    const { container } = render(<Timeline />);
    act(() => {
      useSelection.getState().select({ kind: 'caption', id: 'cap1' });
    });
    expect(chipByText(container, 'first line').className.split(' ')).toContain('selected');
    expect(chipByText(container, 'bgm').className.split(' ')).not.toContain('selected');
  });

  it('選取 audio chip 後帶 selected class', () => {
    const { container } = render(<Timeline />);
    act(() => {
      useSelection.getState().select({ kind: 'audio', id: 'a1' });
    });
    expect(chipByText(container, 'bgm').className.split(' ')).toContain('selected');
  });

  it('選取 overlay chip 後帶 selected class', () => {
    const { container } = render(<Timeline />);
    act(() => {
      useSelection.getState().select({ kind: 'overlay', id: 'ovAbs' });
    });
    expect(chipByText(container, 'title.png').className.split(' ')).toContain('selected');
  });
});
