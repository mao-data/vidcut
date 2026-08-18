import { useEffect, useLayoutEffect, useRef } from 'react';
import { ArrowUp } from 'lucide-react';
import { motionOK } from '../motion.js';
import { useChat } from '../stores/chat.js';
import { useProject } from '../stores/project.js';
import { sendChatMessage } from '../ws.js';

/**
 * 三行起跳、八行封頂（2026-08-17 使用者定案 A）。
 *
 * 這兩個數字是**行數**不是像素：像素隨字級/行高走，寫死像素的話改了 12px 內文
 * 就會變成「三行半」。`LINE_H` 是 composer 的 line-height（1.4 × 12px = 16.8，
 * 取 17）＋ 卡的上下內距在 CSS 那層。`MAX_H` 只餵給 style 的 maxHeight，
 * 真正的高度由 `autoGrow()` 用 scrollHeight 算。
 */
const ROWS_MIN = 3;
const ROWS_MAX = 8;
const LINE_H = 17;
const MAX_H = ROWS_MAX * LINE_H;

/**
 * Chat 分頁——人與 AI 的對話渠道（AI 欄的兩個分頁之一，另一個是 Activity）。
 *
 * **署名分色是主結構**（Two-Hands 體例，見 `ui/DESIGN.md`）：AI 走 `--who-ai`
 * （暗版蠟筆白／紙版 graphite）、使用者走 `--who-you`（紅蠟筆／紅鉛筆）。
 * 同一條規則、同一組 token，所以左欄三塊區域讀起來是同一份文件而不是三個小程式。
 *
 * **使用者訊息是淺色引用卡、AI 訊息維持無框正文**（2026-08-17 使用者定案 B）：
 * 這是「無泡泡」定案的**局部修訂**，不是推翻——泡泡的問題是兩側對稱、把兩句話推到
 * 兩邊、吃掉本來就窄的欄寬。單側引用卡沒有那個成本：使用者說的話是**引用進來的
 * 指令**（短、要能一眼掃到），AI 說的話是這個面板的正文（長、要好讀）。
 * 例外與理由同步記在 `ui/DESIGN.md`。
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
  const taRef = useRef<HTMLTextAreaElement>(null);

  /**
   * auto-grow：**先歸零再讀 scrollHeight**。少了歸零那一步高度只會單向長大——
   * scrollHeight 讀到的是「內容撐開後的高度」，而元素已經被上一次的 inline height
   * 撐著，刪字時它讀回來的仍是舊高度。
   *
   * 用 `useLayoutEffect` 而不是 `useEffect`：這是量測 + 寫回幾何，跑在 paint 之前
   * 才不會閃一格舊高度。跟著 `draft` 走（不是 onChange），所以草稿從 store 換回來
   * （切分頁回來、重連）時高度也會對。
   */
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // jsdom 的 scrollHeight 恆為 0：那裡會退回 rows 給的自然高度（style.height 空字串），
    // 不會把輸入框壓成 0 高。
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`;
  }, [draft]);

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
          // 空狀態**邀請動作**而不是陳述計數（2026-08-17 定案 D）：這片面板空著的時候
          // 是使用者第一次面對它，「你有 0 則訊息」沒有告訴他能做什麼。
          <div className="empty-note" style={{ color: 'var(--text-3)' }}>
            Ask the AI to make a change, or say hi.
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            // 署名列 2026-08-18 使用者定案移除(「講話不用放 you 或 AI,只要
            // 對話框就好」):視覺作者線索=對齊(人右/AI 左)+單側引用卡。
            // 讀屏不能只靠版面——作者掛在 aria-label,語意不丟。
            aria-label={m.author === 'ai' ? 'AI' : 'You'}
            style={{
              // 段落節奏（2026-08-17 定案 B）:訊息之間拉開成 8。守 4 的倍數
              // （DESIGN.md 的 spacing rhythm）。
              marginBottom: 8,
              lineHeight: 1.4,
              // 人右、AI 左（2026-08-18 使用者定案,聊天介面通用慣例）
              display: 'flex',
              flexDirection: 'column',
              alignItems: m.author === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            {/* 內文吃 --text-1（主文字階）。`pre-wrap` 讓換行（AI 傳來的、以及
                使用者 Shift+Enter 打的）照原樣呈現。
                **使用者側是引用卡**（`.chat-quote`），AI 側無框——視覺定義與
                理由在 theme.css 那條規則與 DESIGN.md。 */}
            <div
              className={m.author === 'user' ? 'chat-quote' : undefined}
              style={{
                color: 'var(--text-1)',
                whiteSpace: 'pre-wrap',
                // 引用卡不吃滿寬:全寬的「靠右」讀不出靠右(AI 正文維持全寬)。
                maxWidth: m.author === 'user' ? '85%' : undefined,
              }}
            >
              {m.text}
            </div>
          </div>
        ))}
      </div>
      {/* composer 外圈 2026-08-18 使用者定案改**無分隔線的呼吸邊距**(競品慣例:
          ChatGPT/Cursor 的輸入卡浮在欄底、不壓線不貼邊)——`.panel-bar` 退場,
          四周 12px、對列表側 8px(「輸入框太下面」的主因就是貼死底緣+壓線)。 */}
      <div style={{ padding: '8px 12px 12px', flex: 'none' }}>
        <div className="chat-composer" style={{ minWidth: 0 }}>
          <textarea
            ref={taRef}
            rows={ROWS_MIN}
            value={draft}
            disabled={!connected}
            // 離線時的 placeholder 說的是「為什麼不能打」而不是「你離線了」——
            // 與索引卡 offline 態給接回指令是同一個態度。連線時的字換成**指令式**
            // （2026-08-17 定案 A）：這個框不是聊天室，是叫 AI 改片子的地方。
            placeholder={connected ? 'Tell the AI what to change…' : 'Offline — reconnecting…'}
            onChange={(e) => useChat.getState().setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter 送出、Shift+Enter 留給換行——**現在 textarea 真的會換行**
              // （單行 input 時代 Shift+Enter 只是「不送出」）。
              // **stopPropagation 是必要的**：App 的全域快捷鍵 handler 雖然對
              // 文字控制項早退，但這裡還有一層「別讓 Enter 冒泡出去」的保險，
              // 語意上這顆鍵已經被消費掉了。
              if (e.key !== 'Enter' || e.shiftKey) return;
              e.preventDefault();
              e.stopPropagation();
              send();
            }}
            // 封頂與內部捲動：高度本身由 `autoGrow` 的 layout effect 寫，
            // 這兩條只負責「長到八行就停下來、之後自己捲」。
            style={{ maxHeight: MAX_H, overflowY: 'auto', lineHeight: `${LINE_H}px` }}
          />
          {/* 圓形 accent 實色主鈕，沉在卡的右下（`align-items: flex-end`）。
              `aria-label` 是它的可及名稱——圖示鈕沒有文字內容。 */}
          <button
            className="chat-send"
            onClick={send}
            disabled={!connected}
            title="Send"
            aria-label="Send"
          >
            <ArrowUp size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
