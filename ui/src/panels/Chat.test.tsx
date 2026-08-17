import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import type { ChatMessage } from '@vidcut/shared';
import { Chat } from './Chat.js';
import { useChat, NO_MESSAGES } from '../stores/chat.js';
import { useProject } from '../stores/project.js';
import * as ws from '../ws.js';
import { resetStores, seedProject } from '../test/fixtures.js';

/**
 * Chat 分頁的行為契約。
 *
 * **視覺不在這裡驗**（同 AgentPanel.test.tsx 的體例）：jsdom 不載 CSS。
 * 這裡驗文字、DOM 結構、送出、離線行為與署名接線。
 */

function msg(id: string, author: ChatMessage['author'], text: string): ChatMessage {
  return { id, author, text, ts: new Date(1700000000000).toISOString() };
}

let sent: string[];

beforeEach(() => {
  resetStores();
  useChat.setState({ messages: NO_MESSAGES, draft: '', unread: 0, viewing: false });
  sent = [];
  vi.spyOn(ws, 'sendChatMessage').mockImplementation((t: string) => {
    sent.push(t);
  });
});
afterEach(() => vi.restoreAllMocks());

/** 取輸入框（一個 Chat 面板只有一個文字輸入）。 */
function input(container: HTMLElement): HTMLInputElement | HTMLTextAreaElement {
  const el = container.querySelector('input[type="text"], textarea');
  if (!el) throw new Error('no chat input');
  return el as HTMLInputElement | HTMLTextAreaElement;
}

describe('Chat panel: message list', () => {
  it('shows an empty-state note when there are no messages', () => {
    seedProject();
    const { container } = render(<Chat />);
    expect(container.querySelector('.empty-note')).not.toBeNull();
  });

  it('renders each message text', () => {
    seedProject();
    act(() => useChat.getState().receive([msg('a', 'user', 'shorten it'), msg('b', 'ai', 'done')]));
    const { container } = render(<Chat />);
    expect(container.textContent).toContain('shorten it');
    expect(container.textContent).toContain('done');
  });

  it('attributes each message by author (Two-Hands: signatures, not bubbles)', () => {
    seedProject();
    act(() => useChat.getState().receive([msg('a', 'user', 'mine'), msg('b', 'ai', 'theirs')]));
    const { container } = render(<Chat />);
    // 署名分色是用 --who-* token 表達的（暗版蠟筆白/紅蠟筆）。jsdom 讀不到 CSS，
    // 但 inline style 的 var() 引用讀得到——驗的是「有沒有接上對的 token」。
    const html = container.innerHTML;
    expect(html).toContain('var(--who-ai)');
    expect(html).toContain('var(--who-you)');
  });

  it('does not render chat bubbles (design decision: signature-coloured rows)', () => {
    seedProject();
    act(() => useChat.getState().receive([msg('a', 'ai', 'hello')]));
    const { container } = render(<Chat />);
    expect(container.querySelector('.bubble, .chat-bubble')).toBeNull();
  });

  it('keeps messages in the order the server sent them', () => {
    seedProject();
    act(() =>
      useChat
        .getState()
        .receive([msg('a', 'user', 'first'), msg('b', 'ai', 'second'), msg('c', 'user', 'third')]),
    );
    const { container } = render(<Chat />);
    const text = container.textContent ?? '';
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
    expect(text.indexOf('second')).toBeLessThan(text.indexOf('third'));
  });
});

describe('Chat panel: sending', () => {
  it('sends the typed text on Enter and clears the draft', () => {
    seedProject();
    const { container } = render(<Chat />);
    const el = input(container);
    fireEvent.change(el, { target: { value: 'make it punchier' } });
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(sent).toEqual(['make it punchier']);
    expect(useChat.getState().draft).toBe('');
  });

  it('does not send on Shift+Enter (that is a newline, not a send)', () => {
    seedProject();
    const { container } = render(<Chat />);
    const el = input(container);
    fireEvent.change(el, { target: { value: 'multi' } });
    fireEvent.keyDown(el, { key: 'Enter', shiftKey: true });
    expect(sent).toEqual([]);
  });

  it('does not send a blank message', () => {
    seedProject();
    const { container } = render(<Chat />);
    const el = input(container);
    fireEvent.change(el, { target: { value: '   ' } });
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(sent).toEqual([]);
    // 空白訊息不送，但也別把使用者的字清掉——他可能正要繼續打。
    expect(useChat.getState().draft).toBe('   ');
  });

  it('typing updates the store draft (so it survives a remount)', () => {
    seedProject();
    const { container, unmount } = render(<Chat />);
    fireEvent.change(input(container), { target: { value: 'half typed' } });
    unmount();
    expect(useChat.getState().draft).toBe('half typed');
    const second = render(<Chat />);
    expect(input(second.container).value).toBe('half typed');
  });
});

describe('Chat panel: offline', () => {
  it('disables the input while the socket is down', () => {
    seedProject();
    act(() => useProject.getState().setConnected(false));
    const { container } = render(<Chat />);
    expect(input(container).disabled).toBe(true);
  });

  it('keeps the draft text while offline (typed words must not be thrown away)', () => {
    seedProject();
    const { container } = render(<Chat />);
    fireEvent.change(input(container), { target: { value: 'typed before the drop' } });
    act(() => useProject.getState().setConnected(false));
    expect(useChat.getState().draft).toBe('typed before the drop');
    expect(input(container).value).toBe('typed before the drop');
  });

  it('re-enables the input on reconnect, draft intact and sendable', () => {
    seedProject();
    const { container } = render(<Chat />);
    fireEvent.change(input(container), { target: { value: 'survived' } });
    act(() => useProject.getState().setConnected(false));
    act(() => useProject.getState().setConnected(true));
    const el = input(container);
    expect(el.disabled).toBe(false);
    expect(el.value).toBe('survived');
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(sent).toEqual(['survived']);
  });

  it('does not send while offline even if Enter is pressed', () => {
    seedProject();
    const { container } = render(<Chat />);
    fireEvent.change(input(container), { target: { value: 'nope' } });
    act(() => useProject.getState().setConnected(false));
    fireEvent.keyDown(input(container), { key: 'Enter' });
    expect(sent).toEqual([]);
    expect(useChat.getState().draft).toBe('nope');
  });
});

describe('Chat panel: read state', () => {
  it('marks the chat as being viewed while mounted (this is what clears the badge)', () => {
    seedProject();
    act(() => {
      useChat.setState({ unread: 3 });
    });
    render(<Chat />);
    expect(useChat.getState().viewing).toBe(true);
    expect(useChat.getState().unread).toBe(0);
  });

  it('stops being viewed once unmounted (switching away resumes counting)', () => {
    seedProject();
    const { unmount } = render(<Chat />);
    unmount();
    expect(useChat.getState().viewing).toBe(false);
  });
});
