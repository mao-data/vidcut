import { afterAll } from 'vitest';
import { markFailed } from './global-setup.js';

// 實際刪除在 test/global-setup.ts 的 teardown（所有 worker 結束之後才跑，避開與
// ProjectStore debounce 落盤的競態）。這裡只負責一件事：這個測試檔有測試失敗時，
// 寫下標記讓 teardown 別清——那些目錄是出事現場。
function hasFailure(tasks: readonly unknown[]): boolean {
  return tasks.some((t) => {
    const task = t as { result?: { state?: string }; tasks?: unknown[] };
    if (task.result?.state === 'fail') return true;
    return task.tasks ? hasFailure(task.tasks) : false;
  });
}

afterAll(async (suite) => {
  const root = process.env.VIDCUT_TEST_TMP_ROOT;
  if (!root) return;
  if (hasFailure((suite as { tasks?: unknown[] }).tasks ?? [])) await markFailed(root);
});
