import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import type { Command } from '@vidcut/shared';
import { Timeline } from './Timeline.js';
import { useView } from '../stores/view.js';
import { usePlayback } from '../stores/playback.js';
import { useProject } from '../stores/project.js';
import * as ws from '../ws.js';
import { seedProject, resetStores, demoProject } from '../test/fixtures.js';

/**
 * Plan 11 Task 2（裁決 1、2）：trim 拖曳中 playhead 跟隨被拖的邊，rAF 節流；
 * 放手後停在邊上不彈回；move 拖曳不動 playhead；播放中開始 trim 先暫停；
 * 吸附候選在 trim-follow 期間排除 playhead（避免跟自己吸）；浮動時長/起點 badge。
 *
 * 同 Timeline.test.tsx：pxPerSecond 固定 40（1s=40px），clientWidth stub 讓掛載自動
 * fit 不覆蓋這個假設。
 */
const PPS = 40;
const STUB_CLIENT_WIDTH = 472;

let rafCallbacks: FrameRequestCallback[] = [];
let sent: Command[];

beforeEach(() => {
  resetStores();
  useView.setState({ pxPerSecond: PPS, snapEnabled: false });
  seedProject();
  rafCallbacks = [];
  sent = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    // id 對映到陣列 index+1（見上面 push 後回傳 length）；標記成 no-op 即可，
    // flushRaf 只會跑「還在陣列裡」的那些。
    const idx = id - 1;
    if (idx >= 0 && idx < rafCallbacks.length) rafCallbacks[idx] = () => {};
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return STUB_CLIENT_WIDTH;
    },
  });
  vi.spyOn(ws, 'sendCommand').mockImplementation((c: Command) => {
    sent.push(c);
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

describe('trim 即時畫面跟隨（Plan 11 Task 2 裁決 1）', () => {
  it('main track trim-in 拖曳中 playhead 追到邊時間（rAF 節流，flush 後才看得到）', () => {
    const { container } = render(<Timeline />);
    const clip = chipByText(container, 'clip one');
    const [left] = handles(clip);
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // c1: in=2 duration=6，clip 起點 0；+1s(40px) → in 3 duration 5（修剪方向，
      // 佔位 1s）
      fireEvent.pointerMove(left!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    // rAF 還沒 flush：不該提早跳
    expect(usePlayback.getState().time).toBe(0);
    act(() => flushRaf());
    // Plan 15 Task 2：修剪方向把手位置＝clipStart + placeholder（頭端佔位右緣），
    // 不再是 clip 起點本身——clip 的時間軸足跡靠佔位撐住維持 orig.duration=6 不變，
    // 佔位 = 6-5 = 1，把手停在 0+1=1（不是舊模型的「起點時間不動＝0」）。
    expect(usePlayback.getState().time).toBe(1);
  });

  it('main track trim-out 拖曳中 playhead 追到 clip 的（ripple）右緣時間', () => {
    const { container } = render(<Timeline />);
    const clip = chipByText(container, 'clip one');
    const [, right] = handles(clip);
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // c1 duration 6→7（+1s，40px）；c1 起點 0 → 右緣 7
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    act(() => flushRaf());
    expect(usePlayback.getState().time).toBe(7);
  });

  it('第二段 clip 的 trim-out：邊時間吃 ripple 後的起點（本地 preview layout，非 committed doc）', () => {
    const { container } = render(<Timeline />);
    const clip = chipByText(container, 'clip two');
    const [, right] = handles(clip);
    // c2 起點=c1.duration=6，duration=4，右緣=10
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 180, pointerId: 1, bubbles: true }); // +2s
    });
    act(() => flushRaf());
    expect(usePlayback.getState().time).toBe(12);
  });

  it('caption trim-out 拖曳中 playhead 追到新右緣', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'first line'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true }); // +1s：dur 3→4，右緣 1+4=5
    });
    act(() => flushRaf());
    expect(usePlayback.getState().time).toBe(5);
  });

  it('audio trim-in 拖曳中 playhead 追到新 start', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'bgm'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 120, pointerId: 1, bubbles: true }); // +0.5s：start 2→2.5
    });
    act(() => flushRaf());
    expect(usePlayback.getState().time).toBe(2.5);
  });

  it('overlay trim-out 拖曳中 playhead 追到新右緣', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'title.png'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true }); // ovAbs start=1 dur 3→4，右緣 5
    });
    act(() => flushRaf());
    expect(usePlayback.getState().time).toBe(5);
  });

  it('move 拖曳不驅動 playhead（只有 trim 邊才追）', () => {
    const { container } = render(<Timeline />);
    const chip = chipByText(container, 'first line');
    act(() => {
      fireEvent.pointerDown(chip, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(chip, { clientX: 180, pointerId: 1, bubbles: true });
    });
    act(() => flushRaf());
    expect(usePlayback.getState().time).toBe(0);
  });

  it('放手後 playhead 決定性停在切點內側（trim-out：邊 − 半幀，顯示保留段末幀）', () => {
    // residue bugfix（2026-08-24）：舊語意「停在最後一次 flush 的邊上」對主軌 trim
    // 廢止——正邊界 `locate()` 歸屬右側，停在邊上顯示的是**下一段首幀**（trim-out
    // 縮短時＝使用者剛修掉區域旁的錯誤畫面，肉眼＝殘留）。新語意：commit 分支
    // 決定性 seek 到「邊 − 0.5/fps」（fixture canvas fps=30 → 半幀 1/60）。
    const { container } = render(<Timeline />);
    const clip = chipByText(container, 'clip one');
    const [, right] = handles(clip);
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    act(() => flushRaf());
    expect(usePlayback.getState().time).toBe(7);
    act(() => {
      fireEvent.pointerUp(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    expect(usePlayback.getState().time).toBeCloseTo(7 - 0.5 / 30, 6);
  });

  it('放手時 rAF 未 flush 也一樣：playhead 收斂到與送出 duration 同源的切點（殘留根因釘）', () => {
    // residue bugfix 的判別性回歸釘：手勢最後一次 pointerMove 的 rAF 被 cancelFollow
    // 丟棄時，舊碼讓 time 停在**倒數第二拍**（trim-out 縮短＝比送出的 duration 大 →
    // 落進下一個 clip → 畫面殘留下一段首幀且無事件修正）。新碼放手當下決定性 seek，
    // 不依賴 flush 與否——兩種時序（flush 過／沒 flush）收斂到同一個值。
    // c1: 起點 0、duration 6；先拉到 -2s（邊 4）flush 過，再往回 -1s（邊 5）**不 flush**
    // 直接放手：送出的 duration=5，舊碼 time 卡在 4？不——卡在「最後一次 flush 的 4」
    // 且送出 5 的情境要反過來拉才會 time > duration；這裡取更直接的斷言：無論 flush
    // 狀態，放手後 time === 邊 − 半幀（與送出的 duration 嚴格同源）。
    const { container } = render(<Timeline />);
    const clip = chipByText(container, 'clip one');
    const [, right] = handles(clip);
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 20, pointerId: 1, bubbles: true }); // -2s → 邊 4
    });
    act(() => flushRaf());
    expect(usePlayback.getState().time).toBe(4);
    act(() => {
      // 倒數第二拍已 flush（time=4）；最後一拍（-1s → 邊 5）**不 flush** 直接放手：
      // 舊碼 time 停在 4、送出 duration=5——4 < 5 這方向剛好無害，但反向（先 5 後 4）
      // time=5 > duration=4 就是殘留。決定性 seek 讓兩個方向都不再依賴 flush 時序。
      fireEvent.pointerMove(right!, { clientX: 60, pointerId: 1, bubbles: true });
      fireEvent.pointerUp(right!, { clientX: 60, pointerId: 1, bubbles: true });
    });
    expect(usePlayback.getState().time).toBeCloseTo(5 - 0.5 / 30, 6);
    // flushRaf 不會再追加跳動（rAF 已被 cancel）
    const after = usePlayback.getState().time;
    act(() => flushRaf());
    expect(usePlayback.getState().time).toBe(after);
  });

  it('殘留場景本體：最後一拍縮短未 flush，放手後 time 必須小於送出的 duration 邊界', () => {
    // 真瀏覽器診斷的原始場景：先 flush 在較大的邊（6.5），最後一拍縮到 5.5 未 flush
    // 就放手——舊碼 time 卡在 6.5 > 送出的 duration 5.5，playhead 落進 clip two，
    // Player 顯示下一段首幀（殘留）。新碼：time = 5.5 − 半幀 < 5.5，必在保留段內。
    const { container } = render(<Timeline />);
    const clip = chipByText(container, 'clip one');
    const [, right] = handles(clip);
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 120, pointerId: 1, bubbles: true }); // +0.5s → 邊 6.5
    });
    act(() => flushRaf());
    expect(usePlayback.getState().time).toBe(6.5);
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 80, pointerId: 1, bubbles: true }); // -0.5s → 邊 5.5
      fireEvent.pointerUp(right!, { clientX: 80, pointerId: 1, bubbles: true });
    });
    const t = usePlayback.getState().time;
    expect(t).toBeLessThan(5.5); // 殘留判準：不得 ≥ 送出的 duration（會落進下一段）
    expect(t).toBeCloseTo(5.5 - 0.5 / 30, 6);
  });

  it('trim-in 放手：playhead 收斂到切點（clipStart），trimPreview 用最終值覆蓋', () => {
    // c1 起點 0：往右修剪 1s（in 2→3、duration 6→5、佔位 1）。拖曳中 playhead 在
    // 佔位右緣（1）；放手後收斂到 clipStart（0）＝保留內容的起點（邊界歸屬右側＝
    // 本 clip，顯示新首幀），trimPreview 也覆蓋成與送出 patch 同源的最終值。
    const { container } = render(<Timeline />);
    const clip = chipByText(container, 'clip one');
    const [left] = handles(clip);
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    act(() => flushRaf());
    expect(usePlayback.getState().time).toBe(1);
    act(() => {
      fireEvent.pointerUp(left!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    expect(usePlayback.getState().time).toBe(0);
    expect(usePlayback.getState().trimPreview).toMatchObject({
      in: 3,
      leadPad: 0,
      placeholderHead: 0,
    });
  });
});

describe('播放中開始 trim 先暫停（Plan 11 Task 2 裁決 1）', () => {
  it('playing=true 時開始 trim → pause() 被呼叫（playing 翻 false）', () => {
    const { container } = render(<Timeline />);
    act(() => {
      usePlayback.getState().play();
    });
    expect(usePlayback.getState().playing).toBe(true);
    const [, right] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    expect(usePlayback.getState().playing).toBe(false);
  });

  it('playing=false 時開始 trim 不受影響（維持暫停）', () => {
    const { container } = render(<Timeline />);
    expect(usePlayback.getState().playing).toBe(false);
    const [, right] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    expect(usePlayback.getState().playing).toBe(false);
  });
});

describe('吸附候選排除 playhead（trim-follow 期間，controller pre-flight 裁決）', () => {
  /**
   * 用「非整秒、非片段邊界」的 playhead 位置排除巧合命中：playhead=3.4s（不等於
   * 任何整秒或 demo 專案的片段/字幕/音訊邊界），拖 clip one 的 out 把手到右緣落在
   * 3.4s 的 8px 容忍帶內（3.43s，離 3.4 僅 1.2px）。trim-follow 期間 playhead 本身
   * 也被排除在候選外，所以應該吸不到——邊時間停在未吸附的原始值 3.43，不是 3.4。
   */
  const PLAYHEAD_T = 3.4;
  const TARGET_DUR = 3.43; // 目標右緣（clip one 起點=0）

  it('trim 拖曳中不會吸到自己正在追的 playhead（邊落在未吸附的原始值）', () => {
    useView.setState({ snapEnabled: true });
    usePlayback.getState().seek(PLAYHEAD_T);
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // c1 duration 6 → TARGET_DUR：deltaSec = TARGET_DUR - 6
      fireEvent.pointerMove(right!, {
        clientX: 100 + (TARGET_DUR - 6) * PPS,
        pointerId: 1,
        bubbles: true,
      });
    });
    act(() => flushRaf());
    expect(usePlayback.getState().time).toBeCloseTo(TARGET_DUR, 5);
  });

  it('move 拖曳（不驅動 playhead）時，playhead 仍是正常吸附候選（控制組：機制沒被關掉，只是 trim-follow 期間排除）', () => {
    useView.setState({ snapEnabled: true });
    usePlayback.getState().seek(PLAYHEAD_T);
    const { container } = render(<Timeline />);
    const cap = chipByText(container, 'first line'); // cap1 start=1，move 走左緣吸附
    act(() => {
      fireEvent.pointerDown(cap, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 目標 start=3.43（+2.43s=97.2px）：8px 容忍帶內只有 playhead=3.4，無整秒/邊界競爭
      fireEvent.pointerMove(cap, { clientX: 100 + 2.43 * PPS, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerUp(cap, { clientX: 100 + 2.43 * PPS, pointerId: 1, bubbles: true });
    });
    // move 不驅動 playhead、也不被排除吸附——start 應吸到 playhead=3.4
    expect(sent).toEqual([
      { name: 'updateCaption', id: 'cap1', patch: { start: 3.4, duration: 3 } },
    ]);
  });

  it('trim 放手後吸附候選恢復（再做一次 move 拖曳仍可吸到 playhead）', () => {
    useView.setState({ snapEnabled: true });
    usePlayback.getState().seek(PLAYHEAD_T);
    const { container } = render(<Timeline />);
    // 先做一次 clip trim（進入並離開 follow 模式，過程會把 playhead 挪到 clip 的邊）
    const [, right] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    act(() => flushRaf());
    act(() => {
      fireEvent.pointerUp(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    // 把 playhead 挪回 PLAYHEAD_T，驗證後續的 move 拖曳仍能吸到它
    // （若排除旗標在放手後沒有復位，這裡會吸不到，落地在未吸附的原始值）
    act(() => {
      usePlayback.getState().seek(PLAYHEAD_T);
    });
    const cap = chipByText(container, 'first line');
    act(() => {
      fireEvent.pointerDown(cap, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(cap, { clientX: 100 + 2.43 * PPS, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerUp(cap, { clientX: 100 + 2.43 * PPS, pointerId: 1, bubbles: true });
    });
    const capCmd = sent.find((c) => c.name === 'updateCaption');
    expect(capCmd).toMatchObject({ patch: { start: 3.4 } });
  });
});

describe('浮動時長/起點 badge（Plan 11 Task 2 裁決 2）', () => {
  it('沒有拖曳時沒有 badge', () => {
    const { container } = render(<Timeline />);
    expect(container.textContent).not.toMatch(/\(\+|\(−/);
  });

  it('trim 拖曳中出現 badge，內容含時長與帶號增減', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true }); // dur 6→7，delta +1
    });
    expect(container.textContent).toContain('7.0s (+1.0s)');
  });

  it('move 拖曳中 badge 顯示起點時間（不是時長/增減格式）', () => {
    const { container } = render(<Timeline />);
    const chip = chipByText(container, 'first line'); // start=1
    act(() => {
      fireEvent.pointerDown(chip, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(chip, { clientX: 180, pointerId: 1, bubbles: true }); // +2s → start 3
    });
    expect(container.textContent).toContain('3.0s');
    expect(container.textContent).not.toMatch(/\(\+|\(−/);
  });

  it('放手後 badge 消失', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    expect(container.textContent).toContain('7.0s (+1.0s)');
    act(() => {
      fireEvent.pointerUp(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    expect(container.textContent).not.toMatch(/\(\+|\(−/);
  });
});

describe('來源長度上限的視覺語言（Plan 11 Task 3 裁決 5）', () => {
  // c1 → m1，probe.duration=30，in=2 duration=6 → 來源右緣 8，最多還能拉長 22s（880px @ 40pps）。
  const ROOM_TO_MAX_PX = (30 - (2 + 6)) * PPS; // 880

  it('trim-out 拖到來源盡頭：out 把手帶 danger class，in 把手不受影響', () => {
    const { container } = render(<Timeline />);
    const clip = chipByText(container, 'clip one');
    const [left, right] = handles(clip);
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 拖超過剩餘空間（+50px）：clamp 應把 duration 頂在 mediaDuration 邊界
      fireEvent.pointerMove(right!, {
        clientX: 100 + ROOM_TO_MAX_PX + 50,
        pointerId: 1,
        bubbles: true,
      });
    });
    expect(right!.className).toContain('danger');
    expect(left!.className).not.toContain('danger');
  });

  it('trim-out 拖到來源盡頭：badge 附加 max 標記', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, {
        clientX: 100 + ROOM_TO_MAX_PX + 50,
        pointerId: 1,
        bubbles: true,
      });
    });
    expect(container.textContent).toContain('· max');
  });

  it('trim-out 未拖到盡頭：沒有 danger class，badge 沒有 max 標記', () => {
    const { container } = render(<Timeline />);
    const clip = chipByText(container, 'clip one');
    const [left, right] = handles(clip);
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 只拖 +1s，遠不到 22s 的剩餘空間
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    expect(right!.className).not.toContain('danger');
    expect(left!.className).not.toContain('danger');
    expect(container.textContent).not.toContain('max');
  });

  it('trim-in 拖曳（非 out 把手）：即使同一個 clip，danger 態不觸發（上限只約束右緣）', () => {
    const { container } = render(<Timeline />);
    const clip = chipByText(container, 'clip one');
    const [left, right] = handles(clip);
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 60, pointerId: 1, bubbles: true }); // -1s
    });
    expect(left!.className).not.toContain('danger');
    expect(right!.className).not.toContain('danger');
  });

  it('放手後 danger 態與 max 標記一起消失（回到一般顯示）', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, {
        clientX: 100 + ROOM_TO_MAX_PX + 50,
        pointerId: 1,
        bubbles: true,
      });
    });
    expect(right!.className).toContain('danger');
    act(() => {
      fireEvent.pointerUp(right!, {
        clientX: 100 + ROOM_TO_MAX_PX + 50,
        pointerId: 1,
        bubbles: true,
      });
    });
    const clip = chipByText(container, 'clip one');
    const [, rightAfter] = handles(clip);
    expect(rightAfter!.className).not.toContain('danger');
    expect(container.textContent).not.toContain('max');
  });
});

describe('pointercancel 拆卸（fix round 1 C1/C2）', () => {
  it('trim 拖曳中 pointercancel：不 commit（sendCommand 不呼叫），badge 消失', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    expect(container.textContent).toContain('7.0s (+1.0s)');
    act(() => {
      fireEvent.pointerCancel(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    expect(sent).toEqual([]); // cancel 路徑不 commit——沒有 updateClip 送出
    expect(container.textContent).not.toMatch(/\(\+|\(−/);
  });

  it('trim 拖曳中 pointercancel 後：尚未 flush 的 rAF 不再 seek', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    // 故意不 flush，直接 cancel
    act(() => {
      fireEvent.pointerCancel(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    const beforeFlush = usePlayback.getState().time;
    act(() => flushRaf());
    expect(usePlayback.getState().time).toBe(beforeFlush); // 沒有補一次 seek
  });

  it('trim 拖曳中 pointercancel：trimFollowing 復位，吸附候選重新包含 playhead', () => {
    useView.setState({ snapEnabled: true });
    const PLAYHEAD_T = 3.4;
    usePlayback.getState().seek(PLAYHEAD_T);
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    act(() => flushRaf());
    act(() => {
      fireEvent.pointerCancel(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    // playhead 被 cancel 路徑的 total 還原夾回 total（見下一個測試），先把它挪回 3.4
    act(() => {
      usePlayback.getState().seek(PLAYHEAD_T);
    });
    const cap = chipByText(container, 'first line');
    act(() => {
      fireEvent.pointerDown(cap, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(cap, { clientX: 100 + 2.43 * PPS, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerUp(cap, { clientX: 100 + 2.43 * PPS, pointerId: 1, bubbles: true });
    });
    const capCmd = sent.find((c) => c.name === 'updateCaption');
    expect(capCmd).toMatchObject({ patch: { start: 3.4 } }); // 吸到 playhead＝候選已恢復
  });

  it('主軌 trim-out 把 total 墊高後 pointercancel：total 還原到手勢開始前的值（fix round 1 C2）', () => {
    const { container } = render(<Timeline />);
    expect(usePlayback.getState().total).toBe(10); // c1(0-6) + c2(6-10)
    const [, right] = handles(chipByText(container, 'clip two')); // c2 起點=6 duration=4 右緣=10
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // +2s：c2 duration 4→6，右緣 6+6=12，超過 committed total=10 → scheduleFollow 墊高 total
      fireEvent.pointerMove(right!, { clientX: 180, pointerId: 1, bubbles: true });
    });
    act(() => flushRaf());
    expect(usePlayback.getState().total).toBe(12); // 墊高生效
    act(() => {
      fireEvent.pointerCancel(right!, { clientX: 180, pointerId: 1, bubbles: true });
    });
    expect(usePlayback.getState().total).toBe(10); // 沒有 doc echo 也還原回原值，不永久虛胖
    expect(sent).toEqual([]); // 不 commit
  });

  it('主軌 trim-out 把 total 墊高後正常放手（pointerup）：total 先還原，隨後由 doc echo 覆寫（此測試只驗還原不撞回舊值）', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'clip two'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 180, pointerId: 1, bubbles: true });
    });
    act(() => flushRaf());
    expect(usePlayback.getState().total).toBe(12);
    act(() => {
      fireEvent.pointerUp(right!, { clientX: 180, pointerId: 1, bubbles: true });
    });
    // residue bugfix（2026-08-24）後的語意：teardown 先把 total 還原到 10（保底），
    // 但 commit 分支隨後的決定性 seek（邊 12 − 半幀）超過還原值，會照 scheduleFollow
    // rAF body 的同款手法把 total 再頂到 seek 目標——這是**暫態**，echo 抵達後由
    // committed doc 覆寫（本測試不模擬 server）。舊斷言 `total === 10` 釘的是
    // 「commit 放手當下恰好沒人再動 total」這個偶然值,不是還原機制本身；還原機制
    // 仍由下一條 pointercancel 測試釘著（cancel 路徑沒有 seek 介入，total 必須是 10）。
    expect(usePlayback.getState().total).toBeCloseTo(12 - 0.5 / 30, 6);
    expect(usePlayback.getState().time).toBeCloseTo(12 - 0.5 / 30, 6);
  });

  it('主軌 trim-out 把 total 墊高、playhead 跟到超前值後 pointercancel：playhead 被夾回還原後的 total（final-review Fix 1）', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'clip two')); // c2 起點=6 duration=4 右緣=10
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // +2s：c2 duration 4→6，右緣 12，超過 committed total=10 → total 墊高、playhead 跟到 12
      fireEvent.pointerMove(right!, { clientX: 180, pointerId: 1, bubbles: true });
    });
    act(() => flushRaf());
    expect(usePlayback.getState().time).toBe(12); // playhead 已追到墊高後的邊
    act(() => {
      fireEvent.pointerCancel(right!, { clientX: 180, pointerId: 1, bubbles: true });
    });
    // total 還原到 10（既有行為）；playhead 不能被留在還原後的 total 之外——
    // 沒有 doc echo 兜底，放著不管就永久卡在 12 > 10，play 會立刻因 tick() clamp 判定播畢。
    expect(usePlayback.getState().total).toBe(10);
    expect(usePlayback.getState().time).toBeLessThanOrEqual(10);
    expect(usePlayback.getState().time).toBe(10);
  });
});

describe('dragActive 旗標（final-review Fix 2）', () => {
  it('trim 拖曳啟動：dragActive 翻 true', () => {
    const { container } = render(<Timeline />);
    expect(usePlayback.getState().dragActive).toBe(false);
    const [, right] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    expect(usePlayback.getState().dragActive).toBe(true);
  });

  it('move 拖曳（非 trim）啟動：dragActive 也翻 true（任何進行中的拖曳都該抑制鍵盤 trim）', () => {
    const { container } = render(<Timeline />);
    const chip = chipByText(container, 'first line');
    act(() => {
      fireEvent.pointerDown(chip, { clientX: 100, pointerId: 1, bubbles: true });
    });
    expect(usePlayback.getState().dragActive).toBe(true);
  });

  it('pointerup 後：dragActive 復位為 false', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    expect(usePlayback.getState().dragActive).toBe(true);
    act(() => {
      fireEvent.pointerUp(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    expect(usePlayback.getState().dragActive).toBe(false);
  });

  it('pointercancel 後：dragActive 也復位為 false（teardownDrag 是共用路徑）', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    expect(usePlayback.getState().dragActive).toBe(true);
    act(() => {
      fireEvent.pointerCancel(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    expect(usePlayback.getState().dragActive).toBe(false);
  });
});

describe('主軌 trim-in 捲動補償——邊釘手指下（Plan 12 Task 1，幾何解見 plan 診斷依據）', () => {
  /**
   * scrollRef（唯一的橫向捲動容器，Plan 9 windowing 也用它）在 jsdom 下
   * scrollLeft 是可讀寫的一般 property（非真排版），見 ui-verification.md。
   * 用 `scroll` 容器的 style 找到它：Timeline.tsx 唯一 `overflow:auto` 的 div。
   */
  function scroller(container: HTMLElement): HTMLDivElement {
    const el = Array.from(container.querySelectorAll('div')).find(
      (d) => (d as HTMLElement).style.overflow === 'auto',
    );
    if (!el) throw new Error('scroller not found');
    return el as HTMLDivElement;
  }

  it('主軌 trim-in 拖曳中 scrollLeft 隨 delta 增加（往左拉手指＝把手往左移＝duration 變長）', () => {
    const { container } = render(<Timeline />);
    const scrollEl = scroller(container);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    expect(scrollEl.scrollLeft).toBe(0);
    act(() => {
      // 往左拉 40px（1s）：origDuration=6 → duration=7，durationPx 40*7=280，
      // origDurationPx=40*6=240 → scrollLeft = 0 + (280-240) = 40
      fireEvent.pointerMove(left!, { clientX: 60, pointerId: 1, bubbles: true });
    });
    expect(scrollEl.scrollLeft).toBe(40);
  });

  it('雙向：往左拉再縮回去，scrollLeft 跟著減少（不是單調累加，每幀絕對重算）', () => {
    const { container } = render(<Timeline />);
    const scrollEl = scroller(container);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 60, pointerId: 1, bubbles: true }); // +1s
    });
    expect(scrollEl.scrollLeft).toBe(40);
    act(() => {
      // 縮回去：+0.5s（20px）而非 +1s → duration 6.5，delta px = 20
      fireEvent.pointerMove(left!, { clientX: 80, pointerId: 1, bubbles: true });
    });
    expect(scrollEl.scrollLeft).toBe(20);
    act(() => {
      // 完全縮回起點：delta=0
      fireEvent.pointerMove(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    expect(scrollEl.scrollLeft).toBe(0);
  });

  it('scrollLeftAtDragStart 非零時，補償是相對起手點的絕對重算（不是從 0 起算）', () => {
    const { container } = render(<Timeline />);
    const scrollEl = scroller(container);
    act(() => {
      scrollEl.scrollLeft = 100; // 手勢開始前使用者已經捲動過
    });
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    expect(scrollEl.scrollLeft).toBe(100); // 起手不應該重置捲動位置
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 60, pointerId: 1, bubbles: true }); // +1s → +40px
    });
    expect(scrollEl.scrollLeft).toBe(140); // 100 + 40
  });

  it('scrollLeft 夾在 0：往右推（縮短 in 拖曳，duration 變短）不會把 scrollLeft 推成負值', () => {
    const { container } = render(<Timeline />);
    const scrollEl = scroller(container);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 往右推 3s（120px）：duration 6→3（仍 > MIN_CLIP_DURATION），delta px = -120
      // 但起手 scrollLeft=0，理論負值應被夾在 0
      fireEvent.pointerMove(left!, { clientX: 220, pointerId: 1, bubbles: true });
    });
    expect(scrollEl.scrollLeft).toBe(0);
  });

  it('絕對重算在撞 0 clamp 之後仍一致：先推到底夾住，再往左拉回，scrollLeft 從 0 正確回升', () => {
    const { container } = render(<Timeline />);
    const scrollEl = scroller(container);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 220, pointerId: 1, bubbles: true }); // 撞 0 clamp
    });
    expect(scrollEl.scrollLeft).toBe(0);
    act(() => {
      // 回到起手點再往左拉 0.5s（20px）：不是「從夾住的 0 繼續累加」，
      // 而是相對 startX 絕對重算 → scrollLeft = 20
      fireEvent.pointerMove(left!, { clientX: 80, pointerId: 1, bubbles: true });
    });
    expect(scrollEl.scrollLeft).toBe(20);
  });

  it('放手後 scrollLeft 不回彈（維持補償後的值，teardownDrag 不觸碰它）', () => {
    const { container } = render(<Timeline />);
    const scrollEl = scroller(container);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 60, pointerId: 1, bubbles: true });
    });
    expect(scrollEl.scrollLeft).toBe(40);
    act(() => {
      fireEvent.pointerUp(left!, { clientX: 60, pointerId: 1, bubbles: true });
    });
    expect(scrollEl.scrollLeft).toBe(40);
  });

  it('pointercancel 後 scrollLeft 同樣不回彈（teardownDrag 是拆卸共用路徑，不特別處理 scrollLeft）', () => {
    const { container } = render(<Timeline />);
    const scrollEl = scroller(container);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 60, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerCancel(left!, { clientX: 60, pointerId: 1, bubbles: true });
    });
    expect(scrollEl.scrollLeft).toBe(40);
  });

  it('主軌 trim-in 期間 snapLine 恆 null（裁決 2：內容座標吸附已移除，即使 snapEnabled 開啟）', () => {
    useView.setState({ snapEnabled: true });
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 刻意拖到接近整秒邊界（舊行為會吸右緣到整數秒），驗證新行為完全不吸
      fireEvent.pointerMove(left!, { clientX: 61, pointerId: 1, bubbles: true }); // ~+1.025s
    });
    // snapLine 沒有直接的 state 讀取入口，用其視覺渲染驗證：吸附導線是 Timeline.tsx 裡
    // `boxShadow: '0 0 6px var(--accent-glow-strong)'` 那個絕對定位 div（playhead 標記
    // 也用同一個 CSS 變數但不同 px 值，篩選要連 `0 0 6px` 一起比對才不會誤中）。
    const lines = Array.from(container.querySelectorAll('div')).filter(
      (d) => (d as HTMLElement).style.boxShadow === '0 0 6px var(--accent-glow-strong)',
    );
    expect(lines).toHaveLength(0);
  });

  it('主軌 trim-in 期間拖過 in=0：不再硬停，長出 leadPad（Plan 14 Task 4，取代舊的 0 clamp 語意）', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one')); // c1 in=2 duration=6，來源右界 R=8
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 往左拉 3s（120px）：x=2，x'=2-3=-1（遠超 8px/40pps=0.2s 吸附閾值，不吸附）
      // → in=0, leadPad=1, duration=R+1=9
      fireEvent.pointerMove(left!, { clientX: -20, pointerId: 1, bubbles: true });
    });
    expect(container.textContent).toContain('9.0s (+3.0s) · black +1.0s');
  });

  it('絕對時間軌（audio）的 trim-in 拖曳不觸發任何 scrollLeft 補償', () => {
    const { container } = render(<Timeline />);
    const scrollEl = scroller(container);
    const [left] = handles(chipByText(container, 'bgm'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 60, pointerId: 1, bubbles: true }); // -1s start
    });
    expect(scrollEl.scrollLeft).toBe(0);
  });

  it('caption（絕對時間軌）trim 也不觸發 scrollLeft 補償', () => {
    const { container } = render(<Timeline />);
    const scrollEl = scroller(container);
    const [, right] = handles(chipByText(container, 'first line'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    expect(scrollEl.scrollLeft).toBe(0);
  });

  it('主軌 trim-out（右把手）不觸發 scrollLeft 補償，行為與 Plan 11 不變', () => {
    const { container } = render(<Timeline />);
    const scrollEl = scroller(container);
    const [, right] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    expect(scrollEl.scrollLeft).toBe(0);
  });

  it('主軌 trim-out 的吸附行為不受本批影響（裁決 1/2 只動 trim-in）', () => {
    useView.setState({ snapEnabled: true });
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // +1.9s（76px）：吸到整秒 8（clip 起點 0，duration 6→7.9 吸到 8）
      fireEvent.pointerMove(right!, { clientX: 176, pointerId: 1, bubbles: true });
    });
    expect(container.textContent).toContain('8.0s');
  });
});

describe('拖曳中 wheel zoom 守門（Plan 12 終審 fix round：ctrl/⌘+wheel 在拖曳中須為 no-op）', () => {
  /**
   * 終審發現：wheel listener 只檢查 ctrlKey/metaKey，沒檢查 drag.current。
   * pointer capture 不會壓下 scroll 容器上的 wheel 事件，所以 trim 拖曳中
   * Ctrl+滾輪（或 macOS 觸控板 pinch，合成帶 ctrlKey:true 的 wheel）仍能觸發
   * `zoomBy`，把 pps 中途換掉——`deltaSec = pxToTime(e.clientX - d.startX, pps)`
   * 用新 pps 去解讀舊 pps 量出的位移，把手瞬間跳離手指；`scrollLeftAtDragStart`
   * 也是舊佈局下量的像素值，換了 pps 後跟新佈局對不上。修法與既有的 auto-fit
   * 守門（`if (drag.current) return; // (c) 拖曳中絕不 fit`，Timeline.tsx:566）
   * 同一個模式：拖曳中整個 wheel zoom 變 no-op（CapCut 同樣行為）。
   */
  function scroller(container: HTMLElement): HTMLDivElement {
    const el = container.querySelector('div[style*="overflow: auto"]');
    if (!el) throw new Error('scroller not found');
    return el as HTMLDivElement;
  }

  it('主軌 trim-in 拖曳中：ctrlKey wheel 不改變 pps（no-op）', () => {
    const { container } = render(<Timeline />);
    const well = scroller(container);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    const before = useView.getState().pxPerSecond;
    act(() => {
      well.dispatchEvent(
        new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true }),
      );
    });
    expect(useView.getState().pxPerSecond).toBe(before);
  });

  it('主軌 trim-in 拖曳中：ctrlKey wheel 不影響 scrollLeft 補償基準（後續 move 算出的 scrollLeft 不受干擾）', () => {
    const { container } = render(<Timeline />);
    const well = scroller(container);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      well.dispatchEvent(
        new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true }),
      );
    });
    act(() => {
      // +1s（40px，pps 仍是 40，wheel 沒改成功）：scrollLeft 應正常補償到 40
      fireEvent.pointerMove(left!, { clientX: 60, pointerId: 1, bubbles: true });
    });
    expect(well.scrollLeft).toBe(40);
  });

  it('主軌 trim-in 拖曳中：ctrlKey wheel 不影響 badge 顯示的時長（游標不動，badge 值不該漂）', () => {
    const { container } = render(<Timeline />);
    const well = scroller(container);
    const [, right] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true }); // dur 6→7
    });
    expect(container.textContent).toContain('7.0s (+1.0s)');
    act(() => {
      // 游標本身沒有移動，只是中途插入一次 ctrl+wheel——badge 不應該因為 pps
      // 中途換掉而重算出不同的值（終審描述的具體症狀：7.0s→6.5s）
      well.dispatchEvent(
        new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true }),
      );
    });
    expect(container.textContent).toContain('7.0s (+1.0s)');
  });

  it('控制組：沒有拖曳時，同一個 ctrlKey wheel 事件仍然會縮放（守門只擋拖曳中，不是關掉整個功能）', () => {
    const { container } = render(<Timeline />);
    const well = scroller(container);
    const before = useView.getState().pxPerSecond;
    act(() => {
      well.dispatchEvent(
        new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true }),
      );
    });
    expect(useView.getState().pxPerSecond).toBeGreaterThan(before);
  });
});

describe('主軌 trim-in 即時首幀覆蓋（Plan 12 Task 2，裁決 3）', () => {
  it('trim-in 拖曳中，rAF flush 後 usePlayback.trimPreview 帶 clipId+新 in', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one')); // c1 in=2
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 140, pointerId: 1, bubbles: true }); // +1s → in 3
    });
    // rAF 還沒 flush：與 followTarget 同節奏，不該提早寫入
    expect(usePlayback.getState().trimPreview).toBeNull();
    act(() => flushRaf());
    // Plan 14 Task 4：trimPreview 每幀都帶明確 leadPad（這裡未拖出黑墊，值為 0）。
    // final-review Critical 1：一併帶 placeholderHead（duration 6→5，佔位 1s）。
    expect(usePlayback.getState().trimPreview).toEqual({
      clipId: 'c1',
      in: 3,
      leadPad: 0,
      placeholderHead: 1,
    });
  });

  it('同一節奏內連續兩次 pointermove 只在 flush 時寫入最後一次的值（不逐 move 都寫）', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 140, pointerId: 1, bubbles: true }); // in 3
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 180, pointerId: 1, bubbles: true }); // in 4（同一幀，還沒 flush）
    });
    expect(usePlayback.getState().trimPreview).toBeNull();
    act(() => flushRaf());
    // duration 6→4，佔位 2s。
    expect(usePlayback.getState().trimPreview).toEqual({
      clipId: 'c1',
      in: 4,
      leadPad: 0,
      placeholderHead: 2,
    });
  });

  it('放手（pointerup，有實質變動）後 trimPreview 不立刻清空——與 pending 的 clip-trim 記錄綁命（review round 1 Important-1）', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    act(() => flushRaf());
    expect(usePlayback.getState().trimPreview).not.toBeNull();
    act(() => {
      fireEvent.pointerUp(left!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    // echo 還沒到（這個測試不模擬 server）：trimPreview 必須繼續蓋著，否則 player
    // 這幾幀會用 doc 的舊 in 映射，畫面閃回舊幀（Important-1 點名的閃爍）。
    // residue bugfix（2026-08-24）：放手時 commit 分支用**最終值**顯式覆蓋 trimPreview
    // ——playhead 已決定性收斂到 clipStart（offset 0），placeholderHead 歸 0（拖曳中
    // 那個「把手位置」座標修正已無意義）；in/leadPad 與送出的 patch 嚴格同源，
    // 不再依賴最後一顆 rAF 是否 flush 過（未 flush 時舊值是倒數第二拍的 in）。
    expect(usePlayback.getState().trimPreview).toEqual({
      clipId: 'c1',
      in: 3,
      leadPad: 0,
      placeholderHead: 0,
    });
    // Plan 14 Task 4：commit 一併帶 leadPad。
    expect(sent).toEqual([
      { name: 'updateClip', clipId: 'c1', patch: { in: 3, duration: 5, leadPad: 0 } },
    ]);
  });

  it('doc echo 抵達（pending 的 clip-trim 對上）：trimPreview 隨 pending 一起清空', () => {
    const { container, rerender } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    act(() => flushRaf());
    act(() => {
      fireEvent.pointerUp(left!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    expect(usePlayback.getState().trimPreview).not.toBeNull();
    // 模擬 doc echo 抵達：c1 的 in/duration 已經反映拖曳結果
    const doc = useProject.getState().doc!;
    act(() => {
      useProject.setState({
        doc: {
          ...doc,
          tracks: {
            ...doc.tracks,
            video: doc.tracks.video.map((c) => (c.id === 'c1' ? { ...c, in: 3, duration: 5 } : c)),
          },
        },
      });
    });
    act(() => rerender(<Timeline />)); // 對帳區塊在 render body 裡跑，需要一次重渲染才會執行
    expect(usePlayback.getState().trimPreview).toBeNull();
  });

  it('pointercancel 後 trimPreview 立刻清回 null（取消語意：閃回舊幀是對的）', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    act(() => flushRaf());
    expect(usePlayback.getState().trimPreview).not.toBeNull();
    act(() => {
      fireEvent.pointerCancel(left!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    expect(usePlayback.getState().trimPreview).toBeNull();
    expect(sent).toEqual([]); // cancel 不 commit，也沒有 pending 可以綁
  });

  it('放手時取消尚未 flush 的 rAF：commit 分支用最終值補寫 trimPreview（不再依賴 flush 時序）', () => {
    // residue bugfix（2026-08-24）語意反轉：舊釘「從未 flush 就維持 null」保護的是
    // 「放手後不被 rAF 突襲補寫」；新碼在放手**當下**決定性寫入與送出 patch 同源的
    // 最終值——沒有這筆，echo 抵達前 player 用 doc 舊 in 映射，畫面閃回舊幀
    // （正是 Important-1 那個閃爍在「rAF 沒 flush 過」時序下的變體）。
    // 「rAF 不突襲」的保護由最後的 flushRaf 斷言接手：值在放手當下就定案,之後不變。
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    // 故意不 flush，直接放手——commit 分支仍要寫入最終值
    act(() => {
      fireEvent.pointerUp(left!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    const atRelease = usePlayback.getState().trimPreview;
    expect(atRelease).toEqual({ clipId: 'c1', in: 3, leadPad: 0, placeholderHead: 0 });
    act(() => flushRaf()); // 已取消的 rAF：不會再改值
    expect(usePlayback.getState().trimPreview).toBe(atRelease);
  });

  it('trim-out（右把手）不寫 trimPreview——只有 trim-in 驅動這個覆蓋', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    act(() => flushRaf());
    expect(usePlayback.getState().trimPreview).toBeNull();
  });

  it('audio/caption trim-in（非主軌）不寫 trimPreview——只約束主軌 video clip', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'bgm'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 120, pointerId: 1, bubbles: true });
    });
    act(() => flushRaf());
    expect(usePlayback.getState().trimPreview).toBeNull();
  });

  it('zero-change release（按下就放，沒有任何 pointermove）：trim-in/out 仍無條件送出 updateClip——沒有獨立的「不送命令」分支，trimPreview 一路維持 null', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    // 沒有 pointermove：d.preview 仍是 onTrimStart 灌進去的原值，trimPreviewTarget 從未寫入
    expect(usePlayback.getState().trimPreview).toBeNull();
    act(() => {
      fireEvent.pointerUp(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    // main-track trim-in/out 沒有 cap/aud/ov 那種 zero-delta 不送的守門——一律送
    // updateClip（見 Timeline.tsx onPointerUp 的 trim-in/trim-out 分支）；echo 抵達前
    // trimPreview 理論上該綁 pending，但這裡從未被寫入過，維持 null，不需要額外清空。
    expect(sent).toEqual([
      { name: 'updateClip', clipId: 'c1', patch: { in: 2, duration: 6, leadPad: 0 } },
    ]);
    expect(usePlayback.getState().trimPreview).toBeNull();
  });
});

describe('badge 邊界 clamp（fix round 1 I3）', () => {
  function badgeEl(container: HTMLElement): HTMLElement {
    const hits = Array.from(container.querySelectorAll('div')).filter((d) =>
      /^\d.*s(\s|$)/.test(d.textContent?.trim() ?? ''),
    );
    const el = hits.find((d) => d.children.length === 0);
    if (!el) throw new Error('badge element not found');
    return el as HTMLElement;
  }

  it('右緣把手拖到可捲範圍外：badge left 被夾在 [0, scrollWidth - badgeWidth] 內，不飄出', () => {
    // width = max(timeToPx(10,40)+120, 600) = 600；估計 badge 寬 100 → clamp 上限 500px。
    // c2 起點 6，把右緣拖到遠超過 12.5s（500px）的位置，驗證 badge 沒有跟到裸值飄出去。
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'clip two'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // +10s（400px）：c2 duration 4→14，右緣 6+14=20（裸值 timeToPx(20,40)=800，遠超 500 上限）
      fireEvent.pointerMove(right!, { clientX: 500, pointerId: 1, bubbles: true });
    });
    const el = badgeEl(container);
    const left = Number.parseFloat(el.style.left);
    expect(left).toBeLessThanOrEqual(500);
    expect(left).toBeGreaterThanOrEqual(0);
  });

  it('trim-in 拖到起點 0 附近：badge left 不小於 0（下界）', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one')); // c1 起點 0，in 把手左緣本就貼 0
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 100, pointerId: 1, bubbles: true }); // 沒有位移
    });
    const el = badgeEl(container);
    const leftPx = Number.parseFloat(el.style.left);
    expect(leftPx).toBeGreaterThanOrEqual(0);
  });

  it('主軌 trim badge 的 top 位在尺規列下方，不結構性蓋住尺規時間標（top > RULER_H）', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    const el = badgeEl(container);
    const top = Number.parseFloat(el.style.top);
    const RULER_H = 20; // Timeline.tsx 內部常數，測試端另記一份數值避免匯出私有常數
    expect(top).toBeGreaterThan(RULER_H);
  });
});

describe('主軌拖出黑墊的視覺語言（Plan 14 Task 4，取代舊的 in=0 danger/min 語意）', () => {
  // c1：in=2 duration=6，往左拉 2.5s（100px @ 40pps）：x=2, x'=2-2.5=-0.5
  // （遠超 8px/40pps=0.2s 吸附閾值，不吸附）→ in=0, leadPad=0.5, duration=8.5。
  const TO_ZERO_PX = 2 * PPS; // 80

  it('trim-in 拖出黑墊：in 把手帶 accent class（不是 danger），out 把手不受影響', () => {
    const { container } = render(<Timeline />);
    const clip = chipByText(container, 'clip one');
    const [left, right] = handles(clip);
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 100 - TO_ZERO_PX - 20, pointerId: 1, bubbles: true });
    });
    expect(left!.className).toContain('accent');
    expect(left!.className).not.toContain('danger');
    expect(right!.className).not.toContain('danger');
    expect(right!.className).not.toContain('accent');
  });

  it('trim-in 拖出黑墊：badge 附加 black +X.Xs 標記', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 100 - TO_ZERO_PX - 20, pointerId: 1, bubbles: true });
    });
    expect(container.textContent).toContain('8.5s (+2.5s) · black +0.5s');
  });

  it('trim-in 未拖出黑墊：沒有 accent class，badge 沒有 black 標記', () => {
    const { container } = render(<Timeline />);
    const clip = chipByText(container, 'clip one');
    const [left, right] = handles(clip);
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 只拖 -1s，遠不到 in=0（還剩 1s 素材，不進黑墊）
      fireEvent.pointerMove(left!, { clientX: 60, pointerId: 1, bubbles: true });
    });
    expect(left!.className).not.toContain('accent');
    expect(left!.className).not.toContain('danger');
    expect(right!.className).not.toContain('danger');
    expect(container.textContent).not.toContain('black');
  });

  it('trim-out 拖曳（非 in 把手）：即使同一個 clip，accent 態不觸發（黑墊只約束左緣）', () => {
    const { container } = render(<Timeline />);
    const clip = chipByText(container, 'clip one');
    const [left, right] = handles(clip);
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true }); // +1s
    });
    expect(left!.className).not.toContain('accent');
    expect(left!.className).not.toContain('danger');
    expect(right!.className).not.toContain('danger');
  });

  it('放手後 accent 態與 black 標記一起消失（回到一般顯示，但 ClipBlock 上黑帶仍照 committed leadPad 顯示——見下方 pending 覆蓋測試）', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 100 - TO_ZERO_PX - 20, pointerId: 1, bubbles: true });
    });
    expect(left!.className).toContain('accent');
    act(() => {
      fireEvent.pointerUp(left!, { clientX: 100 - TO_ZERO_PX - 20, pointerId: 1, bubbles: true });
    });
    // 放手後 badge（浮動時長標籤）消失，不再顯示帶號增減——但 pending 覆蓋讓 ClipBlock
    // 本身繼續用新 leadPad 顯示黑帶（下方測試覆蓋這條），accent handle class 是 badge
    // 拖曳態的一部分，這裡驗證的是「拖曳中專屬的視覺（badge/class）跟著手勢結束」。
    expect(container.textContent).not.toMatch(/\(\+|\(−/);
  });

  it('拖出黑墊、放手（pending 尚未被 echo 對帳掉）：ClipBlock 黑帶仍照 pending 的新 leadPad 顯示', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 100 - TO_ZERO_PX - 20, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerUp(left!, { clientX: 100 - TO_ZERO_PX - 20, pointerId: 1, bubbles: true });
    });
    const band = container.querySelector<HTMLElement>('[data-testid="clip-leadpad"]');
    expect(band).not.toBeNull();
    expect(band!.style.width).toBe('20px'); // 0.5s @ 40pps
  });

  it('拉過界長出黑墊、再縮回：先吃掉黑墊，in 仍為 0（trimInPad 的往返語意，見 dragMath.test.ts 的純函數覆蓋）', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one')); // c1 in=2 duration=6，R=8
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // -3s（120px）：x=2, x'=2-3=-1 → in=0 leadPad=1 duration=9
      fireEvent.pointerMove(left!, { clientX: -20, pointerId: 1, bubbles: true });
    });
    expect(container.textContent).toContain('9.0s (+3.0s) · black +1.0s');
    act(() => {
      // 縮回 0.5s（+20px）：x'=-1+0.5=-0.5 → 仍 <0，in=0 leadPad=0.5 duration=8.5
      // （先吃黑墊，in 還沒開始動）
      fireEvent.pointerMove(left!, { clientX: 0, pointerId: 1, bubbles: true });
    });
    expect(container.textContent).toContain('8.5s (+2.5s) · black +0.5s');
  });

  it('拉過界後完全縮回起點：黑墊吃完、in 開始從 0 回升，回到拖曳前的原值', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one')); // c1 in=2 duration=6
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // -3s：in=0 leadPad=1 duration=9
      fireEvent.pointerMove(left!, { clientX: -20, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 完全縮回起點（+3s，回到 clientX=100）：deltaSec 相對起手點=0 → 原值 duration=6
      fireEvent.pointerMove(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    expect(container.textContent).toContain('6.0s (+0.0s)');
    expect(container.textContent).not.toContain('black');
  });

  it("in=0 邊界來源座標吸附：在 8px 閾值內時黏住 x'=0（leadPad 落地為 0，不進黑墊）", () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one')); // c1 in=2 duration=6，R=8
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // -2s（80px）+ 5px：x=2, 未吸附時 x'=2-2.125=-0.125（0.125s=5px @ 40pps，
      // 在 8px 閾值內）→ 吸附黏住 x'=0 → in=0 leadPad=0 duration=8
      fireEvent.pointerMove(left!, { clientX: 100 - 80 - 5, pointerId: 1, bubbles: true });
    });
    expect(container.textContent).toContain('8.0s (+2.0s)');
    expect(container.textContent).not.toContain('black');
  });

  it('in=0 邊界吸附命中時畫吸附導線於 clipStart（沿用既有 boxShadow 視覺語彙）', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 100 - 80 - 5, pointerId: 1, bubbles: true }); // 吸附命中
    });
    const lines = Array.from(container.querySelectorAll('div')).filter(
      (d) => (d as HTMLElement).style.boxShadow === '0 0 6px var(--accent-glow-strong)',
    );
    expect(lines.length).toBeGreaterThan(0);
  });

  it('超出 8px 閾值：不吸附，正常長出黑墊（對照組，確認吸附有邊界不是全域生效）', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // -2s + 9px：0.225s（9px）超過閾值，不吸附
      fireEvent.pointerMove(left!, { clientX: 100 - 80 - 9, pointerId: 1, bubbles: true });
    });
    expect(container.textContent).not.toContain('8.0s (+2.0s)');
    expect(container.textContent).toContain('black');
  });
});

describe('audio out 把手頂到來源長度上限的視覺語言（Plan 12 Task 3 裁決 5，終審 P1 收掉）', () => {
  // a1：mediaId m2（probe.duration=30），in=1 duration=5 → 來源右緣 6，
  // 最多還能拉長 24s（960px @ 40pps）才頂到 mediaDur。
  const ROOM_TO_MAX_PX = (30 - (1 + 5)) * PPS; // 960

  it('audio trim-out 拖到來源盡頭：out 把手帶 danger class', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'bgm'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 拖超過剩餘空間（+50px）：clamp 應把 duration 頂在 mediaDur - in 邊界
      fireEvent.pointerMove(right!, {
        clientX: 100 + ROOM_TO_MAX_PX + 50,
        pointerId: 1,
        bubbles: true,
      });
    });
    expect(right!.className).toContain('danger');
  });

  it('audio trim-out 拖到來源盡頭：badge 附加 max 標記', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'bgm'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, {
        clientX: 100 + ROOM_TO_MAX_PX + 50,
        pointerId: 1,
        bubbles: true,
      });
    });
    expect(container.textContent).toContain('· max');
  });

  it('audio trim-out 未拖到盡頭：沒有 danger class，badge 沒有 max 標記', () => {
    const { container } = render(<Timeline />);
    const [left, right] = handles(chipByText(container, 'bgm'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 只拖 +1s，遠不到 24s 的剩餘空間
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    expect(right!.className).not.toContain('danger');
    expect(left!.className).not.toContain('danger');
    expect(container.textContent).not.toContain('max');
  });

  it('audio trim-in（非 out 把手）：即使同一個 item，max danger 態不觸發（來源上限只約束右緣）', () => {
    const { container } = render(<Timeline />);
    const [left, right] = handles(chipByText(container, 'bgm'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 60, pointerId: 1, bubbles: true }); // -1s
    });
    expect(left!.className).not.toContain('danger');
    expect(right!.className).not.toContain('danger');
  });

  it('放手後 danger 態與 max 標記一起消失（回到一般顯示）', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'bgm'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, {
        clientX: 100 + ROOM_TO_MAX_PX + 50,
        pointerId: 1,
        bubbles: true,
      });
    });
    expect(right!.className).toContain('danger');
    act(() => {
      fireEvent.pointerUp(right!, {
        clientX: 100 + ROOM_TO_MAX_PX + 50,
        pointerId: 1,
        bubbles: true,
      });
    });
    expect(right!.className).not.toContain('danger');
    expect(container.textContent).not.toContain('max');
  });

  it('audio 缺 probe 資料（無已知上限）時，即使拖很遠也不觸發 danger（mirror isAtSourceMax 的 Infinity guard）', () => {
    // 把 a1 的來源媒體 m2 的 probe.duration 拿掉，模擬「無 probe 資料」情境
    // ——`media?.probe.duration ?? Infinity` 這條既有 fallback 只認 nullish，
    // `delete` 讓存取回傳 undefined 才會真的落進 `?? Infinity`。
    const doc = seedProject();
    const audioMedia = doc.media.find((m) => m.id === 'm2')!;
    // @ts-expect-error 測試刻意製造「缺 probe.duration」的情境（型別上是必填欄位）
    delete audioMedia.probe.duration;
    seedProject(doc);
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'bgm'));
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 拖非常遠——沒有已知上限時 clamp 不會啟動，也不該有 danger
      fireEvent.pointerMove(right!, { clientX: 100 + 100000, pointerId: 1, bubbles: true });
    });
    expect(right!.className).not.toContain('danger');
    expect(container.textContent).not.toContain('max');
  });
});

/**
 * Plan 15 Task 2：trim 拖曳佔位黑墊——把 Task 1 的積木（`trimPlaceholder`／
 * ClipBlock 的 `placeholderHead`/`placeholderTail`）接進 Timeline.tsx 的兩個 trim
 * 分支。統一拖曳模型核心式子見需求書：修剪方向（`next.duration < orig.duration`）
 * clip 的時間軸足跡維持 `orig.duration` 不變，其他 clip 不 ripple；擴張方向
 * （`next.duration >= orig.duration`）placeholder 恆 0，行為與 Plan 12/14 逐位元組
 * 相同。demo 專案：c1 in=2 duration=6（clipStart=0），c2 in=0 duration=4
 * （clipStart=6，frozen），總長 10，PPS=40。
 */
describe('trim 拖曳佔位黑墊（Plan 15 Task 2，統一拖曳模型接線）', () => {
  it('【使用者回報的原始場景】第一支 clip、scrollLeft=0、往右修剪：把手跟手、後續 clip 版面每幀不動、放手後 commit 正確且版面閉合', () => {
    const { container } = render(<Timeline />);
    const scrollEl = Array.from(container.querySelectorAll('div')).find(
      (d) => (d as HTMLElement).style.overflow === 'auto',
    ) as HTMLDivElement;
    expect(scrollEl.scrollLeft).toBe(0);
    const c2Before = chipByText(container, 'clip two');
    expect(c2Before.style.left).toBe('240px'); // clipStart=6 * 40pps

    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 往右拖 2s（80px）：in 2→4，duration 6→4（修剪方向，佔位 2s＝80px）
      fireEvent.pointerMove(left!, { clientX: 180, pointerId: 1, bubbles: true });
    });
    // 修剪方向補償量恆為 0（final-review Minor 2 修法：釘回起手值，不是完全不寫）
    // ——這裡起手值本身就是 0，所以看起來像「沒被碰」，這正是使用者回報的 bug 成因：
    // 舊行為會把負補償量截斷在 0，把手因此脫手。
    expect(scrollEl.scrollLeft).toBe(0);
    // 把手跟手：留在頭端佔位右緣＝clipStart(0) + placeholderPx(80)，選取態
    // overflowOffset=-6（chip 未進入窄片門檻，w=240px）。
    const [leftAfter] = handles(chipByText(container, 'clip one'));
    expect((leftAfter as HTMLElement).style.left).toBe('74px'); // -6 + 80
    // 後續 clip（c2）版面不動——足跡由佔位撐住，orig.duration=6 不變。
    const c2Mid = chipByText(container, 'clip two');
    expect(c2Mid.style.left).toBe('240px');
    // c1 自身 chip 寬度＝含佔位的視覺足跡，維持 orig.duration=6 對應的 240px。
    const c1Chip = c2Mid.parentElement
      ? Array.from(c2Mid.parentElement.children).find((el) =>
          (el as HTMLElement).title?.startsWith('clip one'),
        )
      : null;
    expect((c1Chip as HTMLElement).style.width).toBe('240px');

    act(() => flushRaf());
    // playhead 追到把手實際位置（clipStart + placeholder = 0 + 2 = 2）
    expect(usePlayback.getState().time).toBe(2);

    act(() => {
      fireEvent.pointerUp(left!, { clientX: 180, pointerId: 1, bubbles: true });
    });
    // 放手 commit：欄位不變（in/duration/leadPad），版面閉合——佔位消失，
    // c1 收斂回真實 duration=4（160px），c2 仍在 240px（未受影響)。
    expect(sent).toEqual([
      { name: 'updateClip', clipId: 'c1', patch: { in: 4, duration: 4, leadPad: 0 } },
    ]);
    expect(container.querySelector('[data-testid="clip-placeholder-head"]')).toBeNull();
    const c1After = Array.from(container.querySelectorAll('div')).find((d) =>
      (d as HTMLElement).title?.startsWith('clip one'),
    ) as HTMLElement;
    expect(c1After.style.width).toBe('160px'); // 4s*40pps，佔位收斂
    // 版面閉合：佔位消失後 c1 的真實足跡縮短為 4s，c2 這時才 ripple 補上——
    // 拖曳「過程」中 c2 不動（上面已驗證），commit 落地才是它真正該讓位的時機。
    const c2After = chipByText(container, 'clip two');
    expect(c2After.style.left).toBe('160px'); // clipStart 收斂到 c1 的新 duration
  });

  it('trim-out 往左修剪（尾端佔位）：把手停在內容右緣，chip 寬度維持 orig.duration，後續 clip 不動', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'clip one')); // c1 duration=6
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 往左拖 2s（80px）：duration 6→4（修剪方向，尾端佔位 2s）
      fireEvent.pointerMove(right!, { clientX: 20, pointerId: 1, bubbles: true });
    });
    const tail = container.querySelector<HTMLElement>('[data-testid="clip-placeholder-tail"]');
    expect(tail).not.toBeNull();
    expect(tail!.style.width).toBe('80px'); // 2s*40pps
    // out 把手＝內容右緣＝佔位左緣，overflowOffset(-6) + placeholderTailPx(80)
    const [, rightAfter] = handles(chipByText(container, 'clip one'));
    expect((rightAfter as HTMLElement).style.right).toBe('74px');
    // c1 chip 寬度維持 orig.duration=6 對應的 240px；c2 版面不動。
    const c1Chip = Array.from(container.querySelectorAll('div')).find((d) =>
      (d as HTMLElement).title?.startsWith('clip one'),
    ) as HTMLElement;
    expect(c1Chip.style.width).toBe('240px');
    expect(chipByText(container, 'clip two').style.left).toBe('240px');

    act(() => flushRaf());
    expect(usePlayback.getState().time).toBe(4); // clipStart(0) + dur(4)

    act(() => {
      fireEvent.pointerUp(right!, { clientX: 20, pointerId: 1, bubbles: true });
    });
    expect(sent).toEqual([
      { name: 'updateClip', clipId: 'c1', patch: { in: 2, duration: 4, leadPad: 0 } },
    ]);
    expect(container.querySelector('[data-testid="clip-placeholder-tail"]')).toBeNull();
  });

  it('同手勢往右再往左跨方向：placeholder 連續歸零、擴張接手（scrollLeft 補償重新套用）', () => {
    const { container } = render(<Timeline />);
    const scrollEl = Array.from(container.querySelectorAll('div')).find(
      (d) => (d as HTMLElement).style.overflow === 'auto',
    ) as HTMLDivElement;
    const [left] = handles(chipByText(container, 'clip one')); // in=2 duration=6
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 往右拖 2s：duration 6→4（修剪方向，佔位 2s）
      fireEvent.pointerMove(left!, { clientX: 180, pointerId: 1, bubbles: true });
    });
    expect(
      container.querySelector<HTMLElement>('[data-testid="clip-placeholder-head"]')!.style.width,
    ).toBe('80px');
    expect(scrollEl.scrollLeft).toBe(0); // 修剪方向不補償

    act(() => {
      // 拉回起點：delta=0 → duration=6（== orig，邊界歸擴張方向，佔位=0）
      fireEvent.pointerMove(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    expect(container.querySelector('[data-testid="clip-placeholder-head"]')).toBeNull();
    expect(scrollEl.scrollLeft).toBe(0); // 補償量 0（回到 orig）

    act(() => {
      // 繼續往左拖過起點 1s（40px）：deltaSec=-1 → duration 6→7（擴張方向，還原素材）
      fireEvent.pointerMove(left!, { clientX: 60, pointerId: 1, bubbles: true });
    });
    expect(container.querySelector('[data-testid="clip-placeholder-head"]')).toBeNull();
    // 擴張方向：捲動補償重新套用，行為與 Plan 12 逐位元組相同
    // （deltaPx = timeToPx(7,40) - timeToPx(6,40) = 40）
    expect(scrollEl.scrollLeft).toBe(40);
  });

  it('final-review Minor 2 回歸釘：同手勢先擴張再修剪（相反順序），scrollLeft 隨修剪回退到起手值，不殘留擴張階段的值', () => {
    const { container } = render(<Timeline />);
    const scrollEl = Array.from(container.querySelectorAll('div')).find(
      (d) => (d as HTMLElement).style.overflow === 'auto',
    ) as HTMLDivElement;
    const [left] = handles(chipByText(container, 'clip one')); // in=2 duration=6
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 往左拖過起點 1s（40px）：deltaSec=-1 → duration 6→7（擴張方向，還原素材）
      // deltaPx = timeToPx(7,40) - timeToPx(6,40) = 40，scrollLeft 從起手值 0 寫成 40。
      fireEvent.pointerMove(left!, { clientX: 60, pointerId: 1, bubbles: true });
    });
    expect(container.querySelector('[data-testid="clip-placeholder-head"]')).toBeNull();
    expect(scrollEl.scrollLeft).toBe(40);

    act(() => {
      // 轉向修剪：deltaSec 恆相對 d.startX（100）重算，不是相對上一幀增量——
      // clientX=180 → deltaSec=+2 → nextX=min(2+2,7.9)=4 → in=4, duration=8-4=4
      // （修剪方向，相對起手 orig.duration=6 的佔位＝2s=80px）。
      // 舊寫法（完全不碰 scrollLeft）會讓它停留在擴張階段最後一幀寫入的 40，不回退——
      // 這正是 final-review Minor 2 記錄的殘留。新寫法每幀都把它釘回起手值 0。
      fireEvent.pointerMove(left!, { clientX: 180, pointerId: 1, bubbles: true });
    });
    expect(
      container.querySelector<HTMLElement>('[data-testid="clip-placeholder-head"]')!.style.width,
    ).toBe('80px'); // 2s*40pps
    expect(scrollEl.scrollLeft).toBe(0); // 回退到起手值，不殘留擴張階段的 40
  });

  it('帶 leadPad 的 clip 往右修：先吃墊（排列 [佔位][餘墊][內容]）', () => {
    const doc = demoProject();
    doc.tracks.video[0]!.leadPad = 1; // c1 起手已有 1s 真 leadPad（in=2 leadPad=1）
    seedProject(doc);
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 往右拖 0.5s（20px）：x=in-leadPad=2-1=1，x'=1.5，duration 6→5.5（修剪方向，
      // 佔位 0.5s）——leadPad 先被吃掉一部分（trimInPad 的 x'>=0 分支落地 leadPad=0，
      // 見 dragMath.ts 註解），不是先動內容。
      fireEvent.pointerMove(left!, { clientX: 120, pointerId: 1, bubbles: true });
    });
    const head = container.querySelector<HTMLElement>('[data-testid="clip-placeholder-head"]');
    expect(head).not.toBeNull();
    expect(head!.style.width).toBe('20px'); // 0.5s*40pps
    // leadPad 已被吃到 0（trimInPad x'=1.5>=0 分支：leadPad:0, in:1.5）——
    // 排列此刻是 [佔位 20px][leadPad 0px][內容]，沒有殘留黑帶。
    expect(container.querySelector('[data-testid="clip-leadpad"]')).toBeNull();

    act(() => flushRaf());
    act(() => {
      fireEvent.pointerUp(left!, { clientX: 120, pointerId: 1, bubbles: true });
    });
    expect(sent).toEqual([
      { name: 'updateClip', clipId: 'c1', patch: { in: 1.5, duration: 5.5, leadPad: 0 } },
    ]);
  });

  it('回歸釘：擴張方向（trim-in 拉超過來源起點、長出真 leadPad）不畫佔位，捲動補償與現況一致', () => {
    const { container } = render(<Timeline />);
    const scrollEl = Array.from(container.querySelectorAll('div')).find(
      (d) => (d as HTMLElement).style.overflow === 'auto',
    ) as HTMLDivElement;
    const [left] = handles(chipByText(container, 'clip one')); // in=2 duration=6，R=8
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 往左拖 3s（120px）：x=2, x'=-1（超過 8px 吸附閾值）→ in=0 leadPad=1 duration=9
      fireEvent.pointerMove(left!, { clientX: -20, pointerId: 1, bubbles: true });
    });
    expect(container.querySelector('[data-testid="clip-placeholder-head"]')).toBeNull();
    expect(container.querySelector('[data-testid="clip-placeholder-tail"]')).toBeNull();
    // 既有黑帶（真 leadPad）仍照舊顯示——與佔位是兩回事
    const pad = container.querySelector<HTMLElement>('[data-testid="clip-leadpad"]');
    expect(pad).not.toBeNull();
    expect(pad!.style.width).toBe('40px'); // leadPad=1s*40pps
    // 捲動補償：deltaPx = timeToPx(9,40) - timeToPx(6,40) = 120（Plan 12 既有行為）
    expect(scrollEl.scrollLeft).toBe(120);
  });

  it('回歸釘：trim-out 擴張方向（拉長）維持現況即時 ripple，不出現尾端佔位', () => {
    const { container } = render(<Timeline />);
    const [, right] = handles(chipByText(container, 'clip one')); // duration=6
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 往右拖 1s（40px）：duration 6→7（擴張，ripple 立即生效）
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    expect(container.querySelector('[data-testid="clip-placeholder-tail"]')).toBeNull();
    // c2 立即 ripple 到新位置（7s*40pps=280px），不是停在原地
    expect(chipByText(container, 'clip two').style.left).toBe('280px');
  });

  it('回歸釘：無拖曳時渲染輸出不變（無 placeholder 相關 DOM）', () => {
    const { container } = render(<Timeline />);
    expect(container.querySelector('[data-testid="clip-placeholder-head"]')).toBeNull();
    expect(container.querySelector('[data-testid="clip-placeholder-tail"]')).toBeNull();
    expect(chipByText(container, 'clip one').style.width).toBe('240px'); // 6s*40pps
    expect(chipByText(container, 'clip two').style.left).toBe('240px'); // clipStart=6
  });

  it('cancel 路徑：修剪方向拖出佔位後 pointercancel，佔位消失且不 commit（preview 清掉即可，無新狀態要清）', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 180, pointerId: 1, bubbles: true }); // +2s，佔位 2s
    });
    expect(container.querySelector('[data-testid="clip-placeholder-head"]')).not.toBeNull();
    act(() => {
      fireEvent.pointerCancel(left!, { clientX: 180, pointerId: 1, bubbles: true });
    });
    expect(sent).toEqual([]); // 不 commit
    expect(container.querySelector('[data-testid="clip-placeholder-head"]')).toBeNull();
    expect(chipByText(container, 'clip one').style.width).toBe('240px'); // 退回原值
  });
});
