import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import type { Command } from '@vidcut/shared';
import { App } from './App.js';
import { usePlayback } from './stores/playback.js';
import { useSelection } from './stores/selection.js';
import { useView } from './stores/view.js';
import { useToast } from './stores/toast.js';
import * as ws from './ws.js';
import { seedProject, resetStores } from './test/fixtures.js';

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
    expect(container.textContent).toContain('demo');
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

  it('switches the right panel between captions and activity', () => {
    seedProject();
    const { getByText, container } = render(<App />);
    act(() => {
      fireEvent.click(getByText('Activity'));
    });
    expect(container.textContent).toContain('No changes yet');
  });

  // 紙條的 onOpenActivity 是 App 傳進去的 setTab——這條驗的是**接線**
  // （紙條自己的點擊契約在 AgentStrip.test.tsx，那裡的 callback 是 vi.fn()，
  // 證不了 App 真的接到分頁狀態上）。
  it('clicking the header agent strip opens the activity tab and expands the right panel', () => {
    seedProject();
    const { container } = render(<App />);
    act(() => {
      useView.getState().toggleRight(); // 先收起來
    });
    expect(useView.getState().rightOpen).toBe(false);
    expect(container.textContent).not.toContain('No changes yet');

    act(() => {
      fireEvent.click(container.querySelector('.ap-strip')!);
    });
    expect(useView.getState().rightOpen).toBe(true);
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
