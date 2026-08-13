#!/usr/bin/env node
/**
 * 產品原始碼裡不得出現中文字串字面值。秒級、無新相依，供 gauntlet.sh 呼叫。
 *
 * 為什麼要有這道：README / LICENSE / GitHub 都是對外英文的，但使用者在終端機、
 * AI 在 MCP 描述裡看到的字曾經全是中文。人工 grep 擋不住回歸——這個 repo 的**註解
 * 是中文的、而且應該維持中文**，所以 grep 會噴滿螢幕的假警報；反過來，把中文
 * 訊息折成多行字串串接（prettier 常態）就能躲過任何單行 grep。實例：改英文那輪，
 * 三條測試斷言咬著中文訊息，我用「同一行同時有中文和 toThrow」去找，而 prettier
 * 把正規表示式折到自己一行，兩個條件永遠不會同時成立——是 gauntlet 撿回來的。
 *
 * 所以這裡走 TypeScript 的 AST：只看 StringLiteral / NoSubstitutionTemplateLiteral /
 * TemplateExpression 的字面部分 / JsxText。註解天生就不是這些節點，**結構性零誤報**，
 * 折不折行也完全不影響。
 *
 * 範圍只有產品原始碼（server/src、ui/src、shared/src），不含測試：測試的 it() 標題
 * 與 fixture 用中文是給維護者看的，跟使用者面無關。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['server/src', 'ui/src', 'shared/src'];
// 與 shared/src/captions.ts 的 CJK 同一組範圍，但這裡不 import：關卡要能在 build
// 壞掉的時候照樣跑。**一律用 \u 逃脫**——全形空白 U+3000 直接貼進原始碼看不出來，
// 而且 eslint 的 no-irregular-whitespace 會擋（captions.ts 的註解也記著同一件事）。
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    // 測試與測試輔助檔不在範圍內（見檔頭）
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !p.includes('/test/')) {
      files.push(p);
    }
  }
};
for (const r of ROOTS) walk(join(root, r));

const problems = [];
for (const abs of files) {
  const rel = abs.slice(root.length + 1);
  const src = readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(
    abs,
    src,
    ts.ScriptTarget.Latest,
    true,
    abs.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const visit = (node) => {
    let text = null;
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isJsxText(node)) &&
      CJK.test(node.text)
    ) {
      text = node.text;
    } else if (ts.isTemplateExpression(node)) {
      // 只看字面部分：`${中文變數}` 是執行期資料，不是原始碼裡的中文
      const literal = node.head.text + node.templateSpans.map((s) => s.literal.text).join('');
      if (CJK.test(literal)) text = literal;
    }
    if (text !== null) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      problems.push(`${rel}:${line}  ${JSON.stringify(text.trim()).slice(0, 80)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (problems.length > 0) {
  console.error(`使用者面字串檢查：${problems.length} 處中文字串字面值`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\n產品原始碼的字串是使用者（或 AI）讀的，一律英文。註解維持中文，不受這道檢查影響。',
  );
  process.exit(1);
}
console.log(`使用者面字串檢查：${files.length} 個產品原始碼檔案裡沒有中文字串字面值`);
