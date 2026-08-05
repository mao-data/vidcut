// 給 tmp-cleanup.test.ts 當受測對象的「假測試檔」：它自己不驗證任何產品行為，
// 只負責透過 tmpDir() 建幾個暫存目錄，讓外層測試檢查跑完後有沒有被清掉。
// 刻意命名為 .fixture.ts 而非 .test.ts，才不會被主測試套件收進去跑。
import { it, expect } from 'vitest';
import { tmpDir } from '../tmp.js';

// 這條的紅綠由外層決定：帶 VIDCUT_TMP_FIXTURE_FAIL=1 就讓它紅，用來驗
// 「測試失敗時暫存目錄要留著當現場」。
it('建暫存目錄，成敗由外層環境變數決定', async () => {
  await tmpDir('vidcut-leakprobe-');
  await tmpDir('vidcut-leakprobe-');
  expect(process.env.VIDCUT_TMP_FIXTURE_FAIL).toBeUndefined();
});
