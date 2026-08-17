import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { AgentStrip } from './AgentStrip.js';
import { useProject } from './stores/project.js';
import { useAgent, NO_CALLS } from './stores/agent.js';
import { useChat, NO_MESSAGES } from './stores/chat.js';
import { useView } from './stores/view.js';

/**
 * header 紙條的**未讀徽章**：AI 說話但使用者沒在看 Chat 分頁（欄收合了，或人在
 * Activity 上）時，未讀數要在 header 上看得見——否則 AI 的訊息會安靜地掉進一個
 * 沒人打開的分頁。
 *
 * **視覺不在這裡驗**（同 AgentStrip.test.tsx 的體例）：jsdom 不載 CSS。
 */

const strip = (container: HTMLElement) => container.querySelector('.ap-strip')!;
const badge = (container: HTMLElement) => container.querySelector('.ap-strip .badge');

beforeEach(() => {
  useProject.setState({ doc: null, version: 0, connected: true });
  useAgent.setState({ calls: NO_CALLS });
  useChat.setState({ messages: NO_MESSAGES, draft: '', unread: 0, viewing: false });
  useView.setState({ leftOpen: true, rightOpen: true });
});
afterEach(() => vi.restoreAllMocks());

describe('AgentStrip unread badge', () => {
  it('shows nothing when there is nothing unread', () => {
    const { container } = render(<AgentStrip onOpenActivity={() => {}} />);
    expect(badge(container)).toBeNull();
  });

  it('shows the unread count when the AI has spoken and nobody is looking', () => {
    const { container } = render(<AgentStrip onOpenActivity={() => {}} />);
    act(() => {
      useChat.setState({ unread: 3 });
    });
    expect(badge(container)!.textContent).toBe('3');
  });

  it('disappears once the count is cleared (opening the Chat tab does that)', () => {
    const { container } = render(<AgentStrip onOpenActivity={() => {}} />);
    act(() => {
      useChat.setState({ unread: 2 });
    });
    expect(badge(container)).not.toBeNull();
    act(() => useChat.getState().setViewing(true));
    expect(badge(container)).toBeNull();
  });

  it('the badge is announced to screen readers as unread messages', () => {
    const { container } = render(<AgentStrip onOpenActivity={() => {}} />);
    act(() => {
      useChat.setState({ unread: 5 });
    });
    // 光一個數字對讀屏幕沒有意義——它必須說得出這是什麼的 5。
    expect(strip(container).getAttribute('aria-label')).toMatch(/5 unread/i);
  });

  it('keeps working while the agent is offline (unread does not vanish with the socket)', () => {
    // 訊息是 AI 之前說的，斷線不會讓它變成已讀。
    const { container } = render(<AgentStrip onOpenActivity={() => {}} />);
    act(() => {
      useChat.setState({ unread: 1 });
      useProject.getState().setConnected(false);
    });
    expect(badge(container)!.textContent).toBe('1');
  });

  it('still shows the three-state label alongside the badge', () => {
    // 徽章是加上去的，不是取代狀態文字——紙條的本職沒有被擠掉。
    const { container } = render(<AgentStrip onOpenActivity={() => {}} />);
    act(() => {
      useChat.setState({ unread: 2 });
    });
    expect(container.querySelector('.ap-cap')!.textContent).toBe('Agent ready');
  });

  it('clicking still opens the AI column (the badge does not break the existing action)', () => {
    const onOpen = vi.fn();
    useView.setState({ leftOpen: false });
    const { container } = render(<AgentStrip onOpenActivity={onOpen} />);
    act(() => {
      useChat.setState({ unread: 1 });
    });
    fireEvent.click(strip(container));
    expect(onOpen).toHaveBeenCalled();
    expect(useView.getState().leftOpen).toBe(true);
  });
});
