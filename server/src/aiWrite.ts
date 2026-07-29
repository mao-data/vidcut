import type { Command, CommandResult } from '@vidcut/shared';
import type { ProjectStore } from './store.js';
import { applyCommand } from './commands.js';

/**
 * AI 寫入的兩層守衛（spec §6.3 / §4.1），再委派給共用命令層：
 *   1. 審核進行中（doc.review !== null）→ 擋，回錯誤。
 *   2. 帶 ifVersion 且與 store.version 不符 → 擋（使用者已修改）。
 * 通過才 applyCommand(source='ai')。
 */
export function aiWrite(store: ProjectStore, cmd: Command, ifVersion?: number): CommandResult {
  if (store.doc.review !== null) {
    return {
      ok: false,
      error: 'a review is in progress; wait for the user to resolve it before editing',
    };
  }
  if (ifVersion !== undefined && ifVersion !== store.version) {
    return {
      ok: false,
      error: `stale write: your ifVersion=${ifVersion} but current version=${store.version}; call get_feedback then retry`,
    };
  }
  return applyCommand(store, 'ai', cmd);
}
