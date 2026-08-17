import { useEffect, useRef } from 'react';
import { SendHorizontal } from 'lucide-react';
import { motionOK } from '../motion.js';
import { useChat } from '../stores/chat.js';
import { useProject } from '../stores/project.js';
import { sendChatMessage } from '../ws.js';

/**
 * Chat 分頁——人與 AI 的對話渠道（AI 欄的兩個分頁之一，另一個是 Activity）。
 *
 * **不做聊天泡泡**（Two-Hands 體例，見 `ui/DESIGN.md`）：泡泡是通訊軟體的語彙，
 * 在一個工作面板裡只會吃掉寬度、把兩句話推到兩邊。這裡沿用索引卡與活動流已經
 * 在用的那套——**靠署名分色**：AI 走 `--who-ai`（暗版蠟筆白／紙版 graphite）、
 * 使用者走 `--who-you`（紅蠟筆／紅鉛筆）。同一條規則、同一組 token，
 * 所以左欄三塊區域讀起來是同一份文件而不是三個小程式。
 *
 * **離線時輸入框 disabled 但草稿留著**：草稿住在 `stores/chat.ts` 而不是這裡的
 * `useState`——斷線會讓 `connected` 變、面板重渲染，切到 Activity 分頁再切回來
 * 更是整個重掛，兩種情況下元件 state 都會把打到一半的字吃掉。
 */
export function Chat() {
  const messages = useChat((s) => s.messages);
  const draft = useChat((s) => s.draft);
  const connected = useProject((s) => s.connected);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 掛著＝使用者正在看這個分頁 → 未讀歸零（AgentStrip 的徽章就是讀這個）。
  // 卸載（切走分頁／收合欄）恢復計數。
  useEffect(() => {
    useChat.getState().setViewing(true);
    return () => useChat.getState().setViewing(false);
  }, []);

  // 新訊息自動捲到底。`motionOK()` 是全域的 reduced-motion 開關（`motion.ts`），
  // 與字幕列表的自動捲動同一套判斷——尊重系統偏好，不另立第二種行為。
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: motionOK() ? 'smooth' : 'auto' });
  }, [messages]);

  const send = () => {
    // 離線就不送（輸入框本來就 disabled，這是第二道）。空白訊息同樣不送，
    // **但不清草稿**——使用者可能正要接著打。
    if (!connected) return;
    const text = draft.trim();
    if (text.length === 0) return;
    sendChatMessage(text);
    useChat.getState().clearDraft();
  };

  return (
    <div className="panel-col">
      <div className="panel-body" ref={bodyRef} style={{ padding: 8 }}>
        {messages.length === 0 && (
          <div className="empty-note" style={{ color: 'var(--text-3)' }}>
            No messages yet
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              // 一則訊息＝一列署名 + 內文，行距與活動流／索引卡同步（2026-08-16 定案）。
              padding: '3px 0',
              lineHeight: 1.4,
            }}
          >
            <span
              style={{
                fontSize: 10,
                letterSpacing: '0.09em',
                textTransform: 'uppercase',
                color: m.author === 'ai' ? 'var(--who-ai)' : 'var(--who-you)',
              }}
            >
              {m.author === 'ai' ? 'AI' : 'You'}
            </span>
            {/* 內文吃 --text-1（主文字階），署名才帶顏色：整段話都上色的話兩個人的
                訊息會變成兩種顏色的牆，可讀性比署名分色差。`pre-wrap` 讓 AI 傳來的
                換行照原樣呈現。 */}
            <div style={{ color: 'var(--text-1)', whiteSpace: 'pre-wrap' }}>{m.text}</div>
          </div>
        ))}
      </div>
      <div className="panel-bar" style={{ gap: 4, padding: 8 }}>
        <input
          type="text"
          value={draft}
          disabled={!connected}
          // 離線時的 placeholder 說的是「為什麼不能打」而不是「你離線了」——
          // 與索引卡 offline 態給接回指令是同一個態度。
          placeholder={connected ? 'Message the agent…' : 'Offline — reconnecting…'}
          onChange={(e) => useChat.getState().setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter 送出、Shift+Enter 留給換行。**stopPropagation 是必要的**：
            // App 的全域快捷鍵 handler 雖然對 INPUT 早退，但這裡還有一層
            // 「別讓 Enter 冒泡出去」的保險，語意上這顆鍵已經被消費掉了。
            if (e.key !== 'Enter' || e.shiftKey) return;
            e.preventDefault();
            e.stopPropagation();
            send();
          }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button
          className="icon-btn"
          onClick={send}
          disabled={!connected}
          title="Send"
          aria-label="Send"
        >
          <SendHorizontal size={13} />
        </button>
      </div>
    </div>
  );
}
