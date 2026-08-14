import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { AgentStrip, formatElapsed } from './AgentStrip.js';
import { useProject } from './stores/project.js';
import { useAgent, NO_CALLS } from './stores/agent.js';
import { useView } from './stores/view.js';

/**
 * header 紙條的行為契約（spec §3.3）。
 *
 * **視覺不在這裡驗**：jsdom 不載 CSS，`toHaveStyle` 去問外部 class 的顏色/旋轉/
 * 動畫一律拿到空字串——那種斷言看起來很嚴格，其實恆真。這裡只斷言
 * 「哪些文字出現」「掛了哪些 class」「DOM 結構長怎樣」「a11y 屬性對不對」，
 * 顏色、-0.6deg 微轉、圈的重畫動畫由主 session 在真瀏覽器驗收。
 */

const strip = (container: HTMLElement) => container.querySelector('.ap-strip')!;
const ring = (container: HTMLElement) => container.querySelector('.ap-ring')!;

/** 讓元件進 working 態：連線 + 塞一筆進行中呼叫。 */
function startCall(callId: string, tool: string, startedAt = Date.now()) {
  useAgent.setState({ calls: { ...useAgent.getState().calls, [callId]: { tool, startedAt } } });
}

beforeEach(() => {
  useProject.setState({ doc: null, version: 0, connected: false });
  useAgent.setState({ calls: NO_CALLS });
  useView.setState({ rightOpen: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('formatElapsed（純函數）', () => {
  it('毫秒 → mm:ss，兩位補零', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(7_000)).toBe('00:07');
    expect(formatElapsed(65_000)).toBe('01:05');
    expect(formatElapsed(102_000)).toBe('01:42');
  });

  it('不足一秒無條件捨去（0.9s 還是 00:00，不四捨五入成 00:01）', () => {
    expect(formatElapsed(900)).toBe('00:00');
    expect(formatElapsed(1_999)).toBe('00:01');
  });

  it('負數（時鐘回撥／startedAt 在未來）夾成 00:00，不出現負號', () => {
    expect(formatElapsed(-5_000)).toBe('00:00');
    expect(formatElapsed(-1)).toBe('00:00');
  });

  it('超過一小時繼續累加分鐘，不進位成 hh:mm:ss（欄寬不跳、transcribe 跑久看得懂）', () => {
    expect(formatElapsed(3_600_000)).toBe('60:00');
    expect(formatElapsed(4_335_000)).toBe('72:15');
  });
});

describe('AgentStrip 三態', () => {
  it('offline：NO AGENT + 虛線圈 + 褪色 class（connected=false）', () => {
    const { container } = render(<AgentStrip onOpenActivity={() => {}} />);
    // 文字用原文大小寫斷言；caps 是 CSS text-transform，jsdom 讀不到
    expect(container.textContent).toContain('No agent');
    expect(container.textContent).not.toContain('Agent ready');
    expect(strip(container).className).toContain('offline');
    expect(ring(container).classList.contains('dashed')).toBe(true);
    expect(ring(container).classList.contains('drawing')).toBe(false);
  });

  it('idle：AGENT READY + 實圈（連上、無進行中呼叫）', () => {
    act(() => {
      useProject.getState().setConnected(true);
    });
    const { container } = render(<AgentStrip onOpenActivity={() => {}} />);
    expect(container.textContent).toContain('Agent ready');
    expect(container.textContent).not.toContain('No agent');
    expect(strip(container).className).not.toContain('offline');
    expect(ring(container).classList.contains('dashed')).toBe(false);
    expect(ring(container).classList.contains('drawing')).toBe(false);
  });

  it('working：WORKING + mono 工具名 + 經過秒數 + 重畫中的圈', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T00:00:00Z'));
    act(() => {
      useProject.getState().setConnected(true);
      startCall('1', 'auto_caption', Date.now() - 7_000);
    });
    const { container } = render(<AgentStrip onOpenActivity={() => {}} />);
    expect(container.textContent).toContain('Working');
    expect(container.querySelector('.ap-tool')!.textContent).toBe('auto_caption');
    expect(container.querySelector('.ap-secs')!.textContent).toBe('00:07');
    expect(ring(container).classList.contains('drawing')).toBe(true);
    expect(ring(container).classList.contains('dashed')).toBe(false);
    expect(strip(container).className).not.toContain('offline');
  });

  it('offline 優先於 working：斷線時就算集合非空也顯示 NO AGENT、不顯示工具名', () => {
    // 正常情況 setConnected(false) 會清空集合（階段 2 的自癒），這裡刻意讓
    // 集合殘留來驗元件自己也不會被騙——第二道保險。
    act(() => {
      startCall('1', 'transcribe');
    });
    const { container } = render(<AgentStrip onOpenActivity={() => {}} />);
    expect(container.textContent).toContain('No agent');
    expect(container.textContent).not.toContain('transcribe');
    expect(container.querySelector('.ap-tool')).toBeNull();
    expect(container.querySelector('.ap-secs')).toBeNull();
    expect(ring(container).classList.contains('drawing')).toBe(false);
  });

  it('idle 與 offline 都不渲染工具名/秒數節點（不是靠空字串藏起來）', () => {
    const off = render(<AgentStrip onOpenActivity={() => {}} />);
    expect(off.container.querySelector('.ap-tool')).toBeNull();
    off.unmount();
    act(() => {
      useProject.getState().setConnected(true);
    });
    const idle = render(<AgentStrip onOpenActivity={() => {}} />);
    expect(idle.container.querySelector('.ap-tool')).toBeNull();
    expect(idle.container.querySelector('.ap-secs')).toBeNull();
  });

  it('working 顯示的是最新一筆呼叫的工具名（連發時不是第一筆）', () => {
    act(() => {
      useProject.getState().setConnected(true);
      startCall('1', 'get_project');
      startCall('2', 'render');
    });
    const { container } = render(<AgentStrip onOpenActivity={() => {}} />);
    expect(container.querySelector('.ap-tool')!.textContent).toBe('render');
  });

  it('狀態變化會即時反映（idle → working → idle）', () => {
    act(() => {
      useProject.getState().setConnected(true);
    });
    const { container } = render(<AgentStrip onOpenActivity={() => {}} />);
    expect(container.textContent).toContain('Agent ready');

    act(() => {
      useAgent
        .getState()
        .apply({ type: 'agentActivity', phase: 'start', tool: 'transcribe', callId: '9' });
    });
    expect(container.textContent).toContain('Working');
    expect(container.querySelector('.ap-tool')!.textContent).toBe('transcribe');

    act(() => {
      useAgent
        .getState()
        .apply({ type: 'agentActivity', phase: 'end', tool: 'transcribe', callId: '9' });
    });
    expect(container.textContent).toContain('Agent ready');
    expect(container.querySelector('.ap-tool')).toBeNull();
  });
});

describe('經過秒數（元件層 interval，store 只存 startedAt）', () => {
  it('每秒往前走一格', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T00:00:00Z'));
    act(() => {
      useProject.getState().setConnected(true);
      startCall('1', 'render', Date.now());
    });
    const { container } = render(<AgentStrip onOpenActivity={() => {}} />);
    expect(container.querySelector('.ap-secs')!.textContent).toBe('00:00');

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.querySelector('.ap-secs')!.textContent).toBe('00:01');

    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(container.querySelector('.ap-secs')!.textContent).toBe('00:05');

    // 跨分界：59 → 60 要翻成 01:00
    act(() => {
      vi.advanceTimersByTime(55_000);
    });
    expect(container.querySelector('.ap-secs')!.textContent).toBe('01:00');
  });

  it('interval 只在 working 掛：離開 working 之後不再有計時器', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    act(() => {
      useProject.getState().setConnected(true);
    });
    render(<AgentStrip onOpenActivity={() => {}} />);
    // idle：沒掛
    expect(spy).not.toHaveBeenCalled();

    act(() => {
      useAgent
        .getState()
        .apply({ type: 'agentActivity', phase: 'start', tool: 'render', callId: '1' });
    });
    expect(spy).toHaveBeenCalledTimes(1);

    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    act(() => {
      useAgent
        .getState()
        .apply({ type: 'agentActivity', phase: 'end', tool: 'render', callId: '1' });
    });
    // 回到 idle：上一顆被清掉、也沒有新的
    expect(clearSpy).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('working 中換一筆新呼叫：秒數立刻從新的 startedAt 重算，不繼承上一筆的經過時間', () => {
    // 陷阱：`working` 布林從 true 保持 true，effect 不會重跑；若秒數只靠 interval
    // 推進的 `now`，換工具的當下會拿新的 startedAt 去減舊的 now，短暫顯示錯的值
    // （最糟一整秒）。工具連發（set_timeline 批次）是常態，這條必須成立。
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T00:00:00Z'));
    act(() => {
      useProject.getState().setConnected(true);
      startCall('1', 'transcribe', Date.now() - 90_000);
    });
    const { container } = render(<AgentStrip onOpenActivity={() => {}} />);
    expect(container.querySelector('.ap-secs')!.textContent).toBe('01:30');

    // 半秒後第二筆開始（沒有跨過 interval 的 tick）
    act(() => {
      vi.advanceTimersByTime(500);
      startCall('2', 'render', Date.now());
    });
    // 新工具名要換，秒數要是新那筆的 00:00——不是 transcribe 的 01:30
    expect(container.querySelector('.ap-tool')!.textContent).toBe('render');
    expect(container.querySelector('.ap-secs')!.textContent).toBe('00:00');
  });

  it('卸載時清掉計時器（不留下對已卸載元件 setState 的孤兒）', () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    act(() => {
      useProject.getState().setConnected(true);
      startCall('1', 'render');
    });
    const { unmount } = render(<AgentStrip onOpenActivity={() => {}} />);
    clearSpy.mockClear();
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });
});

describe('點擊行為', () => {
  it('呼叫 onOpenActivity 並展開右欄', () => {
    const onOpenActivity = vi.fn();
    act(() => {
      useView.setState({ rightOpen: false });
    });
    const { container } = render(<AgentStrip onOpenActivity={onOpenActivity} />);
    act(() => {
      fireEvent.click(strip(container));
    });
    expect(onOpenActivity).toHaveBeenCalledTimes(1);
    expect(useView.getState().rightOpen).toBe(true);
  });

  it('右欄本來就開著：再點一次仍然是開的（openRight 冪等，不是 toggle）', () => {
    const onOpenActivity = vi.fn();
    const { container } = render(<AgentStrip onOpenActivity={onOpenActivity} />);
    expect(useView.getState().rightOpen).toBe(true);
    act(() => {
      fireEvent.click(strip(container));
    });
    expect(useView.getState().rightOpen).toBe(true);
    act(() => {
      fireEvent.click(strip(container));
    });
    expect(useView.getState().rightOpen).toBe(true);
    expect(onOpenActivity).toHaveBeenCalledTimes(2);
  });

  it('三態下都可點（offline 也要能開 Activity 看歷史）', () => {
    const onOpenActivity = vi.fn();
    const { container } = render(<AgentStrip onOpenActivity={onOpenActivity} />);
    expect(strip(container).hasAttribute('disabled')).toBe(false);
    act(() => {
      fireEvent.click(strip(container));
    });
    expect(onOpenActivity).toHaveBeenCalledTimes(1);
  });
});

describe('a11y', () => {
  it('是 <button>（鍵盤可及）且帶 role=status / aria-live=polite', () => {
    const { container } = render(<AgentStrip onOpenActivity={() => {}} />);
    const el = strip(container);
    expect(el.tagName).toBe('BUTTON');
    expect(el.getAttribute('type')).toBe('button');
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
  });

  it('鍵盤 Enter 觸發（<button> 的原生語意，不是靠 onClick 掛在 div 上）', () => {
    const onOpenActivity = vi.fn();
    const { container } = render(<AgentStrip onOpenActivity={onOpenActivity} />);
    const el = strip(container) as HTMLButtonElement;
    act(() => {
      el.focus();
      el.click(); // <button> 的 Enter/Space 由瀏覽器轉成 click；jsdom 不模擬鍵盤啟動
    });
    expect(document.activeElement).toBe(el);
    expect(onOpenActivity).toHaveBeenCalled();
  });

  it('三態文字都在無障礙樹裡（裝飾性 SVG 標了 aria-hidden，不會蓋掉文字）', () => {
    const cases: Array<[() => void, string]> = [
      [() => {}, 'No agent'],
      [
        () => {
          useProject.getState().setConnected(true);
        },
        'Agent ready',
      ],
      [
        () => {
          useProject.getState().setConnected(true);
          startCall('1', 'transcribe');
        },
        'Working',
      ],
    ];
    for (const [setup, text] of cases) {
      useProject.setState({ connected: false });
      useAgent.setState({ calls: NO_CALLS });
      act(setup);
      const { container, unmount } = render(<AgentStrip onOpenActivity={() => {}} />);
      const el = strip(container);
      // 所有 svg 都要 aria-hidden——不然讀屏幕會唸出圖形節點打斷狀態文字
      for (const svg of el.querySelectorAll('svg')) {
        expect(svg.getAttribute('aria-hidden')).toBe('true');
      }
      expect(el.textContent).toContain(text);
      unmount();
    }
  });
});

describe('結構（紙的組成，視覺由真瀏覽器驗收）', () => {
  it('#pencil 濁度濾鏡的 defs 內嵌在元件裡，id 是 ap-pencil（避免全域撞名）', () => {
    const { container } = render(<AgentStrip onOpenActivity={() => {}} />);
    const filter = container.querySelector('filter#ap-pencil');
    expect(filter).not.toBeNull();
    expect(filter!.querySelector('feTurbulence')!.getAttribute('baseFrequency')).toBe('0.055');
    expect(filter!.querySelector('feTurbulence')!.getAttribute('seed')).toBe('7');
    expect(filter!.querySelector('feDisplacementMap')!.getAttribute('scale')).toBe('2.6');
  });

  it('手繪圈的 path 帶 pathLength=1（stroke 揭示動畫的前提）', () => {
    const { container } = render(<AgentStrip onOpenActivity={() => {}} />);
    const path = ring(container).querySelector('path')!;
    expect(path.getAttribute('pathLength')).toBe('1');
    // 是手畫的閉合路徑，不是 <circle>——DESIGN.md 的 form language
    expect(ring(container).querySelector('circle')).toBeNull();
    expect(path.getAttribute('d')!.length).toBeGreaterThan(20);
  });
});
