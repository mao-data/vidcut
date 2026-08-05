import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpDir } from './tmp.js';

const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 跑一個「只建暫存目錄」的假測試檔，TMPDIR 指向乾淨沙箱，回報跑完後沙箱裡剩什麼。
 *
 * 用子行程真的跑一次 vitest，是因為要驗的正是「整輪測試結束之後」這個時機——那由
 * globalSetup 的 teardown 決定，在同一個行程裡驗不到。子行程刻意跑**真的**
 * server/vitest.config.ts（用 VIDCUT_TMP_FIXTURE=1 切換 include），否則就驗不到
 * globalSetup／setupFiles 有沒有真的接上，而那正是本 repo 鐵則說的「第三步不會自動發生」。
 */
async function runFixture(env: Record<string, string> = {}) {
  const sandbox = await tmpDir('vidcut-leaksandbox-');
  const r = spawnSync('npx', ['vitest', 'run', '--root', '.'], {
    cwd: serverDir,
    env: { ...process.env, TMPDIR: sandbox, VIDCUT_TMP_FIXTURE: '1', ...env },
    encoding: 'utf8',
  });
  // 只看 vidcut-*：vitest／node 自己也可能在 TMPDIR 放東西，那不是我們要管的。
  const roots = (await readdir(sandbox)).filter((n) => n.startsWith('vidcut-'));
  const inside =
    roots.length === 1
      ? (await readdir(join(sandbox, roots[0]!))).filter((n) => n.startsWith('vidcut-'))
      : [];
  return { status: r.status, roots, inside, out: `${r.stdout}\n${r.stderr}` };
}

describe('測試自己的暫存目錄清理', () => {
  it('整輪跑完後不留下任何 vidcut-* 暫存目錄', async () => {
    const { status, roots, out } = await runFixture();
    expect(status, `假測試檔本身必須是綠的，否則驗的是別的東西：\n${out}`).toBe(0);
    expect(roots).toEqual([]);
  }, 120_000);

  it('有測試失敗時整輪保留（那是出事現場）', async () => {
    const { status, roots, inside, out } = await runFixture({ VIDCUT_TMP_FIXTURE_FAIL: '1' });
    expect(status, `這條要驗的是失敗路徑，假測試檔必須真的紅：\n${out}`).not.toBe(0);
    expect(roots).toHaveLength(1);
    expect(inside).toHaveLength(2); // 假測試檔建的那兩個
  }, 120_000);

  it('VIDCUT_KEEP_TMP=1 時即使全過也保留', async () => {
    const { status, roots, inside, out } = await runFixture({ VIDCUT_KEEP_TMP: '1' });
    expect(status, `假測試檔本身必須是綠的：\n${out}`).toBe(0);
    expect(roots).toHaveLength(1);
    expect(inside).toHaveLength(2);
  }, 120_000);
});
