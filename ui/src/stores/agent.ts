import { create } from 'zustand';
import type { HistoryBrief, WsServerMsg } from '@vidcut/shared';

/**
 * AI 存在感的 store 層（spec `docs/superpowers/specs/2026-08-14-agent-presence-design.md` §3.2）。
 * **這裡零視覺**：只維護「哪些 MCP 工具呼叫正在跑」，三態與顯示欄位由純函數推導，
 * 經過秒數交給元件層自己算（store 只存 startedAt，免得每秒 set 一次 state 把整棵樹重繪）。
 */

/**
 * 模組級常數 fallback——selector 不得回傳新 reference（見 CLAUDE.md 鐵則：
 * zustand v5 的 selector 回新物件會同步無限重渲染 → React #185 → 白屏）。
 * 集合清空時一律指回這一個 reference，而不是新的 `{}`。
 */
export const NO_CALLS: Readonly<Record<string, AgentCall>> = {};

/** 一筆進行中的工具呼叫。`startedAt` 是 `Date.now()`（毫秒 epoch）。 */
export interface AgentCall {
  tool: string;
  startedAt: number;
}

/** 三態（spec §3.2 的表）。 */
export type AgentPhase = 'offline' | 'idle' | 'working';

/**
 * 三態推導。**offline 優先於 working**：WS 沒連的時候集合裡剩什麼都不算數
 * （`setConnected(false)` 本來就會清空，這裡是第二道保險）。
 */
export function agentPhase(
  connected: boolean,
  calls: Readonly<Record<string, AgentCall>>,
): AgentPhase {
  if (!connected) return 'offline';
  return Object.keys(calls).length > 0 ? 'working' : 'idle';
}

/**
 * 顯示用：最新一筆進行中的呼叫（工具連發時只秀最後開始的那個）。
 * 回的是集合裡**既有的物件 reference**，不是新組的——同一份 calls 連續呼叫回同一個
 * reference，才能直接餵給 zustand selector。
 */
export function currentCall(calls: Readonly<Record<string, AgentCall>>): AgentCall | null {
  const ids = Object.keys(calls);
  if (ids.length === 0) return null;
  // 插入順序即開始順序：callId 是 server 端的遞增序號，而物件的字串鍵在
  // 非整數索引時保序。callId 目前是數字字串（'1'、'2'…），JS 會把它們當
  // 整數索引排在前面並以數值升序排列——兩種情況下最後一個都是最新的。
  return calls[ids[ids.length - 1]];
}

/** session 統計：活動記錄依 source 分計（純函數，零 server 變更；spec §3.2 末）。 */
export function sessionCounts(entries: readonly HistoryBrief[]): { ai: number; human: number } {
  let ai = 0;
  let human = 0;
  for (const e of entries) {
    if (e.source === 'ai') ai += 1;
    else human += 1;
  }
  return { ai, human };
}

interface AgentState {
  /** callId → 進行中的呼叫。空的時候一定是 `NO_CALLS` 這個 reference。 */
  calls: Readonly<Record<string, AgentCall>>;
  /** 收 agentActivity：start 加入、end 移除。 */
  apply: (msg: Extract<WsServerMsg, { type: 'agentActivity' }>) => void;
  /** 斷線清空（**不得卡假忙碌**：server 死了 ws 必斷，這裡就是天然自癒點）。 */
  clear: () => void;
}

export const useAgent = create<AgentState>((set, get) => ({
  calls: NO_CALLS,
  apply: (msg) => {
    const { calls } = get();
    if (msg.phase === 'start') {
      set({ calls: { ...calls, [msg.callId]: { tool: msg.tool, startedAt: Date.now() } } });
      return;
    }
    // end：沒有對應 start 的 callId（重連後才收到尾巴、或 server 重啟）就當沒事發生，
    // 不新建物件——避免無謂的 re-render。
    if (!(msg.callId in calls)) return;
    const next: Record<string, AgentCall> = {};
    for (const [id, call] of Object.entries(calls)) if (id !== msg.callId) next[id] = call;
    set({ calls: Object.keys(next).length === 0 ? NO_CALLS : next });
  },
  clear: () => {
    if (get().calls !== NO_CALLS) set({ calls: NO_CALLS });
  },
}));
