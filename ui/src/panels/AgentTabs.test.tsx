import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import type { ChatMessage, Command } from '@vidcut/shared';
import { AgentPanel } from './AgentPanel.js';
import { useChat, NO_MESSAGES } from '../stores/chat.js';
import { useAgent, NO_CALLS } from '../stores/agent.js';
import { useActivity } from '../stores/activity.js';
import * as ws from '../ws.js';
import { resetStores, seedProject } from '../test/fixtures.js';

/**
 * AI 欄的內部分頁：**Chat ⇄ Activity**（使用者定案）。
 *
 * 版面契約有兩條，兩條都在這裡釘住：
 *
 *  1. **三態狀態卡（AgentStatus）恆頂**——它不是分頁的一部分，兩個分頁都在它下面。
 *     「AI 在不在」不該因為使用者切到某個分頁就看不到。
 *  2. 分頁列樣式**沿用右欄 Captions⇄Properties 的 `.seg` / `.seg.on` 既有模式**，
 *     不另立第二套分頁語彙。
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

/** 依可見文字找分頁鈕。 */
function tab(container: HTMLElement, label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button.seg')).find((b) =>
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

  it('uses the same segmented-control pattern as the right column (.seg / .seg.on)', () => {
    seedProject();
    const { container } = render(<AgentPanel />);
    // 選中的那顆帶 .on，另一顆不帶——與 App 的 Captions⇄Properties 同一套。
    const on = container.querySelectorAll('button.seg.on');
    expect(on).toHaveLength(1);
  });

  it('keeps the three-state status card above the tabs in BOTH tabs', () => {
    // 恆頂，不隨分頁走。這是使用者定案的版面契約。
    seedProject();
    const { container } = render(<AgentPanel />);
    expect(container.querySelector('.ap-card')).not.toBeNull();
    fireEvent.click(tab(container, 'Chat'));
    expect(container.querySelector('.ap-card')).not.toBeNull();
    fireEvent.click(tab(container, 'Activity'));
    expect(container.querySelector('.ap-card')).not.toBeNull();
  });

  it('the status card sits above the tab bar in DOM order (it is not inside a tab)', () => {
    seedProject();
    const { container } = render(<AgentPanel />);
    const cardEl = container.querySelector('.ap-card')!;
    const tabEl = tab(container, 'Chat');
    // compareDocumentPosition: FOLLOWING(4) 代表 tabEl 在 cardEl 之後
    expect(cardEl.compareDocumentPosition(tabEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
     * **只看分頁本體**（`.panel-col` 裡最後那一段），不是整根欄。恆頂的索引卡自己
     * 就有一份「最近三筆編輯」署名列，`trimmed clip` 必然也出現在那裡——拿整根欄的
     * textContent 去問「切到 Chat 之後不得有 trimmed clip」等於在斷言「索引卡消失」，
     * 而索引卡恆頂正是上面那條測試釘住的規格。這是 scope 精確化，不是放寬斷言
     * （`AgentPanel.test.tsx` 的 B6 為了同一個理由做過同一件事）。
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
