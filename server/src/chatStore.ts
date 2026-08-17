import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '@vidcut/shared';

/** 落盤格式。包一層物件（不是裸陣列）好讓將來加欄位不必改檔案格式。 */
interface ChatFile {
  messages: ChatMessage[];
}

const SAVE_DEBOUNCE_MS = 500;

/**
 * 單則訊息的長度上限，**兩個入口共用**（WS 的 `sendChatMessage` 與 MCP 的 `post_chat`）。
 * 放在這裡而不是各自宣告一份：兩邊分岔的話，同一段話從 UI 送進來會被截、
 * 從 AI 送進來不會，而那種不一致沒有任何測試會叫。
 */
export const CHAT_MAX_LEN = 4000;

/** 一則訊息長什麼樣才算數。壞資料不該讓整份記錄消失，只丟掉壞的那幾筆。 */
function isChatMessage(v: unknown): v is ChatMessage {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    (m.author === 'user' || m.author === 'ai') &&
    typeof m.text === 'string' &&
    typeof m.ts === 'string'
  );
}

/**
 * 每專案一份 `chat.json`（與 `project.json` 同目錄）的聊天記錄。
 *
 * **為什麼不是 `ProjectStore` 的一部分**（這是這個檔案存在的全部理由）：
 * 聊天是人與 AI 關於編輯的 **meta 溝通**，不是編輯操作。所以它
 *
 *  - 不進 `Project` doc、不走 `applyCommand`（CLAUDE.md 鐵則管的是「專案狀態變更」，
 *    一句話不是專案狀態）；
 *  - 不進版本／歷史／undo——Cmd+Z 是「撤掉我剛做的編輯」，把使用者說過的話一起
 *    撤掉沒有任何道理，而且 undo 之後那句話要不要重送也無法回答。
 *
 * 落盤照 `ProjectStore` 的模式：debounce 500ms + 寫 tmp 再 rename（原子替換，
 * 半途斷電不會留下截斷的 JSON）。
 *
 * **載入一律容錯**：檔案缺失、壞 JSON、形狀不對，通通退成空清單而不是拋錯。
 * 聊天是附屬功能，`startServer` 裡多一個 throw 就等於整個編輯器打不開。
 */
export class ChatStore {
  #messages: ChatMessage[] = [];
  #filePath: string;
  #listeners = new Set<(messages: readonly ChatMessage[]) => void>();
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #saving: Promise<void> = Promise.resolve();

  private constructor(filePath: string, messages: ChatMessage[]) {
    this.#filePath = filePath;
    this.#messages = messages;
  }

  static async load(filePath: string): Promise<ChatStore> {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const list = (parsed as ChatFile | null)?.messages;
      const messages = Array.isArray(list) ? list.filter(isChatMessage) : [];
      return new ChatStore(filePath, messages);
    } catch {
      return new ChatStore(filePath, []);
    }
  }

  /** 目前的全部訊息（**複本**：呼叫端拿去 push 動不到 store 內部狀態）。 */
  messages(): readonly ChatMessage[] {
    return [...this.#messages];
  }

  /** 追加一則訊息、通知監聽者（WS 廣播掛在這裡）、排程落盤。 */
  append(author: ChatMessage['author'], text: string): ChatMessage {
    const msg: ChatMessage = {
      id: randomUUID(),
      author,
      text,
      ts: new Date().toISOString(),
    };
    this.#messages.push(msg);
    this.#scheduleSave();
    const snapshot = this.messages();
    for (const cb of this.#listeners) cb(snapshot);
    return msg;
  }

  onChange(cb: (messages: readonly ChatMessage[]) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #scheduleSave(): void {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      void this.#save();
    }, SAVE_DEBOUNCE_MS);
  }

  #save(): Promise<void> {
    this.#saving = this.#saving.then(async () => {
      await mkdir(dirname(this.#filePath), { recursive: true });
      const tmp = join(dirname(this.#filePath), '.chat.json.tmp');
      const file: ChatFile = { messages: this.#messages };
      await writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
      await rename(tmp, this.#filePath);
    });
    return this.#saving;
  }

  /** 立刻落盤（測試／關機用）。 */
  async flush(): Promise<void> {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    await this.#save();
  }
}
