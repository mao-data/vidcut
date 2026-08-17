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

/**
 * 取輸入框（一個 Chat 面板只有一個文字輸入）。
 *
 * **2026-08-17 composer 改版：`input[type=text]` → `textarea`**（使用者定案 A）。
 * selector 保留兩者是刻意的——它是「這個面板的那一個文字輸入」的通用取用器，
 * 下面另有一條 S1 專門把「必須是 textarea」釘死，所以這裡放寬不會讓形態失守。
 * 回傳型別同樣保留聯集，因為 `.value` / `.disabled` 是兩者共通的斷言面。
 */
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

  // 空狀態文案（2026-08-17 使用者定案 D）：從狀態陳述 'No messages yet' 換成
  // **邀請動作**的一句話。這是新增的斷言，不是既有斷言的放寬——上面那條只問
  // 「有沒有空狀態」，這條問「它說了什麼」。
  it('invites the first message instead of just stating the count is zero', () => {
    seedProject();
    const { container } = render(<Chat />);
    expect(container.querySelector('.empty-note')!.textContent).toBe(
      'Ask the AI to make a change, or say hi.',
    );
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

  /**
   * 使用者側引用卡（2026-08-17 使用者定案 B）：**無泡泡定案的局部修訂**——
   * 只有使用者訊息成為淺色圓角引用卡，AI 訊息維持無框正文。
   * 上一條「不做泡泡」仍然有效且未被弱化：泡泡的定義是「兩側對稱、靠氣泡分邊」，
   * 這裡是單側引用卡（AI 側無框），兩條測試同時綠才是規格。
   */
  it('wraps the user message in a quote card, and leaves the AI message unframed', () => {
    seedProject();
    act(() => useChat.getState().receive([msg('a', 'user', 'mine'), msg('b', 'ai', 'theirs')]));
    const { container } = render(<Chat />);
    const cards = Array.from(container.querySelectorAll('.chat-quote'));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain('mine');
    expect(cards[0]!.textContent).not.toContain('theirs');
  });

  it('keeps the signature row on both authors (a11y + left-column consistency)', () => {
    seedProject();
    act(() => useChat.getState().receive([msg('a', 'user', 'mine'), msg('b', 'ai', 'theirs')]));
    const { container } = render(<Chat />);
    const text = container.textContent ?? '';
    expect(text).toContain('You');
    expect(text).toContain('AI');
  });

  it('renders multi-line text verbatim (pre-wrap, so Shift+Enter newlines survive)', () => {
    seedProject();
    act(() => useChat.getState().receive([msg('a', 'user', 'line one\nline two')]));
    const { container } = render(<Chat />);
    const body = Array.from(container.querySelectorAll<HTMLElement>('*')).find(
      (el) => el.style.whiteSpace === 'pre-wrap' && el.textContent === 'line one\nline two',
    );
    expect(body).toBeTruthy();
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

/**
 * Composer（2026-08-17 使用者定案 A）：單行 input → auto-grow textarea，
 * 送出鈕從 ghost icon-btn 換成圓形 accent 實色主鈕。
 */
describe('Chat panel: composer', () => {
  /** 送出鈕：以 aria-label 取，不綁 class（class 是視覺，label 是契約）。 */
  function sendBtn(container: HTMLElement): HTMLButtonElement {
    const el = container.querySelector('button[aria-label="Send"]');
    if (!el) throw new Error('no send button');
    return el as HTMLButtonElement;
  }

  it('S1: the composer is a textarea (Shift+Enter must produce a real newline)', () => {
    seedProject();
    const { container } = render(<Chat />);
    expect(container.querySelector('textarea')).not.toBeNull();
    // 單行 input 不得殘留：兩個都在的話 `input()` 取到哪一個是隨機的
    expect(container.querySelector('input[type="text"]')).toBeNull();
  });

  it('S2: starts about three rows tall and is controlled by the store draft', () => {
    seedProject();
    const { container } = render(<Chat />);
    const ta = container.querySelector('textarea')!;
    expect(ta.rows).toBe(3);
    expect(ta.value).toBe('');
  });

  /**
   * S3：auto-grow 的兩半——**跟著內容長高**，以及**到八行封頂**。
   *
   * jsdom 的 `scrollHeight` 恆為 0，所以真實增長量不到；但把它 stub 成可控值之後，
   * 元件那條 `Math.min(scrollHeight, MAX_H)` 就完全可觀測了。stub 的是
   * `HTMLTextAreaElement.prototype`（jsdom 上它是個 getter），afterEach 的
   * `restoreAllMocks` 會還原。
   *
   * 這比「只驗 maxHeight 有值」強：後者是**宣告面**的斷言，攔不住 JS 端把 clamp
   * 拿掉——實測過，`chat-autogrow-uncapped` 那隻 mutant 在只驗 maxHeight 時存活。
   */
  function stubScrollHeight(px: number) {
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(px);
  }

  it('S3a: grows to fit the content while under the cap', () => {
    seedProject();
    stubScrollHeight(51); // 3 行 × 17
    const { container } = render(<Chat />);
    const ta = container.querySelector('textarea')!;
    fireEvent.change(ta, { target: { value: 'a\nb\nc' } });
    expect(ta.style.height).toBe('51px');
  });

  it('S3b: caps at eight rows and scrolls internally past that', () => {
    seedProject();
    stubScrollHeight(1000); // 遠超過封頂
    const { container } = render(<Chat />);
    const ta = container.querySelector('textarea')!;
    fireEvent.change(ta, { target: { value: 'a very long pasted paragraph' } });
    // 8 行 × 17 = 136。長高停在這裡，剩下的內容自己捲。
    expect(ta.style.height).toBe('136px');
    expect(ta.style.overflowY).toBe('auto');
  });

  it('S4: the send button is a real button with an accessible name', () => {
    seedProject();
    const { container } = render(<Chat />);
    const b = sendBtn(container);
    expect(b.tagName).toBe('BUTTON');
    // 圓形實色主鈕走自己的 class，不再是 ghost 的 .icon-btn
    expect(b.className).toContain('chat-send');
    expect(b.className).not.toContain('icon-btn');
  });

  it('S5: clicking the send button sends the draft', () => {
    seedProject();
    const { container } = render(<Chat />);
    fireEvent.change(input(container), { target: { value: 'via the button' } });
    fireEvent.click(sendBtn(container));
    expect(sent).toEqual(['via the button']);
    expect(useChat.getState().draft).toBe('');
  });

  it('S6: the idle placeholder asks for an edit, not for a chat message', () => {
    seedProject();
    const { container } = render(<Chat />);
    expect(input(container).placeholder).toBe('Tell the AI what to change…');
  });

  it('S7: offline keeps the reconnecting placeholder and disables the send button too', () => {
    seedProject();
    act(() => useProject.getState().setConnected(false));
    const { container } = render(<Chat />);
    expect(input(container).placeholder).toBe('Offline — reconnecting…');
    expect(sendBtn(container).disabled).toBe(true);
  });

  it('S8: a Shift+Enter newline is preserved in the draft and sent verbatim', () => {
    seedProject();
    const { container } = render(<Chat />);
    const el = input(container);
    fireEvent.change(el, { target: { value: 'first' } });
    fireEvent.keyDown(el, { key: 'Enter', shiftKey: true });
    // textarea 的換行由瀏覽器插入；這裡模擬它，重點是**送出時原樣保存**。
    fireEvent.change(el, { target: { value: 'first\nsecond' } });
    expect(useChat.getState().draft).toBe('first\nsecond');
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(sent).toEqual(['first\nsecond']);
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
