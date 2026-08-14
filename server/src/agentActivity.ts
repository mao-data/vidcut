import { EventEmitter } from 'node:events';

/**
 * AI 工具呼叫的進行中旁路（spec `docs/superpowers/specs/2026-08-14-agent-presence-design.md` §3.1）。
 *
 * 型態照 `renderProgressBus`（`server/src/render.ts`）的既有前例：EventEmitter →
 * `wsHub.ts` 監聽後廣播給所有 WS client。**暫態資料，不進版本/歷史/undo，不是 Command。**
 *
 * 為什麼是**獨立模組**而不是塞進 `mcp.ts`（發射點所在，最貼近 render.ts 的前例）：
 *
 * 1. **wsHub 只需要 bus，不需要整個 MCP 工具面。** `wsHub.ts → mcp.ts` 會把 express、
 *    zod、MCP SDK 全拉進 WS 模組的依賴圖，只為了一個 EventEmitter。（現在沒有循環：
 *    mcp.ts 不 import wsHub.ts——但那條邊一旦接上就多一個未來會踩的地雷。）
 * 2. **計數器必須是模組級單例。** `mountMcp` 是 stateless 的——**每個 HTTP 請求
 *    createMcpServer 一次**，所以 per-server 的計數器會在每次請求歸零，兩個並發呼叫
 *    就會拿到同一個 callId，UI 端的集合會互相覆蓋（start 的 tool 被蓋、其中一個 end
 *    把兩筆都刪掉）。放在模組作用域是唯一正確的位置。
 * 3. 可以單獨測、單獨 reset，不必為了驗序號去建一台 MCP server。
 */
export const agentActivityBus = new EventEmitter();

/** bus 上 'activity' 事件的 payload（與 `WsServerMsg` 的 agentActivity 同形，去掉 type）。 */
export interface AgentActivityEvent {
  phase: 'start' | 'end';
  tool: string;
  callId: string;
}

/**
 * 模組級遞增序號。從 1 起，每呼叫一次 +1——決定性，測試可直接斷言 '1'/'2'/'3'。
 * 字串而不是數字：`callId` 在 UI 端當物件鍵用，型別上直接是 string 少一次轉換。
 */
let seq = 0;

/** 取下一個 callId（'1'、'2'、'3'…）。 */
export function nextCallId(): string {
  seq += 1;
  return String(seq);
}

/** 只給測試用：把序號歸零，讓每個測試檔的斷言互不干擾。 */
export function resetCallIds(): void {
  seq = 0;
}

/** 廣播一則進行中訊號。 */
export function emitAgentActivity(e: AgentActivityEvent): void {
  agentActivityBus.emit('activity', e);
}
