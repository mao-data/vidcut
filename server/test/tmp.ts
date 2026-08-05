import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 測試用的暫存目錄工廠：把 mkdtemp(join(tmpdir(), 'vidcut-x-')) 換成 tmpDir('vidcut-x-')。
//
// 差別只有一個——建在「這一輪測試的根目錄」底下（由 test/global-setup.ts 建立、
// 經 VIDCUT_TEST_TMP_ROOT 傳進來），跑完整輪一次刪掉。以前是直接建在系統 temp 且
// 從來沒人刪：91 個 mkdtemp 呼叫只有 15 處配對的 rm，而且多數 mkdtemp 藏在每條測試
// 都會呼叫一次的 helper 裡（commands.test.ts 只寫 3 個 mkdtemp 卻產出 4,291 個目錄），
// 所以 afterAll 時根本沒有東西可以刪。實測一次全套跑留下 147 個目錄／97MB。
//
// 沒有 VIDCUT_TEST_TMP_ROOT 時退回系統 temp（例如有人直接跑單一測試檔而繞過
// globalSetup）——行為與從前相同，只是不會被自動清掉。
export async function tmpDir(prefix: string): Promise<string> {
  return mkdtemp(join(process.env.VIDCUT_TEST_TMP_ROOT ?? tmpdir(), prefix));
}
