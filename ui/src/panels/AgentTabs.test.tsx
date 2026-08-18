import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import type { ChatMessage, Command } from '@vidcut/shared';
import { AgentPanel } from './AgentPanel.js';
import { useChat, NO_MESSAGES } from '../stores/chat.js';
import { useAgent, NO_CALLS } from '../stores/agent.js';
import { useActivity } from '../stores/activity.js';
import { useView } from '../stores/view.js';
import * as ws from '../ws.js';
import { resetStores, seedProject } from '../test/fixtures.js';

/**
 * AI 欄的內部分頁：**Chat ⇄ Activity**（使用者定案）。
 *
 * 版面契約有兩條，兩條都在這裡釘住：
 *
 *  1. **三態狀態卡（AgentStatus）住在 Activity 分頁裡**（2026-08-17 使用者修訂：
 *     「Agent ready 的顯示放到 activity 裡面，這樣 chat 空間更大」）。這是對舊
 *     「恆頂」契約的**正式反轉**——三態不會從畫面上消失：header 的 AgentStrip
 *     本來就恆在，左欄的卡是第二份，Chat 分頁把整張卡讓位給對話。
 *     （舊契約下的 compact prop 同時退役——只剩一個落點就沒有瘦身版可言。）
 *  2. 分頁列是**文字型切換**（2026-08-18 使用者定案：「chat 跟 activity 不要匡起來,
 *     用｜來分開」）——不用右欄的 `.seg` 框鈕,兩個純文字鈕（`.tab-link`,當前帶
 *     `.on`）中間一條細分隔線（`.tab-divider`,樣式化的豎線,刻意**不用全形「｜」
 *     字面值**——i18n 檢查掃 CJK 字面值,而且樣式線的粗細/顏色可控）。
 *     這取代了舊「沿用 .seg」契約。
 */

function msg(id: string, author: ChatMessage['author'], text: string): ChatMessage {
  return { id, author, text, ts: new Date(1700000000000).toISOString() };
}

beforeEach(() => {
  resetStores();
  useAgent.setState({ calls: NO_CALLS });
  useChat.setState({ messages: NO_MESSAGES, draft: '', unread: 0, viewing: false });
  vi.spyOn(ws, 'sendCommand').mockImplementation((_c: Command) => {});
  vi.spyOn(ws, 'sendChatMessage').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** 依可見文字找分頁鈕（文字型分頁,2026-08-18 起是 `.tab-link`）。 */
function tab(container: HTMLElement, label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button.tab-link')).find((b) =>
    b.textContent?.includes(label),
  );
  if (!el) throw new Error(`no tab: ${label}`);
  return el as HTMLButtonElement;
}

describe('AI column tabs', () => {
  it('offers a Chat tab and an Activity tab', () => {
    seedProject();
    const { container } = render(<AgentPanel />);
    expect(tab(container, 'Chat')).toBeTruthy();
    expect(tab(container, 'Activity')).toBeTruthy();
  });

  it('text tabs with a divider, not segmented boxes (2026-08-18 user decision)', () => {
    seedProject();
    const { container } = render(<AgentPanel />);
    // 框鈕退場:AI 欄裡不得再有 .seg
    expect(container.querySelectorAll('button.seg')).toHaveLength(0);
    // 文字鈕兩顆,當前那顆帶 .on
    expect(container.querySelectorAll('button.tab-link')).toHaveLength(2);
    expect(container.querySelectorAll('button.tab-link.on')).toHaveLength(1);
    // 中間有一條樣式化分隔線(aria-hidden:純視覺,讀屏不該唸它)
    const divider = container.querySelector('.tab-divider');
    expect(divider).not.toBeNull();
    expect(divider!.getAttribute('aria-hidden')).toBe('true');
  });

  it('the collapse button lives at the right end of the tab row (moved from the old AI header)', () => {
    // 2026-08-18 定案 D:左欄頂的「AI」列拿掉,收合鈕搬進分頁列右端。
    // title 維持 "Collapse AI panel"——verify:panels 的 e2e 靠它找鈕。
    seedProject();
    useView.setState({ leftOpen: true });
    const { container } = render(<AgentPanel />);
    const btn = container.querySelector<HTMLButtonElement>('button[title="Collapse AI panel"]');
    expect(btn).not.toBeNull();
    // 不只存在,接線也要對:點了真的收合(搬家丟了 onClick 這種事不該靠 e2e 才抓到)
    fireEvent.click(btn!);
    expect(useView.getState().leftOpen).toBe(false);
  });

  /**
   * **狀態卡住進 Activity、Chat 整頁讓給對話**（2026-08-17 使用者修訂,取代舊
   * 「恆頂+compact」兩條——修訂理由見檔頭）。以下四條是舊契約斷言的**反轉/改寫**,
   * 不是放寬:Chat 側從「收斂的卡」變成「沒有卡」,Activity 側從「卡在分頁外」
   * 變成「完整卡固定在分頁內頂部」。
   */
  it('the status card lives inside the Activity tab only', () => {
    seedProject();
    const { container } = render(<AgentPanel />);
    // 預設分頁 Activity:卡在
    expect(container.querySelector('.ap-card')).not.toBeNull();
    fireEvent.click(tab(container, 'Chat'));
    // Chat:整張卡不渲染,空間全給對話
    expect(container.querySelector('.ap-card')).toBeNull();
    fireEvent.click(tab(container, 'Activity'));
    expect(container.querySelector('.ap-card')).not.toBeNull();
  });

  it('the full card (recent edits + counts) is Activity-only', () => {
    seedProject();
    useActivity.setState({
      entries: [
        { version: 7, label: 'trimmed clip', source: 'ai', ts: '2026-01-01T00:00:00.000Z' },
      ],
    });
    const { container } = render(<AgentPanel />);

    fireEvent.click(tab(container, 'Chat'));
    expect(container.querySelector('.ap-card-sign')).toBeNull();
    expect(container.querySelector('.ap-card-counts')).toBeNull();
    expect(container.textContent).not.toContain('trimmed clip');

    fireEvent.click(tab(container, 'Activity'));
    // 搬進分頁後卡是**完整版**(compact 已退役):署名列與讀數都在
    expect(container.querySelector('.ap-card-sign')).not.toBeNull();
    expect(container.querySelector('.ap-card-counts')).not.toBeNull();
  });

  it('"No edits yet." belongs to Activity, not to an empty Chat', () => {
    seedProject();
    const { container } = render(<AgentPanel />);
    fireEvent.click(tab(container, 'Chat'));
    expect(container.textContent).not.toContain('No edits yet.');
    fireEvent.click(tab(container, 'Activity'));
    expect(container.textContent).toContain('No edits yet.');
  });

  it('the tab bar precedes the status card in DOM order (the card is inside a tab now)', () => {
    // 舊契約的鏡像:卡從分頁外搬進 Activity 分頁,DOM 順序跟著反轉。
    seedProject();
    const { container } = render(<AgentPanel />);
    const cardEl = container.querySelector('.ap-card')!;
    const tabEl = tab(container, 'Chat');
    // compareDocumentPosition: FOLLOWING(4) 代表 cardEl 在 tabEl 之後
    expect(tabEl.compareDocumentPosition(cardEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the activity feed on the Activity tab', () => {
    seedProject();
    useActivity.setState({
      entries: [
        { version: 7, label: 'trimmed clip', source: 'ai', ts: '2026-01-01T00:00:00.000Z' },
      ],
    });
    const { container } = render(<AgentPanel />);
    fireEvent.click(tab(container, 'Activity'));
    expect(container.textContent).toContain('trimmed clip');
  });

  it('shows the conversation on the Chat tab', () => {
    seedProject();
    act(() => useChat.getState().receive([msg('a', 'ai', 'trimmed it for you')]));
    const { container } = render(<AgentPanel />);
    fireEvent.click(tab(container, 'Chat'));
    expect(container.textContent).toContain('trimmed it for you');
  });

  it('switching tabs swaps the body (only one of the two is mounted)', () => {
    seedProject();
    useActivity.setState({
      entries: [
        { version: 7, label: 'trimmed clip', source: 'ai', ts: '2026-01-01T00:00:00.000Z' },
      ],
    });
    act(() => useChat.getState().receive([msg('a', 'ai', 'a chat line')]));
    const { container } = render(<AgentPanel />);

    /**
     * **只看分頁本體**（`.panel-col` 裡最後那一段），不是整根欄。
     * （這個 scope 是恆頂時代為了避開卡上的署名列而收的；2026-08-17 卡搬進
     * Activity 分頁後,整欄斷言其實也會過,但 scope 收著不礙事且對未來
     * 加回欄級元素更穩——保留。）
     */
    const body = () => container.querySelector('.panel-col > div:last-child')!.textContent ?? '';

    fireEvent.click(tab(container, 'Chat'));
    expect(body()).toContain('a chat line');
    expect(body()).not.toContain('trimmed clip');

    fireEvent.click(tab(container, 'Activity'));
    expect(body()).toContain('trimmed clip');
    expect(body()).not.toContain('a chat line');
  });

  it('opening the Chat tab clears the unread count', () => {
    seedProject();
    act(() => {
      useChat.setState({ unread: 4 });
    });
    const { container } = render(<AgentPanel />);
    fireEvent.click(tab(container, 'Chat'));
    expect(useChat.getState().unread).toBe(0);
  });

  it('leaving the Chat tab stops it being viewed (so counting resumes)', () => {
    seedProject();
    const { container } = render(<AgentPanel />);
    fireEvent.click(tab(container, 'Chat'));
    expect(useChat.getState().viewing).toBe(true);
    fireEvent.click(tab(container, 'Activity'));
    expect(useChat.getState().viewing).toBe(false);
  });
});
