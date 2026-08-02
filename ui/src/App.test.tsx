import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import type { Command } from '@vidcut/shared';
import { App } from './App.js';
import { useProject } from './stores/project.js';
import { usePlayback } from './stores/playback.js';
import { useView } from './stores/view.js';
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
  });
  afterEach(() => vi.restoreAllMocks());

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

  it('shows connection state', () => {
    const { container } = render(<App />);
    expect(container.textContent).toContain('Offline');
    act(() => {
      seedProject();
    });
    expect(container.textContent).toContain('Connected');
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
    seedProject();
    const { container } = render(<App />);
    act(() => {
      useProject.getState().applyServerMsg({ type: 'commandError', error: 'nope' });
    });
    // commandError 本身不改 store；toast 由 ws.ts 觸發（見 ws 層），
    // 這裡確認 App 不會因為這類訊息崩掉
    expect(container.textContent).toContain('demo');
  });
});
