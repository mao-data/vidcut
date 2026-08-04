import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import type { Command } from '@vidcut/shared';
import { Player } from './Player.js';
import { usePlayback } from '../stores/playback.js';
import { useProject } from '../stores/project.js';
import { demoProject, seedProject, resetStores, captureCommands } from '../test/fixtures.js';
import * as ws from '../ws.js';
import { dragOverlay, dragCaption } from './dragLayer.js';

/** 把 playhead 移到 t（走真正的 store action）。 */
function seek(t: number) {
  act(() => {
    usePlayback.getState().seek(t);
  });
}
function play() {
  act(() => {
    usePlayback.getState().play();
  });
}

function audioEls(c: HTMLElement): HTMLAudioElement[] {
  return Array.from(c.querySelectorAll('audio'));
}
function videoEls(c: HTMLElement): HTMLVideoElement[] {
  return Array.from(c.querySelectorAll('video'));
}

/**
 * 逐元素 spy。play/pause 的預設 stub 掛在 prototype 上（jsdom 未實作），
 * 是所有媒體元素共用的——要判斷「這一個元素有沒有被播」必須遮蔽成實例屬性，
 * 否則 video 的呼叫會被算到 audio 頭上。
 */
function watch(el: HTMLMediaElement) {
  return { play: vi.spyOn(el, 'play'), pause: vi.spyOn(el, 'pause') };
}

describe('Player', () => {
  // ResizeObserver 的 jsdom polyfill 在 src/test/setup.ts 全域補（量 stage 寬要用）。
  beforeEach(() => {
    resetStores();
    seedProject();
  });

  it('renders nothing until a project arrives', () => {
    useProject.setState({ doc: null });
    const { container } = render(<Player />);
    expect(container.querySelector('video')).toBeNull();
  });

  it('mounts one <audio> per audio item, pointing at that media', () => {
    const { container } = render(<Player />);
    const els = audioEls(container);
    expect(els).toHaveLength(1);
    // a1 用 m2，m2 有 proxy → 走 proxy
    expect(els[0]!.getAttribute('src')).toBe('/media/derived/m2/proxy.mp4');
  });

  it('plays an audio item only while the playhead is inside its window', () => {
    const { container } = render(<Player />);
    const spy = watch(audioEls(container)[0]!);
    play();

    // a1 窗 = start 2 → 7
    seek(1); // 窗外
    expect(spy.play).not.toHaveBeenCalled();

    seek(3); // 窗內
    expect(spy.play).toHaveBeenCalled();

    seek(8); // 窗外（尾端）
    expect(spy.pause).toHaveBeenCalled();
  });

  it('sets audio volume from the item volume and fade envelope', () => {
    const doc = demoProject();
    doc.tracks.audio[0] = { ...doc.tracks.audio[0]!, fadeIn: 2, fadeOut: 1 };
    seedProject(doc);
    const { container } = render(<Player />);
    const el = audioEls(container)[0]!;
    play();

    seek(4); // rel=2 → 淡入結束，全音量 0.8
    expect(el.volume).toBeCloseTo(0.8);

    seek(3); // rel=1，fadeIn=2 → 增益 0.5
    expect(el.volume).toBeCloseTo(0.4);

    seek(6.5); // remain=0.5，fadeOut=1 → 增益 0.5
    expect(el.volume).toBeCloseTo(0.4);
  });

  it('mutes the video element when the clip volume is 0 (extract-audio case)', () => {
    const doc = demoProject();
    doc.tracks.video[0] = { ...doc.tracks.video[0]!, volume: 0 };
    seedProject(doc);
    const { container } = render(<Player />);
    play();
    seek(3); // 在 c1 內

    const active = videoEls(container)[0]!;
    expect(active.muted).toBe(true);
  });

  it('ducks the video track while a ducking audio item plays', () => {
    const doc = demoProject();
    doc.tracks.audio[0] = { ...doc.tracks.audio[0]!, ducking: true };
    seedProject(doc);
    const { container } = render(<Player />);
    play();

    const active = videoEls(container)[0]!;
    seek(1); // ducking 項尚未開始 → 原音量
    expect(active.volume).toBeCloseTo(1);

    seek(3); // ducking 中 → 0.25
    expect(active.volume).toBeCloseTo(0.25);
  });

  it('does not play a frozen clip (holds the still frame)', () => {
    const { container } = render(<Player />);
    const spies = videoEls(container).map(watch);
    play();
    seek(7); // c2 = 6–10s，frozen

    const idx = videoEls(container).findIndex((v) => v.style.opacity === '1');
    expect(videoEls(container)[idx]!.muted).toBe(true);
    expect(spies[idx]!.pause).toHaveBeenCalled();
  });

  it('shows overlays and captions only inside their time window', () => {
    const { container } = render(<Player />);

    seek(2); // ovAbs 1–4；cap1 1–4
    expect(container.querySelector('img[src="/media/assets/title.png"]')).not.toBeNull();
    expect(container.textContent).toContain('first line');

    seek(5); // 兩者都出窗；cap2 5–8 進窗
    expect(container.querySelector('img[src="/media/assets/title.png"]')).toBeNull();
    expect(container.textContent).not.toContain('first line');
    expect(container.textContent).toContain('second');
  });

  it('overlay position converts into the 1080×1920 space, not the old percentage space', () => {
    const { container } = render(<Player />);
    seek(2); // ovAbs 窗內, position { x: 0.5, y: 0.1, scale: 1 }
    const img = container.querySelector('img[src="/media/assets/title.png"]') as HTMLImageElement;
    // x 是水平置中點（配 translateX(-50%)）、y 是「頂邊」不是中心——1080/1920 空間裡
    // 這兩者換算方式不對稱，別套同一條公式：left = 1080*x，top = 1920*y（無 -50% 補償）。
    expect(img.style.left).toBe('540px'); // 1080 * 0.5
    expect(img.style.top).toBe('192px'); // 1920 * 0.1
    expect(img.style.maxWidth).toBe('972px'); // 1080 * 0.9（原本的 CSS 90%）
  });

  it('anchored overlays follow their clip (c2 starts at 6s, offset .5)', () => {
    const { container } = render(<Player />);
    seek(6.7); // 6.5–8.5 窗內
    expect(container.querySelector('img[src="/media/assets/badge.png"]')).not.toBeNull();
    seek(6.2); // 窗前
    expect(container.querySelector('img[src="/media/assets/badge.png"]')).toBeNull();
  });

  it('highlights karaoke tokens up to the playhead', () => {
    const { container } = render(<Player />);
    seek(5.5); // 第 1 個 token 進行中
    const spans = Array.from(container.querySelectorAll('span'));
    const second = spans.find((s) => s.textContent === 'second')!;
    const line = spans.find((s) => s.textContent === 'line')!;
    expect(second.style.color).toBe('rgb(251, 191, 36)'); // highlight #fbbf24
    // 未唸到的詞沒有設 inline color——繼承外層 div 的 fill（CaptionLayer 的 ApproxCaption）
    expect(line.style.color).toBe('');
    expect(getComputedStyle(line).color).toBe('rgb(255, 255, 255)');
    // 兩個詞之間的分隔白不是空氣——DOM fallback 要讀成 "second line"，不是黏死的
    // "secondline"（CJK-aware tokenSeparator，和 server/scripts/text_card.py 的
    // separator() 同規則：拉丁字之間留白）。
    expect(second.parentElement!.textContent).toBe('second line');
  });
});

/**
 * 畫布拖曳（Task 15 fix round 1，Finding 3）：pending 覆蓋不只是防「放手閃回原位」，
 * 還修正一個更嚴重的問題——doc 還沒追上拖曳結果前，若立刻再拖同一項一次，第二次的
 * 起點必須讀 pending（上一次放手的結果），不能讀 doc（這時 doc 仍是拖曳前的舊值），
 * 否則連續兩次拖曳會把第一次的位移吃掉（見 Player.tsx 的 pendingRef / setPendingDrag）。
 * ui/src/timeline/Timeline.tsx 已有等價機制與同名測試（"a second drag starts from the
 * pending position, not the stale doc"），這裡把同一種驗證方式搬到畫布拖曳。
 */
describe('Player canvas drag (pending baseline, Finding 3)', () => {
  beforeEach(() => {
    resetStores();
    seedProject();
    // jsdom 沒有真的版面，getBoundingClientRect 預設全 0——畫布拖曳的 delta/bbox 換算
    // 需要真數字，不然除以 scale=0 會炸出 NaN。這裡按元素角色回固定尺寸：
    // stage 容器（無這兩個 data 屬性）回 1080 寬 → scale = 1080/1080 = 1；
    // overlay <img>（data-ov-id）回 400×100，跟 dragLayer.test.ts 的 bbox 案例一致，
    // 方便用同一個純函式當 oracle 交叉驗證；字幕卡外層 div（data-drag-kind="caption"）
    // 回 1080×92，貼近實際字幕卡高度。
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const isOverlay = this.hasAttribute('data-ov-id');
      const isCaption = this.getAttribute('data-drag-kind') === 'caption';
      const w = isOverlay ? 400 : 1080;
      const h = isOverlay ? 100 : isCaption ? 92 : 1920;
      return {
        width: w,
        height: h,
        top: 0,
        left: 0,
        right: w,
        bottom: h,
        x: 0,
        y: 0,
        toJSON() {
          return {};
        },
      } as DOMRect;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  /** pointerdown → move → up（畫布拖曳兩軸都可能變，跟 Timeline.test.tsx 的單軸 drag() 不同）。 */
  function dragXY(el: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
    act(() => {
      fireEvent.pointerDown(el, { clientX: from.x, clientY: from.y, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(el, { clientX: to.x, clientY: to.y, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerUp(el, { clientX: to.x, clientY: to.y, pointerId: 1, bubbles: true });
    });
  }

  it('a second overlay drag starts from the pending position, not the stale doc', () => {
    const sent = captureCommands(ws);
    const { container } = render(<Player />);
    seek(2); // ovAbs 視窗內，position {x:0.5, y:0.1, scale:1}
    const img = container.querySelector('img[src="/media/assets/title.png"]') as HTMLImageElement;

    dragXY(img, { x: 0, y: 0 }, { x: 108, y: -96 });
    expect(sent).toHaveLength(1);
    const first = sent[0] as Extract<Command, { name: 'updateOverlay' }>;
    const firstPos = first.patch.position!;

    // doc 沒有真的更新（測試沒有模擬 server echo）——第二次拖曳理當以 firstPos 為起點
    dragXY(img, { x: 0, y: 0 }, { x: 108, y: -96 });
    expect(sent).toHaveLength(2);
    const second = sent[1] as Extract<Command, { name: 'updateOverlay' }>;
    const secondPos = second.patch.position!;

    // 用 dragLayer 的純函式（已在 dragLayer.test.ts 獨立驗證過）當 oracle：從 pending 值
    // 起算、套同一個位移，算出「正確」該有的結果——不管沿途有沒有觸發吸附都成立。
    const expected = dragOverlay(
      { x: firstPos.x, y: firstPos.y },
      { dx: 108, dy: -96 },
      { w: 400, h: 100 },
      { w: 1080, h: 1920 },
    ).position;
    expect(secondPos.x).toBeCloseTo(expected.x, 3);
    expect(secondPos.y).toBeCloseTo(expected.y, 3);

    // 反例：若第二次拖曳誤用「stale doc」(0.5, 0.1) 當起點，會跟第一次算出一模一樣的
    // 結果——用這個差異證明第二次真的往前走了，不是從頭重拖一次（"閃回"以外的症狀）。
    expect(secondPos).not.toEqual(firstPos);
  });

  it('a second caption drag starts from the pending y, not the stale doc', () => {
    const sent = captureCommands(ws);
    const { container } = render(<Player />);
    seek(2); // cap1 視窗內，style.y = 0.8
    const cap = container.querySelector('[data-drag-kind="caption"]') as HTMLElement;

    dragXY(cap, { x: 0, y: 0 }, { x: 0, y: 60 });
    expect(sent).toHaveLength(1);
    const first = sent[0] as Extract<Command, { name: 'updateCaption' }>;
    const firstY = first.patch.style!.y;

    dragXY(cap, { x: 0, y: 0 }, { x: 0, y: 60 });
    expect(sent).toHaveLength(2);
    const second = sent[1] as Extract<Command, { name: 'updateCaption' }>;
    const secondY = second.patch.style!.y;

    const expected = dragCaption(firstY, 60, 92, 1920).y;
    expect(secondY).toBeCloseTo(expected, 3);
    expect(secondY).not.toEqual(firstY);
  });
});
