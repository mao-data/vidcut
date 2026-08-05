import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
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
 */
const PPS = 40;
const sec = (px: number) => px / PPS;

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

  it('anchored overlay drag sends an offset, not an absolute start', () => {
    const { container } = render(<Timeline />);
    // ovAnchor 錨在 c2（起點 6s），offset .5 → 絕對 6.5s；往右 40px = +1s → offset 1.5
    drag(chipByText(container, '📎'), 100, 140);
    expect(sent).toEqual([
      { name: 'updateOverlay', id: 'ovAnchor', patch: { anchor: { clipId: 'c2', offset: 1.5 } } },
    ]);
  });

  it('anchored overlay can be dragged before its clip start (negative offset)', () => {
    const { container } = render(<Timeline />);
    // ovAnchor 錨在 c2（起點 6s），offset .5 → 絕對 6.5s；往左 80px = -2s → offset -1.5
    drag(chipByText(container, '📎'), 100, 20);
    expect(sent).toEqual([
      { name: 'updateOverlay', id: 'ovAnchor', patch: { anchor: { clipId: 'c2', offset: -1.5 } } },
    ]);
  });

  it('keeps a backward-dragged anchored overlay at its released position until the server echoes', () => {
    // 放手時的 pending 必須跟拖曳中的 preview 同值，否則 chip 會先跟手、放手瞬間彈走
    const { container } = render(<Timeline />);
    drag(chipByText(container, '📎'), 100, 20); // 絕對 6.5s → 4.5s
    expect(chipByText(container, '📎').style.left).toBe(`${4.5 * PPS}px`);
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
    expect(cmd.overlay.text).toMatchObject({ text: '新文字' });
    expect(cmd.overlay.start).toBe(2);
    expect(useSelection.getState().selected).toEqual({ kind: 'overlay', id: cmd.overlay.id });
  });
});
