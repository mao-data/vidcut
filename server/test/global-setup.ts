import { mkdtemp, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 這一輪測試的暫存根目錄。test/tmp.ts 的 tmpDir() 一律建在它底下，跑完由下面的
 * teardown 整個刪掉。
 *
 * **清理為什麼一定要放在這裡，不能放在每個測試檔的 afterAll**：ProjectStore 的落盤
 * 是 debounce 500ms 的（store.ts 的 #scheduleSave → void this.#save()，射後不理），
 * 而 17 個測試檔建了 store、只有 3 個呼叫 flush()。測試檔跑完的當下往往還有一次
 * 存檔排在路上，afterAll 立刻 rm -rf 會撞上它——實測就撞到過：
 *   ENOENT: rename '.project.json.tmp' -> 'project.json'
 * 全部測試通過、卻多一個 unhandled error 讓整輪 exit 1，而且時有時無。
 * globalSetup 的 teardown 跑在**所有 worker 行程都結束之後**，沒有任何還活著的
 * 行程可能正在寫，這個競態從根本上不存在。
 *
 * 附帶好處：所有測試暫存集中在單一根目錄底下。萬一整輪被強制中斷、teardown 沒跑到，
 * 留下的是一個目錄而不是上百個散落的。
 */
const FAILED_MARKER = '.failed';

export async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'vidcut-run-'));
  process.env.VIDCUT_TEST_TMP_ROOT = root;

  return async () => {
    // 有測試失敗就整輪留著：那些目錄是出事現場（render 測試留下的就是真的 mp4）。
    // 標記由 test/setup.ts 的 afterAll 寫入。VIDCUT_KEEP_TMP=1 則無條件保留。
    if (process.env.VIDCUT_KEEP_TMP) return;
    try {
      await access(join(root, FAILED_MARKER));
      return;
    } catch {
      // 沒有失敗標記 → 可以清
    }
    await rm(root, { recursive: true, force: true });
  };
}

/** test/setup.ts 用：標記這一輪有測試失敗，teardown 就不清理。 */
export async function markFailed(root: string): Promise<void> {
  await writeFile(join(root, FAILED_MARKER), '');
}
