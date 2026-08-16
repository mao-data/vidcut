import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import type { Command, MutationSource } from '@vidcut/shared';
import { AgentPanel } from './AgentPanel.js';
import { useSelection } from '../stores/selection.js';
import { useProject } from '../stores/project.js';
import { useActivity } from '../stores/activity.js';
import { useAgent, NO_CALLS } from '../stores/agent.js';
import * as ws from '../ws.js';
import { demoProject, seedProject, resetStores } from '../test/fixtures.js';

/**
 * AI 專區（左欄全高，使用者 2026-08-16 版面定案）的行為契約。
 *
 * 這一整組斷言原本住在 `panels.test.tsx` 的 `describe('Inspector')` 底下——索引卡
 * 那時是 Inspector「未選取」分支的一部分。**內容一字未改地跟著程式碼搬過來**，
 * 只有兩處必然的調整：render 的對象從 `<Inspector />` 換成 `<AgentPanel />`，
 * 以及 N2 那條（它斷言的是舊版面的必然結果，見該處註解）。
 *
 * **視覺不在這裡驗**（同 AgentStrip.test.tsx 的體例）：jsdom 不載 CSS，
 * 顏色/旋轉/動畫問 computed style 一律拿到空字串。這裡只斷言文字、class、
 * DOM 結構與三態接線。
 */

beforeEach(() => {
  resetStores();
  // agent 是模組級 store，`resetStores()` 不管它（它是階段 2 才加的，fixtures 沒收）。
  // 不清的話一個測試留下的進行中呼叫會讓下一個測試的索引卡卡在 working 態。
  useAgent.setState({ calls: NO_CALLS });
  vi.spyOn(ws, 'sendCommand').mockImplementation((_c: Command) => {});
});
afterEach(() => vi.restoreAllMocks());

/**
 * AI 區塊。這片面板是唯一「閒著也會被看到」的區域，所以它顯示的是
 * 產品的核心迴路狀態（agent 在不在、剛做了什麼），而不只是「請選一個東西」。
 * 2026-08-16 版面重構後它常駐自己的欄，不再綁在「未選取」那個分支上（見 N2）。
 */
describe('agent status (AI column)', () => {
  /** 灌一批歷史；version 遞增代表由舊到新。 */
  function seedHistory(n: number, source: MutationSource = 'ai') {
    useActivity.setState({
      entries: Array.from({ length: n }, (_, i) => ({
        version: i + 1,
        label: `edit ${i + 1}`,
        source,
        ts: new Date(1700000000000 + i * 1000).toISOString(),
      })),
    });
  }

  // 舊斷言是 'Agent connected'（連線與否的二態）。**經核准的規格變更**
  // （spec 2026-08-14-agent-presence-design §3.4 + 2026-08-16 修訂）：這塊區域
  // 換成索引卡之後，連線與否變成三態（offline / idle / working）裡的一態，
  // idle 的文字與 header 標籤共用同一份 store 推導＝'Agent ready'。
  // 這條測的仍然是同一件事：這片面板有沒有誠實顯示 agent 在不在。
  it('B1/B2: shows the agent block, connected when the socket is up', () => {
    seedProject(); // seedProject 會 setConnected(true)
    const { container } = render(<AgentPanel />);
    expect(container.textContent).toContain('AI agent');
    expect(container.textContent).toContain('Agent ready');
    expect(container.textContent).not.toContain('No agent');
  });

  it('B2/B3: offline shows "No agent" plus the command that reconnects it', () => {
    seedProject();
    act(() => useProject.getState().setConnected(false));
    const { container } = render(<AgentPanel />);
    expect(container.textContent).toContain('No agent');
    expect(container.textContent).not.toContain('Agent ready');
    // 離線時給的是「怎麼接回來」，不是只宣告狀態
    expect(container.textContent).toContain('claude mcp add --transport http vidcut');
  });

  it('B4: the reconnect command is hidden while connected', () => {
    seedProject();
    const { container } = render(<AgentPanel />);
    expect(container.textContent).not.toContain('claude mcp add');
  });

  it('B5: says so when there is no history yet', () => {
    seedProject();
    const { container } = render(<AgentPanel />);
    expect(container.textContent).toContain('No edits yet.');
  });

  it('B6: lists only the three most recent edits, newest first', () => {
    seedProject();
    seedHistory(5);
    const { container } = render(<AgentPanel />);
    // **只看索引卡那一段**（`.panel-section`）。這條斷言問的一直是「卡片的近況列
    // 只有三筆」；同一根欄裡下半截的完整活動流本來就該把五筆全列出來（那是它的
    // 工作），拿整根欄的 textContent 去問「edit 2 不得出現」會把活動流也算進去。
    // 搬家前這個區分不存在（Inspector 裡沒有活動流），所以當時整個 container 就是
    // 卡片；scope 是搬家帶來的必要精確化，不是把斷言放寬。
    const text = container.querySelector('.panel-section')!.textContent ?? '';
    expect(text).not.toContain('No edits yet.');
    for (const v of [5, 4, 3]) expect(text).toContain(`edit ${v}`);
    // 只有三筆：第 4 新與第 5 新不得出現
    for (const v of [2, 1]) expect(text).not.toContain(`edit ${v}`);
    // 最新在最前：獨立 oracle，不是靠上面的 toContain 推論
    expect(text.indexOf('edit 5')).toBeLessThan(text.indexOf('edit 4'));
    expect(text.indexOf('edit 4')).toBeLessThan(text.indexOf('edit 3'));
  });

  it('B7: attributes each edit to the AI or to you', () => {
    seedProject();
    useActivity.setState({
      entries: [
        { version: 1, label: 'ai did this', source: 'ai', ts: '2026-01-01T00:00:00.000Z' },
        { version: 2, label: 'you did this', source: 'human', ts: '2026-01-01T00:00:01.000Z' },
      ],
    });
    const { container } = render(<AgentPanel />);
    const rows = Array.from(container.querySelectorAll('div')).filter((d) =>
      d.textContent?.startsWith('AI'),
    );
    expect(rows.length).toBeGreaterThan(0);
    const text = container.textContent ?? '';
    expect(text).toContain('AIai did this');
    expect(text).toContain('youyou did this');
  });

  // 舊斷言是 N2「選了東西之後 AI 區塊就不顯示」——那是它住在 Inspector 未選取分支
  // 時的必然結果，不是想要的性質。**經核准的版面變更**（使用者 2026-08-16 定案）：
  // AI 專區搬進自己的全高左欄之後，選取狀態與它無關了。這條測的是同一條接線的
  // 另一面：AI 在不在、剛做了什麼，不該被「使用者剛好點了一個 clip」蓋掉。
  it('N2: the agent block survives a selection (it owns its own column now)', () => {
    seedProject();
    useSelection.getState().select({ kind: 'clip', id: 'c1' });
    const { container } = render(<AgentPanel />);
    expect(container.textContent).toContain('AI agent');
    expect(container.textContent).toContain('No edits yet.');
  });

  /**
   * 索引卡（agent-presence 階段 4，spec §3.4 + 2026-08-16 修訂）。
   * 大使館在編輯器裡的**第二件實體**：暗版載體＝琥珀終端卡（跟 AgentStrip 同族），
   * 手（手繪圈 + `#ap-pencil`）不變。
   *
   * **視覺不在這裡驗**（同 AgentStrip.test.tsx 的體例）：jsdom 不載 CSS，
   * 顏色/旋轉/動畫問 computed style 一律拿到空字串。這裡只斷言文字、class、
   * DOM 結構與三態接線。
   */
  describe('index card (agent presence stage 4)', () => {
    const card = (c: HTMLElement) => c.querySelector('.ap-card');
    const ring = (c: HTMLElement) => c.querySelector('.ap-card .ap-ring');

    /** 讓卡進 working 態：連線 + 塞一筆進行中呼叫。 */
    function startCall(callId: string, tool: string, startedAt = Date.now()) {
      useAgent.setState({
        calls: { ...useAgent.getState().calls, [callId]: { tool, startedAt } },
      });
    }

    it('C1: offline — dashed ring, NO AGENT, and the reconnect command survives', () => {
      seedProject();
      act(() => useProject.getState().setConnected(false));
      const { container } = render(<AgentPanel />);
      expect(card(container)).not.toBeNull();
      expect(card(container)!.className).toContain('offline');
      expect(ring(container)!.classList.contains('dashed')).toBe(true);
      expect(ring(container)!.classList.contains('drawing')).toBe(false);
      expect(container.textContent).toContain('No agent');
      // 換皮不換行為：離線時給的仍然是「怎麼接回來」
      expect(container.textContent).toContain('claude mcp add --transport http vidcut');
    });

    it('C2: idle — solid ring, AGENT READY, no tool line', () => {
      seedProject();
      const { container } = render(<AgentPanel />);
      expect(card(container)!.className).not.toContain('offline');
      expect(ring(container)!.classList.contains('dashed')).toBe(false);
      expect(ring(container)!.classList.contains('drawing')).toBe(false);
      expect(container.textContent).toContain('Agent ready');
      expect(container.querySelector('.ap-card-tool')).toBeNull();
    });

    it('C3: working — live `tool mm:ss` line and a redrawing ring', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-16T00:00:00Z'));
      seedProject();
      act(() => startCall('1', 'auto_caption', Date.now() - 7_000));
      const { container } = render(<AgentPanel />);
      expect(container.querySelector('.ap-card-tool')!.textContent).toBe('auto_caption');
      expect(container.querySelector('.ap-card-secs')!.textContent).toBe('00:07');
      expect(ring(container)!.classList.contains('drawing')).toBe(true);
      vi.useRealTimers();
    });

    it('C3b: the card and the header strip say the same word in all three states', () => {
      // 兩件大使館物件在同一時刻說不同的話，使用者會以為是兩個 agent。
      // 抓過一次真的：卡在 working 時仍寫 AGENT READY，而 header 已經是 WORKING。
      seedProject();
      act(() => useProject.getState().setConnected(false));
      const off = render(<AgentPanel />);
      expect(off.container.querySelector('.ap-card .ap-cap')!.textContent).toBe('No agent');
      off.unmount();

      act(() => useProject.getState().setConnected(true));
      const idle = render(<AgentPanel />);
      expect(idle.container.querySelector('.ap-card .ap-cap')!.textContent).toBe('Agent ready');
      idle.unmount();

      act(() => startCall('1', 'render'));
      const busy = render(<AgentPanel />);
      expect(busy.container.querySelector('.ap-card .ap-cap')!.textContent).toBe('Working');
    });

    it('C4: the elapsed readout ticks每秒 while working', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-16T00:00:00Z'));
      seedProject();
      act(() => startCall('1', 'transcribe', Date.now()));
      const { container } = render(<AgentPanel />);
      expect(container.querySelector('.ap-card-secs')!.textContent).toBe('00:00');
      act(() => {
        vi.advanceTimersByTime(65_000);
      });
      expect(container.querySelector('.ap-card-secs')!.textContent).toBe('01:05');
      vi.useRealTimers();
    });

    it('C5: the interval is mounted only while working (idle must not tick all day)', () => {
      vi.useFakeTimers();
      const spy = vi.spyOn(globalThis, 'setInterval');
      seedProject();
      render(<AgentPanel />);
      expect(spy).not.toHaveBeenCalled();

      act(() =>
        useAgent
          .getState()
          .apply({ type: 'agentActivity', phase: 'start', tool: 'render', callId: '1' }),
      );
      expect(spy).toHaveBeenCalledTimes(1);

      const clearSpy = vi.spyOn(globalThis, 'clearInterval');
      act(() =>
        useAgent
          .getState()
          .apply({ type: 'agentActivity', phase: 'end', tool: 'render', callId: '1' }),
      );
      expect(clearSpy).toHaveBeenCalled();
      expect(spy).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('C6: unmounting clears the interval (no orphan setState on a dead component)', () => {
      vi.useFakeTimers();
      seedProject();
      act(() => startCall('1', 'render'));
      const { unmount } = render(<AgentPanel />);
      const clearSpy = vi.spyOn(globalThis, 'clearInterval');
      unmount();
      expect(clearSpy).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('C7: session readout counts AI and human edits separately, with the doc revision', () => {
      seedProject(demoProject(), 7);
      useActivity.setState({
        entries: [
          { version: 1, label: 'a', source: 'ai', ts: '2026-01-01T00:00:00.000Z' },
          { version: 2, label: 'b', source: 'human', ts: '2026-01-01T00:00:01.000Z' },
          { version: 3, label: 'c', source: 'ai', ts: '2026-01-01T00:00:02.000Z' },
        ],
      });
      const { container } = render(<AgentPanel />);
      const readout = container.querySelector('.ap-card-counts')!.textContent ?? '';
      expect(readout).toContain('v7');
      expect(readout).toContain('AI 2');
      expect(readout).toContain('you 1');
    });

    it('C8: every recent row is signed —AI / —you', () => {
      seedProject();
      useActivity.setState({
        entries: [
          { version: 1, label: 'ai did this', source: 'ai', ts: '2026-01-01T00:00:00.000Z' },
          { version: 2, label: 'you did this', source: 'human', ts: '2026-01-01T00:00:01.000Z' },
        ],
      });
      const { container } = render(<AgentPanel />);
      const signs = Array.from(container.querySelectorAll('.ap-card-sign')).map(
        (s) => s.textContent,
      );
      expect(signs).toEqual(['—you', '—AI']); // 最新在最前（you 是 version 2）
    });

    it('C9: the signature keeps the --who-* pigment (no separate handwriting color)', () => {
      seedProject();
      useActivity.setState({
        entries: [
          { version: 1, label: 'ai did this', source: 'ai', ts: '2026-01-01T00:00:00.000Z' },
          { version: 2, label: 'you did this', source: 'human', ts: '2026-01-01T00:00:01.000Z' },
        ],
      });
      const { container } = render(<AgentPanel />);
      const signs = Array.from(container.querySelectorAll<HTMLElement>('.ap-card-sign'));
      expect(signs[0]!.style.color).toBe('var(--who-you)');
      expect(signs[1]!.style.color).toBe('var(--who-ai)');
    });

    it('C10: the hand is present — a pathLength=1 ring path through #ap-pencil', () => {
      seedProject();
      const { container } = render(<AgentPanel />);
      const path = ring(container)!.querySelector('path')!;
      expect(path.getAttribute('pathLength')).toBe('1');
      // 是手畫的閉合路徑，不是 <circle>（DESIGN.md 的 form language）
      expect(ring(container)!.querySelector('circle')).toBeNull();
      expect(path.getAttribute('d')!.length).toBeGreaterThan(20);
    });

    it('C11: decorative SVG is aria-hidden so it cannot interrupt the status text', () => {
      seedProject();
      const { container } = render(<AgentPanel />);
      for (const svg of card(container)!.querySelectorAll('svg')) {
        expect(svg.getAttribute('aria-hidden')).toBe('true');
      }
    });
  });
});
