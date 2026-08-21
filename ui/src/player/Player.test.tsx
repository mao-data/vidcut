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

const DRAG_EVENTS = ['pointermove', 'pointerup', 'pointercancel'];
/**
 * 追蹤 Player 掛在 window 上的拖曳監聽，回傳「目前還活著」的 (type, handler) 清單
 * ——addEventListener 進來、removeEventListener 出去（同一個 handler 掛在兩種事件上
 * 要算兩筆，所以不能用 Set<fn>）。手勢的 handler 沒有任何自動清除機制，
 * 洩漏了也不會有看得見的症狀，只能這樣直接量。afterEach 的 restoreAllMocks 會還原 spy。
 */
function trackWindowPointerListeners(): Array<{ type: string; fn: unknown }> {
  const live: Array<{ type: string; fn: unknown }> = [];
  const add = window.addEventListener.bind(window);
  const rm = window.removeEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, fn, opts) => {
    if (DRAG_EVENTS.includes(type) && fn) live.push({ type, fn });
    add(type, fn, opts);
  });
  vi.spyOn(window, 'removeEventListener').mockImplementation((type, fn, opts) => {
    const i = live.findIndex((e) => e.type === type && e.fn === fn);
    if (i >= 0) live.splice(i, 1);
    rm(type, fn, opts);
  });
  return live;
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
    // 不得有寬度夾制：曾經是 `maxWidth: 1080*0.9`（972px），而 render.ts 以原生尺寸合成
    // ——文字卡一律畫布全寬，於是成品每次都比預覽大 1/0.9 ≈ 11%（verify:wysiwyg 量到寬比
    // 0.9011）。預覽必須是原生尺寸，縮放只能由 position.scale 決定。
    expect(img.style.maxWidth).toBe('');
    expect(img.style.transform).toContain('scale(1)'); // position.scale 仍然生效
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
 * blur 背景 video 閘門（Plan 9 Task 4）：背景層曾經比對 `bg.src.endsWith(plan.active.src)`
 * ——src 是 mediaUrl(media) = proxyPath ?? path，proxyPath 由背景 ingest（A2）晚到才補進
 * doc。同一顆 clip 播放中，proxyPath 一到，src 字串換了，背景 video 就重新載入（可見的閃爍/
 * 重新緩衝），即使畫面內容其實沒變。主 A/B video 早就是用 clipId 判斷（mountedClip.current
 * `!==` plan.active.clipId），同一顆 clip 播放中絕不重載——背景層要套同一款身分閘門。
 */
describe('Player blur 背景 video 閘門', () => {
  beforeEach(() => {
    resetStores();
  });

  function withBlurFit(doc: ReturnType<typeof demoProject>) {
    doc.canvas = { ...doc.canvas, fit: 'blur' };
    return doc;
  }

  it('同一顆 clip 播放中，proxyPath 晚到（src 字串換了）：背景 video src 不變', () => {
    const doc = withBlurFit(demoProject());
    seedProject(doc, 1);
    const { container } = render(<Player />);
    seek(2); // c1（m1）窗內，觸發背景層首次掛載

    const bg = container.querySelectorAll('video')[0]!;
    const before = bg.getAttribute('src');
    expect(before).toContain('m1'); // 前提成立：背景層確實對到 m1 的來源

    // 背景 ingest（A2）晚到：同一顆 media（m1）補上 proxyPath，src 字串因此改變，
    // 但 clip 身分（c1）沒有變——這正是曾經觸發跳動重載的情境。
    const patched = demoProject();
    patched.canvas = { ...patched.canvas, fit: 'blur' };
    patched.media[0] = { ...patched.media[0]!, proxyPath: 'derived/m1/proxy2.mp4' };
    act(() => {
      seedProject(patched, 2);
    });
    seek(2.1); // 同一顆 clip 內小幅推進，觸發 effect 重跑

    expect(bg.getAttribute('src')).toBe(before); // 不得重載
  });

  it('切到不同 clip：背景 video src 照樣更新', () => {
    const doc = withBlurFit(demoProject());
    seedProject(doc, 1);
    const { container } = render(<Player />);
    seek(2); // c1（m1）；plan.next=c2 會被無條件 premount 進 spare（與 playing 無關）

    const bg = container.querySelectorAll('video')[0]!;
    const before = bg.getAttribute('src');
    expect(before).toContain('m1');

    seek(7); // c2（m2，frozen）—— 不同 clip。因為 c2 已 premount 進 spare，主 A/B
    // video 這一輪 effect 走的是「交換可見性」early return（不重載，見 Player.tsx
    // 240–248），bg 區塊要下一輪 effect 才會跑——這裡再推進一次時間，模擬播放中
    // 持續有 tick 觸發 effect 的真實情況（同一 clip 內的小幅位移即可，不需要真的播放）。
    seek(7.01);
    expect(bg.getAttribute('src')).not.toBe(before);
    expect(bg.getAttribute('src')).toContain('m2');
  });
});

/**
 * trimPreview 即時首幀覆蓋（Plan 12 Task 2，裁決 3）：controller pre-flight 點名的
 * 陷阱——trim-in 拖曳中 seek 的時間（playhead）不變，只有 override in 在變。
 * 若 Player 只在 time/doc 變化時重算映射，畫面在整個拖曳過程都不會動。
 * 這裡繞過 Timeline 的 rAF 節流，直接操作 usePlayback.trimPreview（Timeline 自己的
 * 節流時機已由 Timeline.trimFollow.test.tsx 覆蓋），驗證 Player 這一端真的會反應。
 */
describe('Player trimPreview 即時反應（Plan 12 Task 2，裁決 3）', () => {
  beforeEach(() => {
    resetStores();
  });

  it('同一個 seek 時間下，trimPreview.in 改變會讓 A/B video 的 currentTime 跟著變', () => {
    const doc = demoProject();
    seedProject(doc);
    const { container } = render(<Player />);
    seek(3); // c1 內（in=2, duration=6）：offset=3

    const active = videoEls(container)[0]!;
    act(() => {
      usePlayback.getState().setTrimPreview({ clipId: 'c1', in: 4 });
    });
    const firstTime = active.currentTime;
    expect(firstTime).toBeCloseTo(7); // 4 + offset 3

    // playhead（seek 的 t）完全沒動，只換 override in——第二個值必須不同於第一個
    act(() => {
      usePlayback.getState().setTrimPreview({ clipId: 'c1', in: 6 });
    });
    const secondTime = active.currentTime;
    expect(secondTime).toBeCloseTo(9); // 6 + offset 3
    expect(secondTime).not.toBe(firstTime);
  });

  it('blur 背景 video 也吃 trimPreview override（與 A/B 主 video 同一個 plan.active.sourceTime）', () => {
    const doc = demoProject();
    doc.canvas = { ...doc.canvas, fit: 'blur' };
    seedProject(doc);
    const { container } = render(<Player />);
    seek(3);

    const bg = container.querySelectorAll('video')[0]!; // blur 模式下 bg 是第一顆掛載的 video
    act(() => {
      usePlayback.getState().setTrimPreview({ clipId: 'c1', in: 4 });
    });
    expect(bg.currentTime).toBeCloseTo(7);
  });

  it('trimPreview.clipId 指向非目前 active clip：A/B video 不受影響（維持用 doc 的 in）', () => {
    const doc = demoProject();
    seedProject(doc);
    const { container } = render(<Player />);
    seek(3); // active 是 c1，非 c2

    const active = videoEls(container)[0]!;
    const before = active.currentTime;
    act(() => {
      usePlayback.getState().setTrimPreview({ clipId: 'c2', in: 99 });
    });
    expect(active.currentTime).toBe(before);
  });

  it('trimPreview 清回 null：映射退回 doc 的 committed in（放手/取消後的行為）', () => {
    const doc = demoProject();
    seedProject(doc);
    const { container } = render(<Player />);
    seek(3);

    const active = videoEls(container)[0]!;
    act(() => {
      usePlayback.getState().setTrimPreview({ clipId: 'c1', in: 4 });
    });
    expect(active.currentTime).toBeCloseTo(7);

    act(() => {
      usePlayback.getState().setTrimPreview(null);
    });
    expect(active.currentTime).toBeCloseTo(5); // 退回 doc 的 in=2 + offset 3
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

  /**
   * pointerdown → move → up（畫布拖曳兩軸都可能變，跟 Timeline.test.tsx 的單軸 drag() 不同）。
   * `buttons: 1` 是必要的、不是裝飾：真瀏覽器拖曳中的 pointermove 一定帶著按下的鍵，
   * Player 用 `buttons === 0` 判斷「按鍵在我們看不到的地方放開了」而當場收尾（見 beginDrag）。
   * 少了它，這裡合成的事件會被當成「已經放手」，第一次 move 就把手勢收掉——這種假象會很大聲
   * （命令一個都不會送、斷言直接掛），不會靜靜地讓測試通過。
   */
  function dragXY(el: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
    act(() => {
      fireEvent.pointerDown(el, {
        clientX: from.x,
        clientY: from.y,
        pointerId: 1,
        buttons: 1,
        bubbles: true,
      });
    });
    act(() => {
      fireEvent.pointerMove(el, {
        clientX: to.x,
        clientY: to.y,
        pointerId: 1,
        buttons: 1,
        bubbles: true,
      });
    });
    act(() => {
      fireEvent.pointerUp(el, { clientX: to.x, clientY: to.y, pointerId: 1, bubbles: true });
    });
  }

  /**
   * 拆開的單步事件（新的收尾測試需要在手勢中途插入別的動作，dragXY 的一氣呵成不夠用）。
   * `pointerId` 可指定：多點觸控的測試要能發「另一根手指」的事件（預設 1＝滑鼠/第一根手指）。
   */
  function down(el: Element, x: number, y: number, pointerId = 1) {
    act(() => {
      fireEvent.pointerDown(el, {
        clientX: x,
        clientY: y,
        pointerId,
        buttons: 1,
        bubbles: true,
      });
    });
  }
  function move(
    el: Element | Window,
    x: number,
    y: number,
    opts: { buttons?: number; pointerId?: number } = {},
  ) {
    const { buttons = 1, pointerId = 1 } = opts;
    act(() => {
      fireEvent.pointerMove(el, { clientX: x, clientY: y, pointerId, buttons, bubbles: true });
    });
  }
  function up(el: Element | Window, x: number, y: number, pointerId = 1) {
    act(() => {
      fireEvent.pointerUp(el, { clientX: x, clientY: y, pointerId, bubbles: true });
    });
  }

  /** 目前畫面上那句 `text` 字幕的 y（0–1 空間）；不在畫面上時 null。 */
  function shownCaptionY(container: HTMLElement, text: string): number | null {
    const el = Array.from(container.querySelectorAll('[data-drag-kind="caption"]')).find((d) =>
      d.textContent?.includes(text),
    ) as HTMLElement | undefined;
    // 命中框（data-drag-kind）與定位層不一定是同一個 div：字卡路徑是同一個，DOM 近似
    // 路徑分成兩層（外層負責 top + 全寬置中，內層 inline-block 收縮到文字才是命中框——
    // 全寬的透明帶子會吃掉底下 overlay 的 pointer 事件，見 CaptionLayer 的 inkStyle）。
    // 往上找第一個有 top 的祖先，兩種結構都對。
    let n: HTMLElement | null = el ?? null;
    while (n && !n.style.top) n = n.parentElement;
    return n ? parseFloat(n.style.top) / 1920 : null;
  }
  /** 吸附導線的 DOM：1080 空間內 2px 粗的線（x 導線 width:2、y 導線 height:2）。 */
  function guideEls(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll('div')).filter(
      (d) => d.style.width === '2px' || d.style.height === '2px',
    );
  }
  const titleImg = (c: HTMLElement) =>
    c.querySelector('img[src="/media/assets/title.png"]') as HTMLImageElement | null;

  /**
   * 「盲拖」——本輪 review 抓到的主 bug。
   *
   * dragOverride 是在 plan.captions/plan.overlays 的 .map() 裡套的：項目一旦離開時間窗就不在
   * plan 裡，覆寫沒有東西可套，**畫面停住**；但掛在 window 上的 pointermove 照樣更新 d.last，
   * 放手就把一個使用者從沒看過的位置送進文件（實測：畫面停在 0.8208、送出 0.9521，
   * 1080 空間差 250px）。修法是「拖曳中的項目豁免時間窗過濾」（見 Player.tsx 的 withDragged）。
   *
   * 這個測試釘的是與修法無關的不變量：**送出的值＝畫面最後顯示的值**。
   * 換成另一種修法（凍結 d.last）也該通過；只有「畫面停住、d.last 繼續跑」會掛。
   */
  it('播放中拖字幕、拖到一半離開時間窗：畫面持續跟著手指，送出的＝畫面最後顯示的（不盲拖）', () => {
    const sent = captureCommands(ws);
    const { container } = render(<Player />);
    seek(2); // cap1 窗 1–4s，style.y = 0.8
    const cap = container.querySelector('[data-drag-kind="caption"]') as HTMLElement;
    down(cap, 0, 0);
    move(cap, 0, 40);
    const seen = shownCaptionY(container, 'first');
    expect(seen).toBeCloseTo(dragCaption(0.8, 40, 92, 1920).y, 4); // ≈0.8208

    seek(5); // 播放推進：cap1 出窗（cap2 進窗）——豁免後它必須還在畫面上
    expect(shownCaptionY(container, 'first')).toBeCloseTo(seen!, 6);

    move(window, 0, 900); // 使用者繼續拖（真瀏覽器裡 pointermove 落在 window 上）
    const last = shownCaptionY(container, 'first');
    expect(last).toBeCloseTo(dragCaption(0.8, 900, 92, 1920).y, 4); // ≈0.9521，畫面真的跟著跑

    up(window, 0, 900);
    const cmd = sent[0] as Extract<Command, { name: 'updateCaption' }>;
    expect(cmd.name).toBe('updateCaption');
    expect(cmd.id).toBe('cap1'); // 送的是被拖的那一句，不是現在畫面上的 cap2
    expect(cmd.patch.style!.y).toBeCloseTo(last!, 3);
    // 手勢結束＝恢復正常過濾：cap1 不該賴在畫面上
    expect(shownCaptionY(container, 'first')).toBeNull();
  });

  it('拖曳中離開時間窗：吸附導線不會變成沒有主人的浮線', () => {
    const { container } = render(<Player />);
    seek(2); // ovAbs 窗 1–4s，x=0.5 → 水平中心吸附一開始就命中
    down(titleImg(container)!, 0, 0);
    move(titleImg(container)!, 0, 40);
    expect(guideEls(container).length).toBeGreaterThan(0); // 前提成立：真的有導線

    seek(5); // 出窗
    // 舊行為：元素消失、導線照畫——畫布上飄著幾條沒有主人的黃線
    expect(titleImg(container)).not.toBeNull();
    expect(guideEls(container).length).toBeGreaterThan(0);

    up(window, 0, 40);
    expect(guideEls(container)).toHaveLength(0); // 收尾一定清乾淨
  });

  /**
   * 拖曳中元素被重新掛載（時間窗以外的卸載路徑：字卡光柵化完成 → ApproxCaption 換成
   * CardCaption，同 key 不同元件型別＝重新掛載）。真瀏覽器實測（CDP 真實輸入 + remove()）
   * 的事件序列是 `el:pointermove → [remove] → win:pointermove →
   * win:lostpointercapture(target=document) → win:pointerup`——元素身上的 pointerup 一次都
   * 沒有出現。所以這裡刻意「不」對著原本那個元素放手（它已經不在 DOM 了，對它發事件也不會
   * 冒泡到任何地方），而是對 window 放手，模擬瀏覽器把後續事件重新命中到游標下元素、
   * 再冒泡上來的真實路徑。時間窗那條路徑已被 withDragged 豁免（見上一個測試），
   * 這條沒有、也不該有——它是「同一個項目換了個畫法」，window 監聽是唯一的兜底。
   */
  it('拖曳中字幕卡重新掛載（原節點消失）：放手仍然把命令送出去', async () => {
    const sent = captureCommands(ws);
    const { container } = render(<Player />);
    seek(2);
    const cap = container.querySelector('[data-drag-kind="caption"]') as HTMLElement;
    down(cap, 0, 0);
    move(cap, 0, 60);

    act(() => {
      useProject
        .getState()
        .applyServerMsg({ type: 'textCards', entries: [{ id: 'cap1', hash: 'h1' }] });
    });
    expect(container.contains(cap)).toBe(false); // 前提成立：拖的那個節點真的不見了

    up(window, 0, 60);
    expect(sent).toHaveLength(1);
    const cmd = sent[0] as Extract<Command, { name: 'updateCaption' }>;
    expect(cmd.name).toBe('updateCaption');
    expect(cmd.id).toBe('cap1');
    expect(cmd.patch.style!.y).toBeCloseTo(dragCaption(0.8, 60, 92, 1920).y, 3);
    await act(async () => {}); // 讓字卡 geometry 的 fetch（404 → fallback）在測試結束前收斂
  });

  it('項目在拖曳中被刪掉：不送命令（送出去也只會被 server 拒絕），本地覆寫不留幻影', () => {
    const sent = captureCommands(ws);
    const { container } = render(<Player />);
    seek(2);
    down(titleImg(container)!, 0, 0);
    move(titleImg(container)!, 108, -96);
    const removed = demoProject();
    removed.tracks.overlays = removed.tracks.overlays.filter((o) => o.id !== 'ovAbs');
    act(() => {
      seedProject(removed, 2);
    });
    expect(titleImg(container)).toBeNull(); // doc 裡沒有了就補不回來，消失是對的
    up(window, 108, -96);
    expect(sent).toHaveLength(0);
  });

  it('拖曳收尾後：本地覆寫不留幻影，之後的 doc 更新蓋得回來', () => {
    const sent = captureCommands(ws);
    const { container } = render(<Player />);
    seek(2); // ovAbs 窗 1–4s
    const img = titleImg(container)!;
    down(img, 0, 0);
    move(img, 108, -96);
    seek(5); // 出窗（拖曳中：豁免過濾，仍看得到）
    up(window, 108, -96);
    expect(sent).toHaveLength(1);
    const pos = (sent[0] as Extract<Command, { name: 'updateOverlay' }>).patch.position!;

    // server echo 回來：doc 追上送出的值 → pending 對帳成功、功成身退
    const echoed = demoProject();
    echoed.tracks.overlays[0] = {
      ...echoed.tracks.overlays[0]!,
      position: { x: pos.x, y: pos.y, scale: 1 },
    };
    act(() => {
      seedProject(echoed, 2);
    });
    // 之後 AI／使用者把它移到別的地方：畫面必須跟著 doc 走。拖曳中的本地覆寫若沒被清掉，
    // 它會永遠贏過 doc（overlaysForRender 的優先序：override > pending > doc），
    // 元素就永久卡在拖曳結束時的座標——伺服器根本不知道存在的幻影。
    const moved = demoProject();
    moved.tracks.overlays[0] = {
      ...moved.tracks.overlays[0]!,
      position: { x: 0.2, y: 0.3, scale: 1 },
    };
    act(() => {
      seedProject(moved, 3);
    });
    seek(2);
    const again = container.querySelector('img[src="/media/assets/title.png"]') as HTMLImageElement;
    expect(again.style.left).toBe('216px'); // 1080 * 0.2
    expect(again.style.top).toBe('576px'); // 1920 * 0.3
  });

  it('pointercancel 中止的拖曳：送出最後預覽到的位置（commit，不是回捲成 doc 舊值）', () => {
    const sent = captureCommands(ws);
    const { container } = render(<Player />);
    seek(2);
    const img = container.querySelector('img[src="/media/assets/title.png"]') as HTMLImageElement;
    down(img, 0, 0);
    move(img, 108, -96);
    // 瀏覽器宣告這根 pointer 不會再有事件了（原生 text-drag 搶走手勢、觸控被判定成捲動…）
    act(() => {
      fireEvent.pointerCancel(img, { pointerId: 1, bubbles: true });
    });

    expect(sent).toHaveLength(1);
    const pos = (sent[0] as Extract<Command, { name: 'updateOverlay' }>).patch.position!;
    const expected = dragOverlay(
      { x: 0.5, y: 0.1 },
      { dx: 108, dy: -96 },
      { w: 400, h: 100 },
      { w: 1080, h: 1920 },
    ).position;
    expect(pos.x).toBeCloseTo(expected.x, 3);
    expect(pos.y).toBeCloseTo(expected.y, 3);
    // 明確釘住 commit 而非 revert：送出的不是 doc 裡的起始值
    expect(pos.x).not.toBeCloseTo(0.5, 3);
  });

  it('按下沒有移動就 pointercancel：不送命令（純點選不污染 undo history）', () => {
    const sent = captureCommands(ws);
    const { container } = render(<Player />);
    seek(2);
    const img = container.querySelector('img[src="/media/assets/title.png"]') as HTMLImageElement;
    down(img, 0, 0);
    act(() => {
      fireEvent.pointerCancel(img, { pointerId: 1, bubbles: true });
    });
    expect(sent).toHaveLength(0);
  });

  it('pointermove 回報按鍵已放開（buttons=0）：當場收尾，不等一個不會來的 pointerup', () => {
    const sent = captureCommands(ws);
    const { container } = render(<Player />);
    seek(2);
    const img = container.querySelector('img[src="/media/assets/title.png"]') as HTMLImageElement;
    down(img, 0, 0);
    move(img, 108, -96);
    // 游標移出瀏覽器視窗才放手：pointerup 從不送達，下一個進得來的事件已經沒有按鍵了
    move(window, 120, -100, { buttons: 0 });
    expect(sent).toHaveLength(1);
    // 手勢已經收掉：之後就算真的補來一個 pointerup 也不會再送第二個命令
    up(window, 120, -100);
    expect(sent).toHaveLength(1);
  });

  /**
   * 多點觸控：window 上的監聽會收到**所有** pointer 的事件，所以 onMove/onEnd 都要
   * `ev.pointerId !== pointerId` 就 return。手勢掛在元素上的年代不需要這道關卡
   * （pointer capture 天然只給那一根），搬到 window 之後才變成必要條件。
   * 兩個測試分別釘住 onEnd 與 onMove 上的那道過濾（各自刪掉一行就會掛）。
   */
  it('多點觸控：另一根手指放開，不得收掉正在進行的手勢', () => {
    const sent = captureCommands(ws);
    const { container } = render(<Player />);
    seek(2);
    down(titleImg(container)!, 0, 0, 1);
    move(titleImg(container)!, 108, -96, { pointerId: 1 });

    up(window, 300, 300, 2); // 第二根手指在畫面別處放開
    expect(sent).toHaveLength(0); // 手勢還在進行，一個命令都不該送
    expect(guideEls(container).length).toBeGreaterThan(0); // 導線也還在（沒被收掉）

    up(window, 108, -96, 1); // 真正在拖的那根手指放開
    expect(sent).toHaveLength(1);
    const expected = dragOverlay(
      { x: 0.5, y: 0.1 },
      { dx: 108, dy: -96 },
      { w: 400, h: 100 },
      { w: 1080, h: 1920 },
    ).position;
    const pos = (sent[0] as Extract<Command, { name: 'updateOverlay' }>).patch.position!;
    expect(pos.x).toBeCloseTo(expected.x, 3);
    expect(pos.y).toBeCloseTo(expected.y, 3);
  });

  it('多點觸控：另一根手指移動，不得把被拖的項目扯過去', () => {
    const sent = captureCommands(ws);
    const { container } = render(<Player />);
    seek(2);
    down(titleImg(container)!, 0, 0, 1);
    move(titleImg(container)!, 108, -96, { pointerId: 1 });
    const shown = { left: titleImg(container)!.style.left, top: titleImg(container)!.style.top };

    // 第二根手指在畫面另一角滑動：它的 clientX/Y 若被拿去跟第一根手指的起點相減，
    // 元素會瞬間被扯到完全無關的位置（而且放手就存進 doc）。
    move(window, 900, 900, { pointerId: 2 });
    expect(titleImg(container)!.style.left).toBe(shown.left);
    expect(titleImg(container)!.style.top).toBe(shown.top);

    up(window, 108, -96, 1);
    const expected = dragOverlay(
      { x: 0.5, y: 0.1 },
      { dx: 108, dy: -96 },
      { w: 400, h: 100 },
      { w: 1080, h: 1920 },
    ).position;
    const pos = (sent[0] as Extract<Command, { name: 'updateOverlay' }>).patch.position!;
    expect(pos.x).toBeCloseTo(expected.x, 3);
    expect(pos.y).toBeCloseTo(expected.y, 3);
  });

  /**
   * 監聽洩漏防護（結構性測試）：手勢掛在 window 上，沒人幫忙自動清——finishDrag 的
   * `d.detach()` 是唯一的解除點。漏掉不會有任何看得見的症狀（殘留的 handler 大多會
   * 因為 dragRef 是 null 而早退），只會一次手勢累積三個 handler，一整個編輯 session
   * 下來成千上百個；等到 pointerId 被作業系統重用，殘留的 onMove 就會拿著舊手勢的
   * 起點去改新手勢的項目。這種「沒有症狀的錯」只能靠結構性斷言擋住。
   */
  it('手勢結束後：window 上的拖曳監聽全部解除（不洩漏）', () => {
    const live = trackWindowPointerListeners();
    const { container } = render(<Player />);
    seek(2);
    down(titleImg(container)!, 0, 0);
    // 前提成立：確實掛了 pointermove/pointerup/pointercancel 三個
    expect(live).toHaveLength(3);
    move(titleImg(container)!, 108, -96);
    up(window, 108, -96);
    expect(live).toHaveLength(0);
  });

  it('Player 被卸載時：手勢中的 window 監聽也要解除（不洩漏到下一次掛載）', () => {
    const live = trackWindowPointerListeners();
    const { container, unmount } = render(<Player />);
    seek(2);
    down(titleImg(container)!, 0, 0);
    move(titleImg(container)!, 108, -96);
    expect(live).toHaveLength(3);
    unmount(); // 手勢還按著就切走頁面／重新掛載 Player
    expect(live).toHaveLength(0);
  });

  it('stage 還沒量到寬（scale=0，算出 NaN）：不送命令，不讓 null 寫進專案檔', () => {
    // NaN 會被 JSON.stringify 序列化成 null，而 server 的 updateOverlay 不做數值驗證——
    // {"x":null} 一旦寫進 doc.json 就是永久壞掉的 position。真瀏覽器極難踩到（stage 有
    // aspect-ratio、版面早就定了），但保險絲的代價是一行。
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const isOverlay = this.hasAttribute('data-ov-id');
      // stage 量到 0 寬 → scale = 0 → 位移換算 dx/0 = Infinity → 最後 NaN
      const w = isOverlay ? 400 : 0;
      const h = isOverlay ? 100 : 0;
      return {
        width: w,
        height: h,
        top: 0,
        left: 0,
        right: w,
        bottom: h,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
    const sent = captureCommands(ws);
    const { container } = render(<Player />);
    seek(2);
    down(titleImg(container)!, 0, 0);
    move(titleImg(container)!, 108, -96);
    up(window, 108, -96);
    expect(sent).toHaveLength(0);

    // 字幕那條路徑有自己的送出點，保險絲要各裝一個（stderr 會出現 React 的
    // "`NaN` is an invalid value for the `left` css style property" —— 那正是 NaN 真的
    // 一路算到渲染層的證據，只是被擋在 sendCommand 之前）。
    const cap = container.querySelector('[data-drag-kind="caption"]') as HTMLElement;
    down(cap, 0, 0);
    move(cap, 0, 60);
    up(window, 0, 60);
    expect(sent).toHaveLength(0);
  });

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
