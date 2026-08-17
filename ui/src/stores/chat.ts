import { create } from 'zustand';
import type { ChatMessage } from '@vidcut/shared';

/**
 * 聊天的 UI 狀態（spec：AI 欄的 Chat 分頁）。
 *
 * **不碰 doc、不碰 version**：聊天是人與 AI 的 meta 溝通，不是編輯操作
 * （server 端的理由見 `server/src/chatStore.ts` 檔頭）。所以它自己一顆 store，
 * 而不是掛在 `stores/project.ts` 上。
 *
 * 三件事住在這裡而不是元件裡：
 *
 * 1. **訊息清單**——server 每次都送整份（見 WS 的 `chat` 訊息），這裡整份換掉。
 * 2. **草稿**——離線時輸入框 disabled 但**字要留著**。斷線會讓 `connected` 變，
 *    面板重渲染；使用者切到 Activity 分頁再切回來也會重掛。草稿放元件 state
 *    的話這兩種情況都會把打到一半的字吃掉。
 * 3. **未讀數**——AgentStrip 的徽章要在「左欄收合或不在 Chat 分頁」時顯示。
 */

/**
 * 模組級常數 fallback——selector 不得回傳新 reference（CLAUDE.md 鐵則：
 * zustand v5 的 selector 回新陣列會同步無限重渲染 → React #185 → 白屏）。
 * 空清單一律指回這一個 reference。
 */
export const NO_MESSAGES: readonly ChatMessage[] = [];

interface ChatState {
  messages: readonly ChatMessage[];
  /** 輸入框內容。離線時仍然保留（這正是它住在 store 的理由）。 */
  draft: string;
  /** 未讀的 AI 訊息數（使用者不在 Chat 分頁時累積）。 */
  unread: number;
  /** 使用者此刻是否正看著 Chat 分頁（決定新訊息算不算未讀）。 */
  viewing: boolean;
  /**
   * 是否已收過連線後的第一份記錄。**必須是顯式旗標**，不能用
   * `messages === NO_MESSAGES` 推斷——空歷史專案的首份記錄就是空清單，
   * reference 不變，第二份（AI 開口的第一句）會被誤判成首載而漏計未讀
   * （主 session 驗收 2026-08-17 抓到的洞）。
   */
  loaded: boolean;
  /** 收到 server 的整份聊天記錄。 */
  receive: (messages: ChatMessage[]) => void;
  setDraft: (text: string) => void;
  clearDraft: () => void;
  setViewing: (viewing: boolean) => void;
}

export const useChat = create<ChatState>((set, get) => ({
  messages: NO_MESSAGES,
  draft: '',
  unread: 0,
  viewing: false,
  loaded: false,
  receive: (messages) => {
    const prev = get();
    // **第一份記錄不算未讀。** 連上（含重整、重連）時 server 會把整份歷史送過來；
    // 把它算成新訊息的話，一開啟編輯器就頂著一個「你有 40 則未讀」的假徽章。
    // 判準是顯式的 loaded 旗標（理由見型別宣告——空首載會讓 reference 判準失效）。
    const firstLoad = !prev.loaded;
    // 只數**新增的那幾則**裡的 AI 訊息。server 每次送整份，所以新增的是尾巴那一段；
    // 清單變短（server 換了專案/檔案被清掉）時 slice 給空陣列，不會算成負數。
    const added = messages.slice(prev.messages.length);
    const newFromAi = added.filter((m) => m.author === 'ai').length;
    set({
      messages: messages.length === 0 ? NO_MESSAGES : messages,
      unread: firstLoad || prev.viewing ? prev.unread : prev.unread + newFromAi,
      loaded: true,
      // 草稿刻意不動：使用者可能正打到一半。
    });
  },
  setDraft: (text) => set({ draft: text }),
  clearDraft: () => set({ draft: '' }),
  setViewing: (viewing) =>
    // 打開分頁＝全部讀過了。關閉時不動未讀數（它本來就是 0）。
    set(viewing ? { viewing, unread: 0 } : { viewing }),
}));
