#!/usr/bin/env node
/**
 * 手動突變測試引擎（本 repo 不裝 stryker——對這個規模過重）。
 *
 * scripts/mutants.json 列出每一隻 mutant：在哪個檔案、把什麼字串換成什麼、
 * 哪個測試檔應該因此變紅。本腳本逐隻套用 → 跑該測試檔 → 期待失敗（= 殺掉）
 * → 還原 → 下一隻。任何一隻存活（測試照樣綠）就代表那組斷言是假的，退出碼 1。
 *
 * 用法：node scripts/mutate.mjs [id ...]      （不給 id = 全部）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mutants = JSON.parse(readFileSync(join(root, 'scripts/mutants.json'), 'utf8'));
const only = process.argv.slice(2);
const picked = only.length ? mutants.filter((m) => only.includes(m.id)) : mutants;

function runTests(testPath) {
  // 測試檔屬於哪個 workspace，就在那裡跑（vitest config 不同）
  const ws = testPath.startsWith('ui/') ? 'ui' : testPath.startsWith('server/') ? 'server' : '.';
  const rel = ws === '.' ? testPath : relative(ws, testPath);
  try {
    execFileSync('npx', ['vitest', 'run', rel], {
      cwd: join(root, ws),
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return 'pass';
  } catch {
    return 'fail';
  }
}

const results = [];
for (const m of picked) {
  const abs = join(root, m.file);
  const original = readFileSync(abs, 'utf8');
  const hits = original.split(m.find).length - 1;
  if (hits !== 1) {
    results.push({ ...m, outcome: 'ERROR', detail: `find 出現 ${hits} 次（需恰好 1 次）` });
    continue;
  }
  try {
    writeFileSync(abs, original.replace(m.find, m.replace));
    const r = runTests(m.tests);
    results.push({ ...m, outcome: r === 'fail' ? 'KILLED' : 'SURVIVED' });
  } finally {
    writeFileSync(abs, original); // 一定還原，即使中途丟例外
  }
  const last = results.at(-1);
  process.stdout.write(`${last.outcome === 'KILLED' ? '✔' : '✘'} ${m.id}  ${m.note}\n`);
}

const bad = results.filter((r) => r.outcome !== 'KILLED');
console.log(`\n${results.length - bad.length}/${results.length} mutants killed`);
for (const b of bad)
  console.log(`  ${b.outcome}: ${b.id} — ${b.note}${b.detail ? ` (${b.detail})` : ''}`);
process.exit(bad.length ? 1 : 0);
