import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatMessage } from '@vidcut/shared';
import { useChat, NO_MESSAGES } from './chat.js';

/**
 * 聊天的 UI 狀態：訊息清單 + 草稿 + 未讀計數。
 *
 * **草稿留在 store 而不是元件 state**：離線時輸入框要 disabled 但**不能丟掉已打的字**，
 * 而斷線/重連會讓面板重掛（分頁切換也會）。草稿放元件裡的話那些字就沒了。
 */

function msg(id: string, author: ChatMessage['author'], text: string): ChatMessage {
  return { id, author, text, ts: new Date(1700000000000).toISOString() };
}

beforeEach(() => {
  useChat.setState({ messages: NO_MESSAGES, draft: '', unread: 0, viewing: false, loaded: false });
});

describe('chat store: messages', () => {
  it('starts empty', () => {
    expect(useChat.getState().messages).toEqual([]);
  });

  it('receive() replaces the list (the server always sends the whole log)', () => {
    useChat.getState().receive([msg('a', 'user', 'one')]);
    useChat.getState().receive([msg('a', 'user', 'one'), msg('b', 'ai', 'two')]);
    expect(useChat.getState().messages.map((m) => m.text)).toEqual(['one', 'two']);
  });

  it('an empty log resets to the shared constant, not a fresh array', () => {
    // zustand v5 的 selector 不得回傳新 reference（CLAUDE.md 鐵則：React #185 白屏）。
    // 空清單一律指回同一個 reference，訂閱者才不會每次都看到「變了」。
    useChat.getState().receive([msg('a', 'user', 'one')]);
    useChat.getState().receive([]);
    expect(useChat.getState().messages).toBe(NO_MESSAGES);
  });
});

describe('chat store: draft (survives going offline)', () => {
  it('keeps the draft text', () => {
    useChat.getState().setDraft('half typed');
    expect(useChat.getState().draft).toBe('half typed');
  });

  it('receiving messages does not wipe the draft', () => {
    // 使用者打到一半，AI 剛好回一句——不能把他的字吃掉。
    useChat.getState().setDraft('half typed');
    useChat.getState().receive([msg('a', 'ai', 'hi')]);
    expect(useChat.getState().draft).toBe('half typed');
  });

  it('clearDraft empties it (used after a successful send)', () => {
    useChat.getState().setDraft('sent');
    useChat.getState().clearDraft();
    expect(useChat.getState().draft).toBe('');
  });
});

describe('chat store: unread badge', () => {
  /**
   * 「連上時收到的第一份記錄不算未讀」是規格的一部分（見本檔最後那條測試），
   * 所以每個要驗計數的案例都得先過那一份。用一則使用者訊息當地基——
   * 它本來就不會被計數，不會污染後面的斷言。
   */
  function connected(): void {
    useChat.getState().receive([msg('seed', 'user', 'seed')]);
  }
  const seeded = (...rest: ChatMessage[]) => [msg('seed', 'user', 'seed'), ...rest];

  it('counts new AI messages while the user is not looking at the Chat tab', () => {
    connected();
    useChat.getState().receive(seeded(msg('a', 'ai', 'one')));
    useChat.getState().receive(seeded(msg('a', 'ai', 'one'), msg('b', 'ai', 'two')));
    expect(useChat.getState().unread).toBe(2);
  });

  it('does not count the user’s own messages', () => {
    // 自己剛打的字不是「未讀」。
    connected();
    useChat.getState().receive(seeded(msg('a', 'user', 'mine')));
    expect(useChat.getState().unread).toBe(0);
  });

  it('counts only the AI messages in a mixed batch', () => {
    connected();
    useChat.getState().receive(seeded(msg('a', 'user', 'mine'), msg('b', 'ai', 'reply')));
    expect(useChat.getState().unread).toBe(1);
  });

  it('does not count while the Chat tab is being viewed', () => {
    connected();
    useChat.getState().setViewing(true);
    useChat.getState().receive(seeded(msg('a', 'ai', 'one')));
    expect(useChat.getState().unread).toBe(0);
  });

  it('setViewing(true) clears the badge (opening the tab marks everything read)', () => {
    connected();
    useChat.getState().receive(seeded(msg('a', 'ai', 'one')));
    expect(useChat.getState().unread).toBe(1);
    useChat.getState().setViewing(true);
    expect(useChat.getState().unread).toBe(0);
  });

  it('resumes counting after the user leaves the tab', () => {
    connected();
    useChat.getState().setViewing(true);
    useChat.getState().receive(seeded(msg('a', 'ai', 'one')));
    useChat.getState().setViewing(false);
    useChat.getState().receive(seeded(msg('a', 'ai', 'one'), msg('b', 'ai', 'two')));
    expect(useChat.getState().unread).toBe(1);
  });

  it('the very first log on connect is not counted as unread', () => {
    // 重整之後整份歷史會重送一次。把它算成未讀的話，開頁面就頂著一個
    // 「你有 40 則未讀」的假徽章。
    useChat.getState().receive([msg('a', 'ai', 'old'), msg('b', 'ai', 'older')]);
    expect(useChat.getState().unread).toBe(0);
  });

  it('a re-sent identical log adds nothing (resync must not inflate the badge)', () => {
    connected();
    useChat.getState().receive(seeded(msg('a', 'ai', 'one')));
    const before = useChat.getState().unread;
    useChat.getState().receive(seeded(msg('a', 'ai', 'one')));
    expect(useChat.getState().unread).toBe(before);
  });

  it('the first AI message in an empty-history project still counts as unread', () => {
    // 全新專案:連線時 server 送的第一份記錄是**空清單**。「首份不算未讀」指的是
    // 歷史重送,不是「空清單之後的第一則新訊息」——AI 開口的第一句必須亮徽章,
    // 而這正是新專案最常見的路徑(主 session 驗收 2026-08-17 抓到的洞:用
    // NO_MESSAGES reference 當首載判準,空首載後 reference 不變,第二份也被當首載)。
    useChat.getState().receive([]);
    useChat.getState().receive([msg('a', 'ai', 'hello')]);
    expect(useChat.getState().unread).toBe(1);
  });

  it('a shorter log (server restarted with a fresh file) does not go negative', () => {
    connected();
    useChat.getState().receive(seeded(msg('a', 'ai', 'one'), msg('b', 'ai', 'two')));
    useChat.getState().receive([]);
    expect(useChat.getState().unread).toBeGreaterThanOrEqual(0);
  });
});
