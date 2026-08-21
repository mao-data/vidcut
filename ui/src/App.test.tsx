import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import type { Command } from '@vidcut/shared';
import { App } from './App.js';
import { usePlayback } from './stores/playback.js';
import { useSelection } from './stores/selection.js';
import { useView } from './stores/view.js';
import { useToast } from './stores/toast.js';
import * as ws from './ws.js';
import { seedProject, resetStores, demoProject } from './test/fixtures.js';

let sent: Command[];

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    fireEvent.keyDown(window, { key, ...init });
  });
}

describe('App', () => {
  beforeEach(() => {
    resetStores();
    sent = [];
    vi.spyOn(ws, 'sendCommand').mockImplementation((c: Command) => {
      sent.push(c);
    });
    vi.spyOn(ws, 'sendContext').mockImplementation(() => {});
    // App 掛載時注入的 <style id="server-fonts"> 貼在 document.head,不在 RTL 的 render
    // container 裡——testing-library 的 cleanup() 不會清到它,不同 test 之間會殘留一顆空的,
    // 讓後面測 fetch 行為的 case 因為「id 已存在」guard 提早 return,根本沒真的打到 fetch。
    document.getElementById('server-fonts')?.remove();
    // toast 是模組級 zustand store，resetStores() 不管它：不清的話一個測試留下的
    // 訊息會殘留到下一個測試（App 每次 render 都會把它畫出來）。
    useToast.setState({ message: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals(); // 個別測試若 vi.stubGlobal('fetch', ...) 蓋過 setup.ts 的預設 shim,這裡還原
  });

  /**
   * 冷載入白屏（React #185）的回歸盔甲。
   * 病因是 zustand v5 的 selector 回傳新 reference（`?? []`）→ snapshot 不穩定 →
   * 同步無限重渲染。那個狀態下 render() 會直接丟例外，所以「掛得起來」就是斷言。
   */
  it('mounts with no project yet (cold load) without crashing', () => {
    expect(() => render(<App />)).not.toThrow();
  });

  it('mounts again once the project arrives', () => {
    const { container } = render(<App />);
    act(() => {
      seedProject();
    });
    // 斷言意圖=「專案抵達後畫面真的長出專案內容」。原本驗 header 的專案名
    // 'demo',2026-08-16 使用者定案把 `v{版本} · {專案名}` 從 header 移除,
    // 改驗時間軸上的 clip 標籤(同樣只有專案掛載成功才會出現)。
    expect(container.textContent).toContain('clip one');
  });

  // 舊斷言是 'Offline' → 'Connected'（header 的 ● 那組文字）。**經核准的規格變更**
  // （spec 2026-08-14-agent-presence-design §3.3）：那兩行已被 AgentStrip 紙條取代，
  // 連線與否變成紙條三態裡的一態。文字因此改成 'No agent' → 'Agent ready'。
  // 這條測的仍然是同一件事：header 有沒有把連線狀態誠實地顯示出來。
  // 紙條自己的完整三態/點擊/a11y 契約在 `ui/src/AgentStrip.test.tsx`。
  it('shows connection state in the header strip', () => {
    const { container } = render(<App />);
    expect(container.textContent).toContain('No agent');
    act(() => {
      seedProject();
    });
    expect(container.textContent).toContain('Agent ready');
  });

  /**
   * 版面骨架（使用者 2026-08-16 定案）。**縱切一刀**：AI 專區是全高的第一欄，
   * 時間軸從它的右緣開始、不再橫貫全寬。
   *
   * jsdom 沒有版面引擎（`getBoundingClientRect` 全是 0），所以這裡驗的是**產生
   * 那個版面的宣告本身**——grid 的行列指派。這不是「測 CSS」：`gridRow`／
   * `gridColumn` 是這個骨架唯一的載體，改掉其中一個就是改掉骨架，而那正是
   * 這兩條要擋的回歸。真正的視覺由主 session 在真瀏覽器驗收。
   */
  it('the AI column spans both rows and the timeline starts at its right edge', () => {
    seedProject();
    const { container } = render(<App />);
    const aiCol = container.querySelector<HTMLElement>('.panel-edge-r')!;
    // 跨兩列＝全高，時間軸那一列沒有它的格子
    expect(aiCol.style.gridRow).toBe('1 / 3');

    const timeline = container.querySelector<HTMLElement>('.panel-edge-t')!;
    // 從第二欄（預覽）起跳、吃到最右：左緣＝AI 欄右緣
    expect(timeline.style.gridColumn).toBe('2 / 4');
  });

  it('collapses and expands the side panels', () => {
    seedProject();
    render(<App />);
    expect(useView.getState().leftOpen).toBe(true);

    act(() => {
      useView.getState().toggleLeft();
    });
    expect(useView.getState().leftOpen).toBe(false);

    act(() => {
      useView.getState().toggleRight();
    });
    expect(useView.getState().rightOpen).toBe(false);
  });

  // 舊斷言是「右欄在 Captions ⇄ Activity 之間切」。**經核准的版面變更**
  // （使用者 2026-08-16 定案）：Activity 分頁退役——活動流搬進左邊的 AI 專區，
  // 右欄的第二個分頁改成 Properties（原左欄的表單）。這條測的仍然是同一件事：
  // 右欄的分頁切換有沒有真的換掉下面的內容。
  it('switches the right panel between captions and properties', () => {
    seedProject();
    const { getByText, container } = render(<App />);
    // Captions 是預設分頁：先確認 Properties 的閒置提示還沒出現
    expect(container.textContent).not.toContain('Select a clip');
    act(() => {
      fireEvent.click(getByText('Properties'));
    });
    expect(container.textContent).toContain('Select a clip');
  });

  // 選了東西 → 右欄自動跳到 Properties（舊版面「選了東西左欄變表單」那條反射的
  // 直譯）。**取消選取不自動跳走**：那是使用者按 Esc 的結果，把他從正在看的分頁
  // 彈開是第二次沒要求的動作；Properties 分頁自己顯示閒置提示。
  it('selecting something switches the right panel to Properties', () => {
    seedProject();
    const { container } = render(<App />);
    expect(container.textContent).not.toContain('Select a clip');

    act(() => {
      useSelection.getState().select({ kind: 'clip', id: 'c1' });
    });
    // 表單真的出現了（不只是分頁按鈕變亮）
    expect(container.textContent).toContain('clip one');
    expect(container.textContent).not.toContain('Select a clip');
  });

  it('selecting also expands the right panel (a tab you cannot see is not a tab)', () => {
    seedProject();
    render(<App />);
    act(() => {
      useView.getState().toggleRight(); // 先收起來
    });
    expect(useView.getState().rightOpen).toBe(false);

    act(() => {
      useSelection.getState().select({ kind: 'clip', id: 'c1' });
    });
    expect(useView.getState().rightOpen).toBe(true);
  });

  it('deselecting leaves the Properties tab in place, showing the idle prompt', () => {
    seedProject();
    const { container } = render(<App />);
    act(() => {
      useSelection.getState().select({ kind: 'clip', id: 'c1' });
    });
    expect(container.textContent).toContain('clip one');

    act(() => {
      useSelection.getState().select(null);
    });
    // 還在 Properties 分頁（沒有被彈回 Captions），只是換成閒置提示
    expect(container.textContent).toContain('Select a clip');
  });

  // 紙條的 onOpenActivity 是 App 傳進去的——這條驗的是**接線**（紙條自己的點擊
  // 契約在 AgentStrip.test.tsx，那裡的 callback 是 vi.fn()，證不了 App 真的把它
  // 接到版面上）。2026-08-16 版面重構後目的地從右欄的 Activity 分頁換成左邊的
  // AI 專區，語意不變：點紙條＝去看活動流，而且看得到。
  it('clicking the header agent strip expands the AI column so the activity feed is visible', () => {
    seedProject();
    const { container } = render(<App />);
    act(() => {
      useView.getState().toggleLeft(); // 先收起來
    });
    expect(useView.getState().leftOpen).toBe(false);

    act(() => {
      fireEvent.click(container.querySelector('.ap-strip')!);
    });
    expect(useView.getState().leftOpen).toBe(true);
    expect(container.textContent).toContain('No changes yet');
  });

  describe('keyboard shortcuts', () => {
    beforeEach(() => {
      seedProject();
      render(<App />);
      act(() => {
        usePlayback.getState().seek(3);
      });
    });

    it('space toggles playback', () => {
      expect(usePlayback.getState().playing).toBe(false);
      press(' ');
      expect(usePlayback.getState().playing).toBe(true);
      press(' ');
      expect(usePlayback.getState().playing).toBe(false);
    });

    it('S splits at the playhead', () => {
      press('s');
      expect(sent).toEqual([{ name: 'splitAt', time: 3 }]);
    });

    it('Q and W delete before/after the playhead', () => {
      press('q');
      press('w');
      expect(sent).toEqual([
        { name: 'deleteBefore', time: 3 },
        { name: 'deleteAfter', time: 3 },
      ]);
    });

    it('F freezes a frame at the playhead', () => {
      press('f');
      expect(sent).toEqual([{ name: 'freezeFrame', time: 3 }]);
    });

    it('N toggles snapping', () => {
      const before = useView.getState().snapEnabled;
      press('n');
      expect(useView.getState().snapEnabled).toBe(!before);
    });

    it('Cmd+Z undoes', () => {
      press('z', { metaKey: true });
      expect(sent).toEqual([{ name: 'undo', steps: 1 }]);
    });

    it('arrows step one frame; shift steps ten', () => {
      press('ArrowRight'); // 30fps → +1/30
      expect(usePlayback.getState().time).toBeCloseTo(3 + 1 / 30);
      press('ArrowLeft', { shiftKey: true }); // -10/30
      expect(usePlayback.getState().time).toBeCloseTo(3 + 1 / 30 - 10 / 30);
    });

    it('ignores shortcuts while typing in a field', () => {
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();
      act(() => {
        fireEvent.keyDown(input, { key: 's', bubbles: true });
      });
      expect(sent).toEqual([]);
      input.remove();
    });

    /**
     * 取消選取的第一條路徑（agent-presence 階段 4 的工項 0）。
     * 修的是既有缺陷：設定選取有九條路徑，清除只有三顆刪除鈕——選過任何東西之後
     * 就永遠回不到 Inspector 的閒置區（AI 索引卡就住在那裡）。
     */
    it('Escape clears the selection', () => {
      act(() => {
        useSelection.getState().select({ kind: 'clip', id: 'c1' });
      });
      press('Escape');
      expect(useSelection.getState().selected).toBeNull();
    });

    it('Escape sends no command (deselect is a view action, not an edit)', () => {
      act(() => {
        useSelection.getState().select({ kind: 'clip', id: 'c1' });
      });
      press('Escape');
      expect(sent).toEqual([]);
    });

    it('Escape while typing in a field leaves the selection alone', () => {
      // 打字中不攔：沿用同一顆 handler 開頭的 INPUT/TEXTAREA/contentEditable 守衛。
      // 沒有這條的話，在 Inspector 的欄位裡按 Escape（取消輸入法候選字、關閉自動完成）
      // 會把整個被編輯的物件從面板上取消掉——欄位連同表單一起消失。
      act(() => {
        useSelection.getState().select({ kind: 'clip', id: 'c1' });
      });
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();
      act(() => {
        fireEvent.keyDown(input, { key: 'Escape', bubbles: true });
      });
      expect(useSelection.getState().selected).toEqual({ kind: 'clip', id: 'c1' });
      input.remove();
    });

    it('Escape with a modifier is left to the browser', () => {
      // handler 的既有體例：`if (mod) return`（其餘帶修飾鍵的交給瀏覽器）。
      act(() => {
        useSelection.getState().select({ kind: 'clip', id: 'c1' });
      });
      press('Escape', { metaKey: true });
      expect(useSelection.getState().selected).toEqual({ kind: 'clip', id: 'c1' });
    });

    /**
     * Plan 11 Task 3（裁決 6）：`[`/`]` 把選取項的 in/out 修到 playhead——四種軌道
     * 通用（主軌 trimIn/trimOut 語意、其餘 trimSpan 系語意），與 Q/W（ripple 刪除、
     * 動全時間軸）語意區隔：`[`/`]` 只動選取項本身。playhead 固定在 3（外層
     * beforeEach 已 seek）。
     */
    describe('[/] trim 選取項到 playhead（Plan 11 Task 3 裁決 6）', () => {
      it('主軌 clip 選取：[ 送 updateClip 把 in 修到 playhead（trimIn 語意，右緣不動）', () => {
        // c1: in=2 duration=6，時間軸起點 0 → 右緣(來源)=8。playhead=3 落在 clip 內
        // （clipStart=0，[ 對應把「clip 起點」修到 playhead=3：deltaSec = 3-0 = 3）。
        act(() => {
          useSelection.getState().select({ kind: 'clip', id: 'c1' });
        });
        press('[');
        expect(sent).toEqual([{ name: 'updateClip', clipId: 'c1', patch: { in: 5, duration: 3 } }]);
      });

      it('主軌 clip 選取：] 送 updateClip 把 out 修到 playhead（trimOut 語意）', () => {
        // clipStart=0，] 對應「clip 右緣」修到 playhead=3：deltaSec = 3 - (0+6) = -3
        // → duration 6-3=3（clamp 到 MIN 之上，未超界）。
        act(() => {
          useSelection.getState().select({ kind: 'clip', id: 'c1' });
        });
        press(']');
        expect(sent).toEqual([{ name: 'updateClip', clipId: 'c1', patch: { duration: 3 } }]);
      });

      it('caption 選取：[ 送 updateCaption 把 start 修到 playhead（trimSpanIn，右緣不動）', () => {
        // cap1: start=1 duration=3，右緣=4。deltaSec = 3-1 = 2 → start=3 duration=1
        act(() => {
          useSelection.getState().select({ kind: 'caption', id: 'cap1' });
        });
        press('[');
        expect(sent).toEqual([
          { name: 'updateCaption', id: 'cap1', patch: { start: 3, duration: 1 } },
        ]);
      });

      it('caption 選取：] 送 updateCaption 把右緣修到 playhead（trimSpanOut）', () => {
        // start=1，deltaSec = 3-(1+3) = -1 → duration 3-1=2
        act(() => {
          useSelection.getState().select({ kind: 'caption', id: 'cap1' });
        });
        press(']');
        expect(sent).toEqual([{ name: 'updateCaption', id: 'cap1', patch: { duration: 2 } }]);
      });

      it('audio 選取：[ 送 updateAudio（trimAudioIn：start/in/duration 連動，右緣不動）', () => {
        // a1: start=2 in=1 duration=5，時間軸右緣=7。deltaSec = 3-2 = 1
        // → start=3 in=2 duration=4
        act(() => {
          useSelection.getState().select({ kind: 'audio', id: 'a1' });
        });
        press('[');
        expect(sent).toEqual([
          { name: 'updateAudio', id: 'a1', patch: { start: 3, in: 2, duration: 4 } },
        ]);
      });

      it('audio 選取：] 送 updateAudio 把右緣修到 playhead（trimSpanOut，來源長度仍夾住）', () => {
        // start=2，deltaSec = 3-(2+5) = -4 → duration 5-4=1
        act(() => {
          useSelection.getState().select({ kind: 'audio', id: 'a1' });
        });
        press(']');
        expect(sent).toEqual([{ name: 'updateAudio', id: 'a1', patch: { duration: 1 } }]);
      });

      it('overlay（絕對時間）選取：[ 送 updateOverlay 把 start 修到 playhead', () => {
        // ovAbs: start=1 duration=3，右緣=4。deltaSec = 3-1 = 2 → start=3 duration=1
        act(() => {
          useSelection.getState().select({ kind: 'overlay', id: 'ovAbs' });
        });
        press('[');
        expect(sent).toEqual([
          { name: 'updateOverlay', id: 'ovAbs', patch: { start: 3, duration: 1 } },
        ]);
      });

      it('overlay（絕對時間）選取：] 送 updateOverlay 把右緣修到 playhead', () => {
        // start=1，deltaSec = 3-(1+3) = -1 → duration 3-1=2
        act(() => {
          useSelection.getState().select({ kind: 'overlay', id: 'ovAbs' });
        });
        press(']');
        expect(sent).toEqual([{ name: 'updateOverlay', id: 'ovAbs', patch: { duration: 2 } }]);
      });

      it('overlay（到片尾，duration:null）選取：] 材料化成具體 duration（review round 1 Important 1：不能是 no-op）', () => {
        // 對齊 Timeline.tsx onPointerUp 'ov'/'out' 分支的既有語意（範圍裁決 4）：
        // out 把手拖曳會把 to-end overlay「材料化」成具體數字，[/]鍵盤路徑必須鏡射
        // 這個行為，不能因為 o.duration===null 就把算出來的 span 丟掉、送一個永遠
        // 是 no-op 的 { duration: null } patch。
        // ovAbs 改成 to-end：start=1 duration=null，總長 10（demoProject 的 c1+c2）
        // → effectiveSpan = 10-1 = 9，右緣=10。deltaSec = 3-(1+9) = -7 → span 9-7=2。
        const doc = demoProject();
        const ov = doc.tracks.overlays.find((o) => o.id === 'ovAbs')!;
        ov.duration = null;
        seedProject(doc);
        act(() => {
          useSelection.getState().select({ kind: 'overlay', id: 'ovAbs' });
        });
        press(']');
        expect(sent).toEqual([{ name: 'updateOverlay', id: 'ovAbs', patch: { duration: 2 } }]);
      });

      it('overlay（錨定式）選取：[ 換算回 anchor.offset（沿用拖曳放手的同一套算式）', () => {
        // ovAnchor: anchor={clipId:'c2',offset:0.5} duration=2。c2 起點=c1.duration=6，
        // 絕對 start=6.5，右緣=8.5。playhead=3 < absStart，deltaSec = 3-6.5 = -3.5
        // → absStart=3 duration=5.5（trimSpanIn clamp：start>=0 且不超過右緣-MIN，均滿足）
        // → offset = absStart - clipStart(6) = -3
        act(() => {
          useSelection.getState().select({ kind: 'overlay', id: 'ovAnchor' });
        });
        press('[');
        expect(sent).toEqual([
          {
            name: 'updateOverlay',
            id: 'ovAnchor',
            patch: { anchor: { clipId: 'c2', offset: -3 }, duration: 5.5 },
          },
        ]);
      });

      it('overlay（錨定式）選取：] 只送 duration（anchor/offset 不動，語意同拖曳 out 把手）', () => {
        // absStart=6.5，deltaSec = 3-(6.5+2) = -5.5 → duration 2-5.5 clamp 到 MIN(0.1)
        act(() => {
          useSelection.getState().select({ kind: 'overlay', id: 'ovAnchor' });
        });
        press(']');
        expect(sent).toEqual([{ name: 'updateOverlay', id: 'ovAnchor', patch: { duration: 0.1 } }]);
      });

      it('無選取時 [ ] 皆為 no-op（不送任何命令）', () => {
        expect(useSelection.getState().selected).toBeNull();
        press('[');
        press(']');
        expect(sent).toEqual([]);
      });

      it('輸入框聚焦時 [ ] 不觸發（既有 INPUT/TEXTAREA 守衛）', () => {
        act(() => {
          useSelection.getState().select({ kind: 'clip', id: 'c1' });
        });
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        act(() => {
          fireEvent.keyDown(input, { key: '[', bubbles: true });
          fireEvent.keyDown(input, { key: ']', bubbles: true });
        });
        expect(sent).toEqual([]);
        input.remove();
      });

      it('] 不驅動 playhead（一次性命令，不是拖曳手勢——修剪點本來就是 playhead 本身）', () => {
        act(() => {
          useSelection.getState().select({ kind: 'clip', id: 'c1' });
        });
        press(']');
        expect(usePlayback.getState().time).toBe(3);
      });
    });
  });

  it('reports editor context to the AI without subscribing the tree to the playhead', async () => {
    vi.useFakeTimers();
    seedProject();
    render(<App />);
    const spy = vi.mocked(ws.sendContext);
    spy.mockClear();

    act(() => {
      usePlayback.getState().seek(4);
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ playhead: 4 }));
    vi.useRealTimers();
  });

  it('surfaces a rejected edit as a toast', () => {
    // 舊版是「applyServerMsg({type:'commandError'}) 之後 textContent 含 'demo'」——
    // 'demo' 是專案名,沒有 toast 也一直都在,而且 applyServerMsg 對 commandError
    // 本來就是 no-op(toast 是 ws.ts 的 onmessage 發的),那條斷言測不到任何東西。
    // 這裡改走**真正的產線路徑**:假 WebSocket → connectWs() → onmessage(commandError)
    // → useToast.show → App 的 <Toast/> 真的把訊息畫出來。
    const sockets: FakeWs[] = [];
    class FakeWs {
      static OPEN = 1;
      readyState = 1;
      onopen?: () => void;
      onmessage?: (ev: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      send = vi.fn();
      close = vi.fn();
      constructor() {
        sockets.push(this);
      }
    }
    vi.stubGlobal('WebSocket', FakeWs);

    seedProject();
    const { container } = render(<App />);
    expect(container.textContent).not.toContain('Edit rejected');

    act(() => {
      ws.connectWs('ws://test/ws');
    });
    act(() => {
      sockets[0]!.onmessage!({ data: JSON.stringify({ type: 'commandError', error: 'nope' }) });
    });
    expect(container.textContent).toContain('Edit rejected: nope');
  });

  it('a network-level failure fetching /api/fonts degrades silently (no throw, no @font-face injected)', async () => {
    // 這裡故意蓋過 setup.ts 的預設 shim(那個只模擬「打不到」的 404,不是 fetch 本身 reject)——
    // 要驗證的是真正的網路層失敗(離線/DNS/server 還沒起來),fetch() 本身 reject 那種。
    // 沒有 App.tsx 那顆 .catch() 的話,這個 reject 會變成 unhandled rejection——
    // Vitest 會把它算進當次測試失敗(見 task-12-report.md 的「刻意移除驗證」)。
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down'))),
    );
    seedProject();
    expect(() => render(<App />)).not.toThrow();
    // 讓掛載時那個 useEffect 的 fetch().catch() 有機會跑完(flush microtask)
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.getElementById('server-fonts')).toBeNull();
  });
});
