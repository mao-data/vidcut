import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import type { Command } from '@vidcut/shared';
import { Timeline } from './Timeline.js';
import { useView } from '../stores/view.js';
import { usePlayback } from '../stores/playback.js';
import { useProject } from '../stores/project.js';
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
    // echo 尚未抵達（doc 沒變，這個測試不模擬 server）：total 應還原到手勢開始前的
    // committed 值，不會卡在墊高的 12（正常路徑的保底行為）。
    expect(usePlayback.getState().total).toBe(10);
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

  it('主軌 trim-in 期間 in 仍在 0 硬停點 clamp（裁決 2 只拿掉吸附，不動既有 clamp）', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one')); // c1 in=2 duration=6
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 往左拉 3s（120px）：in 2→0 恰好落地；duration 6→8（in=0 clamp 生效）
      fireEvent.pointerMove(left!, { clientX: -20, pointerId: 1, bubbles: true });
    });
    expect(container.textContent).toContain('8.0s (+2.0s)');
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
    expect(usePlayback.getState().trimPreview).toEqual({ clipId: 'c1', in: 3 });
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
    expect(usePlayback.getState().trimPreview).toEqual({ clipId: 'c1', in: 4 });
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
    expect(usePlayback.getState().trimPreview).toEqual({ clipId: 'c1', in: 3 });
    expect(sent).toEqual([{ name: 'updateClip', clipId: 'c1', patch: { in: 3, duration: 5 } }]);
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

  it('放手時取消尚未 flush 的 rAF：trimPreview 從未被寫入過（維持 null），放手後也不會補寫', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    // 故意不 flush，直接放手——trimPreview 從未經過 rAF 寫入，維持初始 null
    act(() => {
      fireEvent.pointerUp(left!, { clientX: 140, pointerId: 1, bubbles: true });
    });
    act(() => flushRaf()); // 已取消的 rAF：不會補寫
    expect(usePlayback.getState().trimPreview).toBeNull();
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
    expect(sent).toEqual([{ name: 'updateClip', clipId: 'c1', patch: { in: 2, duration: 6 } }]);
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

describe('主軌 in=0 素材用盡的視覺語言（Plan 12 Task 3 裁決 4，isAtSourceMax 的對稱雙生）', () => {
  // c1：in=2 duration=6，往左拉 2s（80px @ 40pps）恰好頂到 in=0。
  const TO_ZERO_PX = 2 * PPS; // 80

  it('trim-in 拖到 in=0：in 把手帶 danger class，out 把手不受影響', () => {
    const { container } = render(<Timeline />);
    const clip = chipByText(container, 'clip one');
    const [left, right] = handles(clip);
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 拖超過剩餘素材（+20px）：clamp 應把 in 頂在 0
      fireEvent.pointerMove(left!, { clientX: 100 - TO_ZERO_PX - 20, pointerId: 1, bubbles: true });
    });
    expect(left!.className).toContain('danger');
    expect(right!.className).not.toContain('danger');
  });

  it('trim-in 拖到 in=0：badge 附加 min 標記', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 100 - TO_ZERO_PX - 20, pointerId: 1, bubbles: true });
    });
    expect(container.textContent).toContain('· min');
  });

  it('trim-in 未拖到 in=0：沒有 danger class，badge 沒有 min 標記', () => {
    const { container } = render(<Timeline />);
    const clip = chipByText(container, 'clip one');
    const [left, right] = handles(clip);
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      // 只拖 -1s，遠不到 in=0（還剩 1s 素材）
      fireEvent.pointerMove(left!, { clientX: 60, pointerId: 1, bubbles: true });
    });
    expect(left!.className).not.toContain('danger');
    expect(right!.className).not.toContain('danger');
    expect(container.textContent).not.toContain('min');
  });

  it('trim-out 拖曳（非 in 把手）：即使同一個 clip，min danger 態不觸發（in=0 只約束左緣）', () => {
    const { container } = render(<Timeline />);
    const clip = chipByText(container, 'clip one');
    const [left, right] = handles(clip);
    act(() => {
      fireEvent.pointerDown(right!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(right!, { clientX: 140, pointerId: 1, bubbles: true }); // +1s
    });
    expect(left!.className).not.toContain('danger');
    expect(right!.className).not.toContain('danger');
  });

  it('放手後 danger 態與 min 標記一起消失（回到一般顯示）', () => {
    const { container } = render(<Timeline />);
    const [left] = handles(chipByText(container, 'clip one'));
    act(() => {
      fireEvent.pointerDown(left!, { clientX: 100, pointerId: 1, bubbles: true });
    });
    act(() => {
      fireEvent.pointerMove(left!, { clientX: 100 - TO_ZERO_PX - 20, pointerId: 1, bubbles: true });
    });
    expect(left!.className).toContain('danger');
    act(() => {
      fireEvent.pointerUp(left!, { clientX: 100 - TO_ZERO_PX - 20, pointerId: 1, bubbles: true });
    });
    expect(left!.className).not.toContain('danger');
    expect(container.textContent).not.toContain('min');
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
