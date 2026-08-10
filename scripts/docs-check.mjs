#!/usr/bin/env node
/**
 * 斷言型文件的引用完整性檢查。秒級、無依賴，供 gauntlet.sh 呼叫。
 *
 * 只檢查「描述現況」的文件（DOCS 常數）。ROADMAP 與 specs/plans 是前瞻型的——
 * 引用還不存在的檔案是正常的，納入檢查只會製造誤報。
 *
 * 零誤報是這支腳本的硬要求：會狼來了的關卡比沒有還糟，它會被習慣性忽略，
 * 真的紅了也沒人看。所以只驗三件能百分之百判定的事：
 *   1. `npm run X` / `npm run X -w <ws>` 的 X 真的存在（會查對應 workspace）
 *   2. 反引號裡形如 path/to/file.ext 的路徑真的存在
 *   3. 沒有引用被 .gitignore 的路徑（別人 clone 之後必然失效）
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = [
  'CLAUDE.md',
  'HANDOFF.md',
  'README.md',
  'README.zh-TW.md',
  'CONTRIBUTING.md',
  '.claude/rules/ui-verification.md',
  '.claude/rules/wysiwyg.md',
];
// 被 .gitignore 的前綴：常駐文件引用這些，別人 clone 之後一定查不到
const IGNORED_PREFIXES = ['.superpowers/', 'projects/', 'node_modules/', 'dist/', 'coverage/'];

const scripts = (pkgDir) => {
  const p = join(root, pkgDir, 'package.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')).scripts ?? {}) : {};
};
const WORKSPACES = { '@vidcut/ui': 'ui', '@vidcut/server': 'server', '@vidcut/shared': 'shared' };

const problems = [];
for (const doc of DOCS) {
  const abs = join(root, doc);
  if (!existsSync(abs)) {
    problems.push(`${doc}: 這份文件本身不存在（DOCS 清單過期）`);
    continue;
  }
  const text = readFileSync(abs, 'utf8');

  // 1. npm script
  // -w 後的 workspace 名只吃合法字元（\w、@、.、/、-）；原本用 \S+ 會吞到反引號與
  // 中文標點——CJK 文字前後沒有空白，`npm run build -w @vidcut/ui`**，否則…` 會被整段
  // 吃進 workspace 名稱，造成明明存在的 script 被誤判成不存在。
  for (const m of text.matchAll(/npm run ([a-zA-Z0-9:_-]+)(?:\s+-w\s+([\w@./-]+))?/g)) {
    const [, name, ws] = m;
    const dir = ws ? (WORKSPACES[ws] ?? ws) : '.';
    if (!(name in scripts(dir))) {
      problems.push(
        `${doc}: \`npm run ${name}${ws ? ` -w ${ws}` : ''}\` —— ${dir}/package.json 裡沒有這個 script`,
      );
    }
  }

  // 2. 反引號裡的檔案路徑
  // 字元類別 [...] 內的 `/` 不需要跳脫（跟 regex literal 分隔符無關，eslint
  // no-useless-escape 會抓這個）；類別外那個 `\/`（`\.claude)\/`）仍是必要的，
  // 不跳脫的話會被解析成正則字面量的結束分隔符。
  for (const m of text.matchAll(
    /`((?:server|ui|shared|scripts|docs|\.claude)\/[A-Za-z0-9_./-]+\.[a-z0-9]{2,4})/g,
  )) {
    if (!existsSync(join(root, m[1]))) problems.push(`${doc}: 引用了不存在的檔案 \`${m[1]}\``);
  }

  // 3. 被忽略的路徑：只比對「像檔案指標」的完整路徑（反引號內、副檔名結尾）。
  // 原本用 text.includes(`\`${pre}`) 逐字串比對，只要反引號後緊接前綴就報——結果把
  // `projects/demo`、`projects/*/.env`、`node_modules/@vidcut/shared` 這類「說明這個
  // 目錄本身怎麼運作」的合法提及（本工具的核心運作概念，clone 後照文件走完 `npm
  // install`／`npm run demo` 就會有）全部當成失效引用。真正該擋的是「指向一個具體檔案、
  // 要讀者去查閱內容」的引用（像 Step 3 負向對照的 `.superpowers/sdd/whatever.md`）——
  // 那種才會在 clone 後真的打不開。用副檔名結尾當判準來區分兩者。
  const ignoredFileRe = new RegExp(
    '`((?:' +
      IGNORED_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
      ')[A-Za-z0-9_./-]+\\.[a-z0-9]{2,4})`',
    'g',
  );
  for (const m of text.matchAll(ignoredFileRe)) {
    problems.push(`${doc}: 引用了被 .gitignore 的路徑（\`${m[1]}\`）——別人 clone 之後必然失效`);
  }
}

if (problems.length) {
  console.log(`文件引用檢查：${problems.length} 個問題`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log(`文件引用檢查：${DOCS.length} 份斷言型文件的引用都指向真實存在的東西`);
