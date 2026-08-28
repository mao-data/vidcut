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

// 4. 反向完整性：每個產品原始檔都必須被 HANDOFF.md 的檔案職責敘述「覆蓋」。
// 前三項驗「寫了的東西存在嗎」，這項驗「存在的東西寫了嗎」——2026-08 實例：
// `ui/src/shortcuts.ts` 新增後沒人補 HANDOFF，前三項照樣全綠。
// 覆蓋的定義（兩者其一，皆 100% 可判定）：
//   a. 檔名 basename 出現在 HANDOFF 全文（如 `shortcuts.ts`）
//   b. 某個祖先目錄以「路徑+斜線」形式被提及（如 `ui/src/stores/`——HANDOFF 以
//      目錄為單位描述一組檔案是合法寫法）
// 已知限制：basename 比對是全文字串包含，同名異目錄檔（如兩處 sync.ts）會互相
// 誤覆蓋——這讓本檢查「偏向漏報、絕不誤報」，符合零誤報硬要求。
{
  const { readdirSync } = await import('node:fs');
  const handoffText = readFileSync(join(root, 'HANDOFF.md'), 'utf8');
  const SRC_ROOTS = ['ui/src', 'server/src', 'shared/src'];
  const SRC_EXT = /\.(ts|tsx|css|py)$/;
  const SKIP = /(\.test\.|\.d\.ts$)/;
  const walk = (dir) =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(rel);
      return [rel];
    });
  // 目錄提及必須是「以斜線收尾的獨立路徑」（`ui/src/stores/` 後接空白/反引號等），
  // 不能只是更長路徑的前綴——不然 `ui/src/theme.css` 的存在就讓 `ui/src/` 覆蓋一切，
  // 檢查變空包彈（首版真的犯了這個錯，突變驗證抓到的）。
  const dirMentioned = (dir) =>
    new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(?![A-Za-z0-9_.-])').test(
      handoffText,
    );
  const covered = (rel) => {
    if (handoffText.includes(rel.slice(rel.lastIndexOf('/') + 1))) return true;
    const parts = rel.split('/');
    for (let i = parts.length - 1; i > 1; i--) {
      if (dirMentioned(parts.slice(0, i).join('/'))) return true;
    }
    return false;
  };
  for (const top of SRC_ROOTS) {
    for (const rel of walk(top)) {
      if (!SRC_EXT.test(rel) || SKIP.test(rel) || rel.includes('/test/')) continue;
      if (!covered(rel)) {
        problems.push(
          `HANDOFF.md: 原始檔 \`${rel}\` 沒有被檔案職責敘述覆蓋——新增檔案時要補一行職責（或其所屬目錄的整組敘述）`,
        );
      }
    }
  }
}

// 5. landing（`site/index.html`）的工具清單必須與 checked-in 的 MCP 工具面 snapshot 一致。
//
// 為什麼需要這條：README 的工具數有 `api.test.ts`／snapshot 這類閘門守著，所以只漂了 1；
// landing 完全沒有任何閘門，實測從 31 漂到真實的 39——**少列了 8 支**（素材庫四支、
// set_canvas、export_publish_package、post_chat、get_chat），而且三處顯示數字全是 31。
// 對外頁面少報自己的產品，跟誇大一樣是假話，只是方向相反。
//
// 100% 可判定（符合零誤報硬要求）：兩邊都是機器可讀的清單，逐名比對集合，沒有語意判斷。
// 只掃 `<section id="tools">` 那一段，避免頁面其它 `<li>` 混進來。
//
// ⚠️ **要數的是開源線的工具面，不是這個檢出的。** `site/` 賣的是 AGPL 自架版（頁面上
// 寫著「No account, no upload, no key」），而 pro 檢出的 snapshot 是**雲端**工具面
// （多出十幾支付費才有的）。直接讀工作樹的 snapshot，在 pro 上就會報「site 少了 N 支」
// ——那是誤報，而這支腳本的零誤報是硬要求。判別方式用已有的不變式：`CLAUDE.cloud.md`
// **只存在於 pro 檢出**（見該檔第二行）。在 pro 上改讀 `origin/main` 的 ref；取不到就
// 整條跳過（不報問題）——寧可漏報也不誤報，與檢查 4 的取捨一致。
// 這個坑是 2026-08-28 加這條檢查時、跨線複驗當場抓到的，不是推想。
{
  const snapPath = 'server/test/__snapshots__/mcp-surface.snap.json';
  const sitePath = 'site/index.html';
  const isProCheckout = existsSync(join(root, 'CLAUDE.cloud.md'));
  let snapJson = null;
  if (isProCheckout) {
    try {
      const { execFileSync } = await import('node:child_process');
      snapJson = execFileSync('git', ['show', `origin/main:${snapPath}`], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      snapJson = null; // 沒有 origin/main（淺 clone、無 remote…）→ 跳過，不誤報
    }
  } else if (existsSync(join(root, snapPath))) {
    snapJson = readFileSync(join(root, snapPath), 'utf8');
  }
  if (snapJson && existsSync(join(root, sitePath))) {
    const snap = JSON.parse(snapJson);
    const real = new Set(snap.tools.map((t) => t.name));
    const html = readFileSync(join(root, sitePath), 'utf8');
    const section = html.match(/<section id="tools">([\s\S]*?)<\/section>/)?.[1];
    if (!section) {
      problems.push(`${sitePath}: 找不到 \`<section id="tools">\`——工具清單檢查失效了`);
    } else {
      // 只收「整個 li 就是一個工具名（可帶一個 <em> 註記）」的項目
      const listed = new Set(
        [...section.matchAll(/<li>\s*([a-z][a-z0-9_]*)\s*(?:<em>[^<]*<\/em>\s*)?<\/li>/g)].map(
          (m) => m[1],
        ),
      );
      for (const name of real) {
        if (!listed.has(name)) problems.push(`${sitePath}: 工具清單少了 \`${name}\``);
      }
      for (const name of listed) {
        if (!real.has(name)) problems.push(`${sitePath}: 工具清單列了不存在的 \`${name}\``);
      }
      // 三處顯示數字也要跟著對——清單對了但標題還寫舊數字，一樣是假話
      const n = real.size;
      for (const [label, re] of [
        ['內文 "N MCP tools"', /(\d+) MCP tools/],
        ['標題 "N tools"', /<span class="red">(\d+) tools<\/span>/],
        ['manifest "N / N"', /<span class="mono">(\d+) \/ (\d+)<\/span>/],
      ]) {
        const m = section.match(re) ?? html.match(re);
        if (!m) problems.push(`${sitePath}: 找不到${label}，數字檢查失效了`);
        else if (m.slice(1).some((g) => Number(g) !== n))
          problems.push(`${sitePath}: ${label} 寫 ${m.slice(1).join('/')}，實際工具數是 ${n}`);
      }
    }

    // 兩份 README 的九組工具表 + 開頭那個「N MCP tools」連結。
    // 這裡**只驗漏列與數字**，不驗「多列」——README 是散文，反引號裡的識別字不見得
    // 都在講工具，反向比對會誤報。偏向漏報是刻意的（同檢查 4 的取捨）。
    // 這個數字漂過：0243e43 才把 README/HANDOFF 從舊值手動改成 39。
    for (const [doc, countRe] of [
      ['README.md', /\[(\d+) MCP tools\]/],
      ['README.zh-TW.md', /\[(\d+) 個 MCP 工具\]/],
    ]) {
      if (!existsSync(join(root, doc))) continue;
      const text = readFileSync(join(root, doc), 'utf8');
      for (const name of real) {
        if (!text.includes(`\`${name}\``)) problems.push(`${doc}: 工具表少了 \`${name}\``);
      }
      const m = text.match(countRe);
      if (!m) problems.push(`${doc}: 找不到「N MCP tools」的工具數宣稱，數字檢查失效了`);
      else if (Number(m[1]) !== real.size)
        problems.push(`${doc}: 工具數寫 ${m[1]}，實際是 ${real.size}`);
    }
  }
}

if (problems.length) {
  console.log(`文件引用檢查：${problems.length} 個問題`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log(
  `文件引用檢查：${DOCS.length} 份斷言型文件的引用都指向真實存在的東西，原始檔皆被 HANDOFF 覆蓋`,
);
