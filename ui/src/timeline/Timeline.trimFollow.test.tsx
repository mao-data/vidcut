import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import type { Command } from '@vidcut/shared';
import { Timeline } from './Timeline.js';
import { useView } from '../stores/view.js';
import { usePlayback } from '../stores/playback.js';
import * as ws from '../ws.js';
import { seedProject, resetStores } from '../test/fixtures.js';

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
      // c1: in=2 duration=6，clip 起點 0；+1s(40px) → in 3 duration 5，clip 起點仍 0
      fireEvent.pointerMove(left!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    // rAF 還沒 flush：不該提早跳
    expect(usePlayback.getState().time).toBe(0);
    act(() => flushRaf());
    expect(usePlayback.getState().time).toBe(0); // trim-in 邊＝clip 新起點，仍是 0（in 拖不動起點時間）
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

  it('放手後 playhead 停在邊上，不彈回', () => {
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
    expect(usePlayback.getState().time).toBe(7);
  });

  it('放手時取消尚未 flush 的 rAF（不會在放手後才追加一次跳動）', () => {
    const { container } = render(<Timeline />);
    const clip = chipByText(container, 'clip one');
    const [, right] = handles(clip);
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    // 故意不 flush，直接放手
    act(() => {
      fireEvent.pointerUp(right!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    const beforeFlush = usePlayback.getState().time;
    act(() => flushRaf());
    expect(usePlayback.getState().time).toBe(beforeFlush);
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
    // echo 尚未抵達（doc 沒變，這個測試不模擬 server）：total 應還原到手勢開始前的
    // committed 值，不會卡在墊高的 12（正常路徑的保底行為）。
    expect(usePlayback.getState().total).toBe(10);
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
