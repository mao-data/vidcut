#!/usr/bin/env node
/**
 * 手動突變測試引擎（本 repo 不裝 stryker——對這個規模過重）。
 *
 * scripts/mutants.json 列出每一隻 mutant：在哪個檔案、把什麼字串換成什麼、
 * 哪個測試檔應該因此變紅。本腳本逐隻套用 → 跑該測試檔 → 期待失敗（= 殺掉）
 * → 還原 → 下一隻。任何一隻存活（測試照樣綠）就代表那組斷言是假的，退出碼 1。
 *
 * 用法：node scripts/mutate.mjs [--check] [id ...]      （不給 id = 全部）
 *
 * --check 只驗每隻 mutant 的 find 字串在目標檔恰好出現一次，不跑任何測試（秒級）。
 * 存在的理由：重構會讓 find 字串失配，那隻 mutant 就靜默失去守備——實際發生過三隻
 * （render-aspect / mcp-writereply-always-err / setaudio-validate）在多個 commit
 * 之間都是失效的。完整模式當然抓得到，但它要跑十幾分鐘，於是大家用 --fast，而
 * --fast 整關跳過突變。這個模式便宜到可以放進 --fast，讓那個缺口關起來。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mutants = JSON.parse(readFileSync(join(root, 'scripts/mutants.json'), 'utf8'));
const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const only = argv.filter((a) => !a.startsWith('--'));
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
  if (checkOnly) {
    results.push({ ...m, outcome: 'ANCHORED' });
    continue;
  }
  try {
    writeFileSync(abs, original.replace(m.find, m.replace));
    const r = runTests(m.tests);
    // expect:'survive' = 等價變異對照組：語意不變，本來就殺不掉。
    // 留一隻在清單裡，是為了證明引擎會如實回報存活，而不是對什麼都喊「殺掉」。
    const want = m.expect === 'survive' ? 'pass' : 'fail';
    const ok = r === want;
    results.push({
      ...m,
      outcome: ok ? (m.expect === 'survive' ? 'EQUIVALENT' : 'KILLED') : 'SURVIVED',
    });
  } finally {
    writeFileSync(abs, original); // 一定還原，即使中途丟例外
  }
  const last = results.at(-1);
  const mark = last.outcome === 'KILLED' ? '✔' : last.outcome === 'EQUIVALENT' ? '≡' : '✘';
  process.stdout.write(`${mark} ${m.id}  ${m.note}\n`);
}

const bad = results.filter(
  (r) => r.outcome !== 'KILLED' && r.outcome !== 'EQUIVALENT' && r.outcome !== 'ANCHORED',
);
if (checkOnly) {
  const anchored = results.filter((r) => r.outcome === 'ANCHORED').length;
  console.log(`${anchored}/${results.length} mutants 的 find 字串都在目標檔恰好命中一次`);
  for (const b of bad) console.log(`  ${b.outcome}: ${b.id} — ${b.detail}`);
  process.exit(bad.length ? 1 : 0);
}
const killed = results.filter((r) => r.outcome === 'KILLED').length;
const equiv = results.filter((r) => r.outcome === 'EQUIVALENT').length;
console.log(
  `\n${killed}/${results.length - equiv} mutants killed` +
    (equiv ? ` (+${equiv} equivalent control${equiv > 1 ? 's' : ''} survived as expected)` : ''),
);
for (const b of bad)
  console.log(`  ${b.outcome}: ${b.id} — ${b.note}${b.detail ? ` (${b.detail})` : ''}`);
process.exit(bad.length ? 1 : 0);
