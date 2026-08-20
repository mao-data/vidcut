import type { Command, CommandResult } from '@vidcut/shared';
import type { ProjectStore } from './store.js';
import { applyCommand } from './commands.js';

/**
 * ifVersion 過期判定（Plan 8 final review F2）：version 不等於 store.version
 * 不再自動等於「使用者改過」——background ingest（A1/A2）的 updateMediaDerived
 * 也會推進 store.version，而那不是使用者的編輯意圖（見 store.ts 的
 * HistoryEntry.excludeFromRevert 註解）。真正該擋的是「ifVersion 之後有一筆
 * *不是* excludeFromRevert 的歷史」——那才是使用者/AI 真的動過文件。
 *
 * 邊界情況：
 *   - ifVersion 等於目前版本 → 不算過期（最常見的快樂路徑）。
 *   - ifVersion 大於目前版本 → 一定過期：client 聲稱一個還不存在的版本，
 *     不管歷史內容都不該放行。
 *   - 歷史是記憶體內、只增不減的陣列，但有 HISTORY_MAX（見 store.ts）上限，
 *     太舊的 entry 會被裁掉。若裁掉的範圍蓋到 ifVersion（即最舊一筆歷史的
 *     version 已經大於 ifVersion + 1，中間出現缺口），代表看不到那段區間
 *     發生過什麼——保守視為過期（成因不明，不能斷定安全）。
 */
export function isStale(store: ProjectStore, ifVersion: number): boolean {
  if (ifVersion === store.version) return false;
  if (ifVersion > store.version) return true;
  const history = store.history();
  const oldest = history[0];
  // 缺口：最舊一筆歷史都晚於 ifVersion+1，代表 (ifVersion, oldest.version) 這段
  // 已被 HISTORY_MAX 裁掉，成因不明——保守視為過期。history 為空但 ifVersion 更小
  // 的情況（version 只會前進不會倒退，且 ifVersion < store.version）不會發生，
  // 但仍一併保守處理。
  if (!oldest || oldest.version > ifVersion + 1) return true;
  return history.some((h) => h.version > ifVersion && !h.excludeFromRevert);
}

/**
 * AI 寫入的兩層守衛（spec §6.3 / §4.1），再委派給共用命令層：
 *   1. 審核進行中（doc.review !== null）→ 擋，回錯誤。
 *   2. 帶 ifVersion 且判定過期（見 isStale）→ 擋（使用者/AI 真的動過文件）。
 * 通過才 applyCommand(source='ai')。
 */
export function aiWrite(store: ProjectStore, cmd: Command, ifVersion?: number): CommandResult {
  if (store.doc.review !== null) {
    return {
      ok: false,
      error: 'a review is in progress; wait for the user to resolve it before editing',
    };
  }
  if (ifVersion !== undefined && isStale(store, ifVersion)) {
    return {
      ok: false,
      error: `stale write: your ifVersion=${ifVersion} but current version=${store.version}; call get_feedback then retry`,
    };
  }
  return applyCommand(store, 'ai', cmd);
}
