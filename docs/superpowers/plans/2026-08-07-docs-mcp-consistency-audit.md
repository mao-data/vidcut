# 文件與 MCP 一致性稽核 + 永久關卡 Implementation Plan

> **歷史文件（2026-08-07 的實作計畫）**：記錄當時的決策與理由，**不隨程式碼更新**。
> 現況以 `CLAUDE.md`／`HANDOFF.md` 為準。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 vidcut 所有常駐文件與 MCP 工具面對照程式碼校正一次，並把其中「能可靠機檢」的部分做成 gauntlet 關卡，讓同類漂移不會再靜默發生。

**Architecture:** 兩層。**下層是關卡**——三道自動檢查（MCP 工具 ↔ instructions、Command variant ↔ MCP 工具、文件引用 ↔ 實際檔案），前兩道是 vitest 測試（隨全測試套件跑），第三道是 `scripts/docs-check.mjs` 加進 `gauntlet.sh`。**上層是人工稽核**——關卡驗不到的行為性陳述，由實作者逐份讀文件、對照程式碼、改掉不符的句子。關卡先做，因為做完立刻會吐出一部分漂移清單，人工稽核只需處理機器驗不到的部分。

**Tech Stack:** Node 22 / TypeScript 5.9 / vitest 3.2 / `@modelcontextprotocol/sdk`（`Client` + `InMemoryTransport`）/ 純 Node ESM 腳本（`scripts/*.mjs`，無新依賴）

## Global Constraints

- **不新增任何 npm 依賴。** 檢查腳本用 Node 內建模組即可。
- **關卡的誤報率必須是零。** 本計劃立案前實測過兩個粗糙原型：「文件提到的 npm script 是否存在」誤報 `build`（文件寫的是 `npm run build -w @vidcut/ui`，`build` 在 `ui/package.json`）；「文件提到的檔案是否存在」誤報 `shared/src/captionPresets.ts`、`shared/utils/subtitles.ts`（兩者都在 ROADMAP 的「尚未排程」段，是**提議中**要建的檔案）。會狼來了的關卡比沒有還糟——它會被習慣性忽略，真的紅了也沒人看。凡是無法零誤報的檢查，寧可不做，改列進人工稽核。
- **「斷言型文件」與「前瞻型文件」分開對待。** 斷言型＝描述現況（`CLAUDE.md`、`.claude/rules/*.md`、`HANDOFF.md`、`README.md`、`README.zh-TW.md`），引用必須指向真實存在的東西，納入機檢。前瞻型＝描述可能的未來（`docs/ROADMAP.md`、`docs/superpowers/specs/`、`docs/superpowers/plans/`），引用不存在的檔案是正常的，**不納入機檢**。
- **不得引用被 `.gitignore` 的路徑。** 常駐文件引用 `.superpowers/`、`projects/`、`node_modules/`、`dist/`、`coverage/` 底下的東西，在別人 clone 之後一律失效（本 repo 踩過：EVIDENCE 曾有 10 餘處引用指向 `.superpowers/`）。
- **常駐文件不寫會過期的數字。** 既有方針：機器相關的耗時、佔用、覆蓋率百分比等不寫進常駐文件；要寫就標明「某次實測，未重驗」。
- **行為性陳述以讀程式碼核對為準**（本次已定案的驗證深度）。不重跑 `verify:wysiwyg`／`verify:canvas` 之類要花幾十分鐘的實測；文件裡既有的實測數字保留，但必須標明出處與「未重驗」。
- **任何專案狀態變更走 `applyCommand`（人）或 `aiWrite`→`applyCommand`（AI）**，本計劃不改這條路徑上的任何行為。
- **本計劃不改變任何產品行為。** 只動文件、測試、檢查腳本。唯一可能動到 `server/src/mcp.ts` 的情形是「工具描述文字」與「instructions 文字」，那屬於文件。
- **`projects/*/.env` 與各專案密鑰不得提交或印出內容。**
- **不要 `git add -A`**：這個工作區常有多個 session 同時進行，只 stage 自己動過的路徑。

---

## File Structure

**新增：**

| 檔案                                | 職責                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/test/mcp-docs-sync.test.ts` | 兩道 MCP 面守衛：工具 ↔ instructions、Command variant ↔ MCP 工具。獨立成檔而不塞進 `mcp-tools.test.ts`，因為它驗的是「面的完整性」而非個別工具行為，且需要自己的豁免清單。 |
| `scripts/docs-check.mjs`            | 斷言型文件的引用完整性檢查。純 Node、無依賴、秒級，供 `gauntlet.sh` 呼叫。                                                                                                 |
| `docs/DOC-AUDIT-2026-08-07.md`      | 本次人工稽核的結果報告：每一條不符的陳述、根據、怎麼改的。稽核完成後這份是唯一的交代。                                                                                     |

**修改：**

| 檔案                                                                            | 改什麼                                                                                                 |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `server/test/mcp-tools.test.ts`                                                 | 刪掉舊的「instructions 與工具清單同步」describe（硬編 6 個工具名、從不呼叫 `listTools()`），由新檔取代 |
| `scripts/gauntlet.sh`                                                           | 新增「文件引用」關卡，位置在「突變錨點」之後、「依賴稽核」之前                                         |
| `CLAUDE.md`、`.claude/rules/*.md`、`HANDOFF.md`、`README.md`、`README.zh-TW.md` | 稽核發現的不符陳述                                                                                     |
| `server/src/mcp.ts`                                                             | 僅工具描述與 instructions 文字                                                                         |
| `docs/ROADMAP.md`                                                               | 清掉已完成項目、標明前瞻型文件的定位                                                                   |

---

## Task 1: MCP 工具 ↔ instructions 同步守衛

**Files:**

- Create: `server/test/mcp-docs-sync.test.ts`
- Modify: `server/test/mcp-tools.test.ts`（刪除舊守衛 describe）
- Modify: `server/src/mcp.ts`（若稽核決定某些工具該寫進 instructions）

**Interfaces:**

- Consumes: `createMcpServer(deps: McpDeps)` 與 `server/test/mcp-tools.test.ts` 既有的 `Client` + `InMemoryTransport` 建置樣式
- Produces: `server/test/mcp-docs-sync.test.ts` 內的 `INSTRUCTIONS_EXEMPT: Record<string, string>`（工具名 → 豁免理由），Task 2 會在同一檔案加第二個 describe

**背景（實作者必讀）：** 這個 repo 的鐵則寫「新增一種編輯操作是三步，第三步不會自動發生：`mcp.ts` 手動 `registerTool` 並同步 `instructions`」。既有的守衛測試**擋不住那件事**——它硬編 6 個工具名去 `toContain`，工具真的沒註冊時它照樣綠（`docs/ROADMAP.md` 第 11 條記為 I-5）。實測現況：`registerTool` 宣告 31 個工具，其中 8 個沒出現在 instructions 裡（`get_project`、`get_history`、`update_clip`、`reorder_clips`、`remove_clip`、`undo`、`redo`、`extract_audio`）。**這 8 個不一定是缺陷**——`undo`/`redo`/`get_project` 可能刻意不寫進流程敘事。本 Task 的價值就在於逼出「刻意 vs 忘了」的明確記錄。

- [ ] **Step 1: 寫失敗的測試**

建立 `server/test/mcp-docs-sync.test.ts`。建置樣式照抄 `server/test/mcp-tools.test.ts` 開頭（`Client`、`InMemoryTransport`、`createMcpServer`、`beforeAll`/`afterAll`），暫存目錄一律用 `tmpDir()`（`./tmp.js`）而非 `mkdtemp`：

```ts
/**
 * MCP「面的完整性」守衛。與 mcp-tools.test.ts 的差別：那邊驗個別工具的行為，
 * 這邊驗「有沒有工具漏掉、有沒有工具沒寫進文件」。
 *
 * 存在的理由是 CLAUDE.md 的鐵則第三步（registerTool + 同步 instructions 不會自動
 * 發生）。舊守衛硬編 6 個工具名做 toContain，工具真的沒註冊時照樣綠，等於沒守。
 */
const INSTRUCTIONS_EXEMPT: Record<string, string> = {
  // 稽核時逐一填入，值是「為什麼這個工具不必出現在 instructions」的理由。
  // 空著不填 = 測試會紅，這是刻意的：逼出「刻意省略」與「忘了寫」的區別。
};

describe('MCP 面的完整性', () => {
  it('每個註冊的工具都出現在 instructions 裡，或有明列的豁免理由', async () => {
    const { tools } = await client.listTools();
    const instructions = client.getInstructions() ?? '';
    expect(instructions.length).toBeGreaterThan(0);

    const undocumented = tools
      .map((t) => t.name)
      .filter((n) => !instructions.includes(n) && !(n in INSTRUCTIONS_EXEMPT));

    expect(
      undocumented,
      `這些工具既沒寫進 instructions、也沒列進 INSTRUCTIONS_EXEMPT：${undocumented.join(', ')}\n` +
        `AI 使用者只能靠 instructions 認識工具面——要嘛把它寫進去，要嘛在豁免表裡寫下理由。`,
    ).toEqual([]);
  });

  it('豁免清單不得列入不存在的工具（清單自己也會過期）', async () => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    const stale = Object.keys(INSTRUCTIONS_EXEMPT).filter((n) => !names.has(n));
    expect(stale, `豁免清單裡這些工具已經不存在：${stale.join(', ')}`).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `npx vitest run --root server test/mcp-docs-sync.test.ts`

Expected: 第一條 FAIL，訊息列出 8 個工具名（`get_project`、`get_history`、`update_clip`、`reorder_clips`、`remove_clip`、`undo`、`redo`、`extract_audio`）。第二條 PASS（空清單本來就沒有過期項）。

**若失敗訊息不是這 8 個**，代表 `mcp.ts` 在本計劃立案後又變了——照實際輸出走，不要改測試遷就。

- [ ] **Step 3: 逐一裁決那 8 個工具**

對每一個，讀 `server/src/mcp.ts` 裡它的 `registerTool` 描述與實作，二選一：

- **寫進 instructions**：這個工具是 AI 剪片流程裡會用到、但敘事漏掉的。改 `mcp.ts` 的 instructions 字串（它是單引號串接，不是模板字串）。
- **列進 `INSTRUCTIONS_EXEMPT`**：附一句具體理由。可接受的理由形如「唯讀查詢工具，描述已自足，不屬於流程步驟」；不可接受的形如「不重要」「暫時豁免」。

參考判準（**不是結論，實作者要自己看程式碼確認**）：`get_project`/`get_history`/`get_editor_context` 這類唯讀查詢、`undo`/`redo` 這類通用操作，通常屬於豁免；`update_clip`/`reorder_clips`/`remove_clip`/`extract_audio` 是會改專案狀態的編輯操作，AI 不知道它們存在就等於用不到，**傾向寫進 instructions**。

- [ ] **Step 4: 跑測試確認它通過**

Run: `npx vitest run --root server test/mcp-docs-sync.test.ts`
Expected: 2 passed

- [ ] **Step 5: 刪掉被取代的舊守衛**

從 `server/test/mcp-tools.test.ts` 刪除整個 `describe('instructions 與工具清單同步', ...)`（含「寫入型的主線工具都出現在 instructions 裡」與「instructions 說明了純音訊素材的軌道限制」兩條）。**把後者搬進新檔**——它驗的是 instructions 的內容而非工具清單，仍然有價值：

```ts
it('instructions 說明了純音訊素材的軌道限制', () => {
  expect(client.getInstructions() ?? '').toMatch(/純音訊/);
});
```

- [ ] **Step 6: 確認殺傷力（新守衛真的擋得住鐵則第三步）**

暫時把 `mcp.ts` 裡任何一個**有寫進 instructions**的工具的 `registerTool(...)` 整段註解掉，跑：

Run: `npx vitest run --root server test/mcp-docs-sync.test.ts`
Expected: 第一條仍 PASS（工具不在 `tools` 裡，自然不會被列為 undocumented）——**這代表方向反了**，這道守衛擋的是「有工具但沒文件」，不是「有文件但沒工具」。

因此**補第三條測試**，讓反方向也被守住：

```ts
it('instructions 提到的工具名都真的註冊了（防止描述留在文件裡、實作已移除）', async () => {
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  const instructions = client.getInstructions() ?? '';
  // instructions 裡形如 snake_case 且長度 >= 4 的詞，視為工具名候選
  const mentioned = [...new Set(instructions.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])];
  const ghosts = mentioned.filter((n) => !names.has(n));
  expect(ghosts, `instructions 提到但實際沒註冊的工具：${ghosts.join(', ')}`).toEqual([]);
});
```

跑一次確認它在「註解掉某個工具」時轉紅、還原後轉綠。**還原 `mcp.ts`**，用 `git diff` 確認乾淨。

- [ ] **Step 7: 跑全套確認沒破壞既有測試**

Run: `npx vitest run --root server`
Expected: 全過，且總數 = 原本數字 − 2（刪掉的舊守衛）+ 3（新守衛）

- [ ] **Step 8: Commit**

```bash
git add server/test/mcp-docs-sync.test.ts server/test/mcp-tools.test.ts server/src/mcp.ts
git commit -m "test(mcp): 工具面完整性守衛取代硬編的假守衛（ROADMAP I-5）"
```

---

## Task 2: Command variant ↔ MCP 工具覆蓋守衛

**Files:**

- Modify: `server/test/mcp-docs-sync.test.ts`（加第二個 describe）

**Interfaces:**

- Consumes: Task 1 建立的 `client`、`listTools()` 樣式
- Produces: `MCP_EXEMPT_COMMANDS: Record<string, string>`（Command variant 名 → 豁免理由）

**背景：** 鐵則的三步是「`shared/src/types.ts` 加 variant → `commands.ts` 加 case → `mcp.ts` `registerTool`」。第一、二步漏掉會被型別檢查抓到（`commands.ts` 的 switch 少一個 case 會編譯失敗），**只有第三步沒有任何東西擋**——前例就是 `addClip` 做完八輪 TDD 卻沒人能用。實測現況：`shared` 有 **24 個 Command variant**，`commands.ts` 有 **24 個 case**（相符），MCP 有 31 個工具。

- [ ] **Step 1: 寫失敗的測試**

加進 `server/test/mcp-docs-sync.test.ts`：

```ts
/**
 * 鐵則第三步的執行面守衛：Command variant 加了、commands.ts 也加了，但忘記
 * registerTool——AI 就永遠碰不到這個能力。前例：addClip 做完八輪 TDD 卻沒人能用。
 * 第一、二步漏掉會被 tsc 抓到（commands.ts 的 switch 少 case 編不過），只有第三步
 * 從前沒有任何東西擋。
 */
const MCP_EXEMPT_COMMANDS: Record<string, string> = {
  // variant 名 → 為什麼它不需要對應的 MCP 工具
};

describe('Command variant 都能從 MCP 觸達', () => {
  it('每個 Command variant 都有對應的 MCP 工具，或有明列的豁免理由', async () => {
    const { tools } = await client.listTools();
    const toolNames = new Set(tools.map((t) => t.name));
    // camelCase variant → snake_case 工具名（addClip → add_clip）
    const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

    const unreachable = COMMAND_VARIANTS.filter(
      (v) => !toolNames.has(toSnake(v)) && !(v in MCP_EXEMPT_COMMANDS),
    );

    expect(
      unreachable,
      `這些 Command variant 沒有對應的 MCP 工具，也沒列進豁免表：${unreachable.join(', ')}\n` +
        `＝ AI 永遠碰不到這個能力（CLAUDE.md 鐵則第三步）。`,
    ).toEqual([]);
  });

  it('豁免清單不得列入不存在的 variant', () => {
    const stale = Object.keys(MCP_EXEMPT_COMMANDS).filter((v) => !COMMAND_VARIANTS.includes(v));
    expect(stale, `豁免清單裡這些 variant 已經不存在：${stale.join(', ')}`).toEqual([]);
  });
});
```

`COMMAND_VARIANTS` 的來源**必須是型別本身**，不能手抄一份清單（手抄的清單會跟著過期，等於沒守）。在檔案頂端加：

```ts
import type { Command } from '@vidcut/shared';

/**
 * 從 Command 聯集型別取出所有 name。這是編譯期檢查：任何 variant 新增或改名，
 * 而這份清單沒跟上，tsc 就會失敗（Record 的鍵不完整）——不會靜默漏掉。
 */
const COMMAND_VARIANT_MAP: Record<Command['name'], true> = {
  updateClip: true,
  reorderClips: true,
  removeClip: true,
  addClip: true,
  setTimeline: true,
  updateOverlay: true,
  updateCaption: true,
  setOverlays: true,
  addOverlay: true,
  removeOverlay: true,
  setCaptions: true,
  splitAt: true,
  deleteBefore: true,
  deleteAfter: true,
  freezeFrame: true,
  extractAudio: true,
  updateAudio: true,
  removeAudio: true,
  setAudio: true,
  setCanvasFit: true,
  registerMedia: true,
  setCover: true,
  undo: true,
  redo: true,
};
const COMMAND_VARIANTS = Object.keys(COMMAND_VARIANT_MAP);
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `npx vitest run --root server test/mcp-docs-sync.test.ts`
Expected: 「每個 Command variant 都有對應的 MCP 工具」FAIL，列出沒有同名工具的 variant。

預期會出現的（**以實跑輸出為準，不要照抄**）：`setTimeline`→`set_timeline` 有；`splitAt`/`deleteBefore`/`deleteAfter`/`freezeFrame` 走 `timeline_op` 這個聚合工具，不是同名工具；`registerMedia` 由 `import_media` 內部呼叫。

- [ ] **Step 3: 逐一裁決**

對每個列出的 variant，讀 `mcp.ts` 確認它是不是透過**別的工具**觸達的：

- 是 → 列進 `MCP_EXEMPT_COMMANDS`，理由要寫**哪個工具**代它觸達，例如 `splitAt: '由 timeline_op 的 op:"split" 觸達'`。
- 否 → 這是真的漏了一個能力。**不要在本 Task 補工具**（那是行為變更，超出本計劃範圍）；列進 `MCP_EXEMPT_COMMANDS` 並在理由裡寫「尚未開放給 AI，見 docs/ROADMAP.md」，同時到 `docs/ROADMAP.md` 第 11 條加一條待辦。

- [ ] **Step 4: 跑測試確認它通過**

Run: `npx vitest run --root server test/mcp-docs-sync.test.ts`
Expected: 5 passed（Task 1 的 3 條 + 本 Task 的 2 條）

- [ ] **Step 5: 確認殺傷力**

暫時把 `mcp.ts` 裡 `add_clip` 的 `registerTool(...)` 整段註解掉，跑同一支測試。
Expected: 「每個 Command variant 都有對應的 MCP 工具」轉紅並指名 `addClip`。

**還原 `mcp.ts`**，`git diff` 確認乾淨，再跑一次確認回綠。

- [ ] **Step 6: 跑全套 + typecheck**

Run: `npx vitest run --root server` 然後 `npx tsc --noEmit -p server`
Expected: 皆通過。typecheck 特別重要——`COMMAND_VARIANT_MAP` 的 `Record<Command['name'], true>` 就是靠它擋住「variant 改名但清單沒跟上」。

- [ ] **Step 7: Commit**

```bash
git add server/test/mcp-docs-sync.test.ts docs/ROADMAP.md
git commit -m "test(mcp): Command variant 觸達性守衛（鐵則第三步的執行面）"
```

---

## Task 3: 文件引用完整性檢查器 + gauntlet 關卡

**Files:**

- Create: `scripts/docs-check.mjs`
- Modify: `scripts/gauntlet.sh`

**Interfaces:**

- Consumes: 無（純 Node 內建模組）
- Produces: `node scripts/docs-check.mjs` → exit 0/1；`gauntlet.sh` 新增一個 `step`

**背景：** 零誤報是硬要求（見 Global Constraints）。因此只檢查**斷言型文件**，且只檢查三類能百分之百判定的東西。

- [ ] **Step 1: 寫檢查器**

建立 `scripts/docs-check.mjs`：

```js
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
  for (const m of text.matchAll(/npm run ([a-zA-Z:_-]+)(?:\s+-w\s+(\S+))?/g)) {
    const [, name, ws] = m;
    const dir = ws ? (WORKSPACES[ws] ?? ws) : '.';
    if (!(name in scripts(dir))) {
      problems.push(
        `${doc}: \`npm run ${name}${ws ? ` -w ${ws}` : ''}\` —— ${dir}/package.json 裡沒有這個 script`,
      );
    }
  }

  // 2. 反引號裡的檔案路徑
  for (const m of text.matchAll(
    /`((?:server|ui|shared|scripts|docs|\.claude)\/[A-Za-z0-9_.\/-]+\.[a-z]{2,4})/g,
  )) {
    if (!existsSync(join(root, m[1]))) problems.push(`${doc}: 引用了不存在的檔案 \`${m[1]}\``);
  }

  // 3. 被忽略的路徑
  for (const pre of IGNORED_PREFIXES) {
    if (text.includes(`\`${pre}`)) {
      problems.push(`${doc}: 引用了被 .gitignore 的路徑（\`${pre}…\`）——別人 clone 之後必然失效`);
    }
  }
}

if (problems.length) {
  console.log(`文件引用檢查：${problems.length} 個問題`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log(`文件引用檢查：${DOCS.length} 份斷言型文件的引用都指向真實存在的東西`);
```

- [ ] **Step 2: 跑一次，看它報什麼**

Run: `node scripts/docs-check.mjs`

Expected: 可能 exit 1 並列出問題。**逐一人工判定每一條是真漏還是誤報**：

- **真漏** → 修那份文件（改成正確的路徑／指令，或刪掉那句話）。
- **誤報** → **改檢查器，不要改文件**。誤報是檢查器的缺陷；把文件改成遷就檢查器是本末倒置。修完重跑，直到 exit 0 且每一條變更都說得出理由。

- [ ] **Step 3: 負向對照（證明它擋得住）**

在 `CLAUDE.md` 末尾暫時加一行 ``參考 `server/src/nonexistent-file.ts`。``，跑：

Run: `node scripts/docs-check.mjs`
Expected: exit 1，訊息指名 `CLAUDE.md: 引用了不存在的檔案 \`server/src/nonexistent-file.ts\``

再把那行改成 ``參考 `.superpowers/sdd/whatever.md`。``，重跑。
Expected: exit 1，訊息指出引用了被 `.gitignore` 的路徑。

**刪掉那行**，重跑確認 exit 0，`git diff CLAUDE.md` 確認乾淨。

- [ ] **Step 4: 加進 gauntlet**

在 `scripts/gauntlet.sh` 的「突變錨點」關卡**之後**、「依賴稽核」**之前**插入（位置很重要：要在 `--fast` 也跑得到的區段，且排在慢關卡之前，壞了要早點知道）：

```bash
step "文件引用（斷言型文件不得指向不存在或被忽略的東西）"
node scripts/docs-check.mjs 2>&1 | sed 's/^/   /'
node scripts/docs-check.mjs >/dev/null 2>&1; check $?
```

- [ ] **Step 5: 確認 gauntlet 語法與快路徑**

Run: `bash -n scripts/gauntlet.sh` 然後 `bash scripts/gauntlet.sh --fast 2>&1 | tail -30`
Expected: 語法 OK；`--fast` 的輸出裡看得到「文件引用」關卡且 PASS。

- [ ] **Step 6: Commit**

```bash
git add scripts/docs-check.mjs scripts/gauntlet.sh CLAUDE.md HANDOFF.md README.md README.zh-TW.md .claude/rules/
git commit -m "feat(gauntlet): 文件引用完整性關卡（只管斷言型文件，零誤報）"
```

---

## Task 4: 稽核 `CLAUDE.md` 與 `.claude/rules/`

**Files:**

- Create: `docs/DOC-AUDIT-2026-08-07.md`
- Modify: `CLAUDE.md`、`.claude/rules/ui-verification.md`、`.claude/rules/wysiwyg.md`

**Interfaces:**

- Consumes: Task 3 的 `docs-check.mjs`（機檢已過的部分不必重看）
- Produces: `docs/DOC-AUDIT-2026-08-07.md` 的「CLAUDE.md 與 rules」章節；後續 Task 往同一份檔案追加

**背景：** 這三份是 agent 進來第一個讀的東西，錯一句的代價最高。合計約 285 行。機檢已經涵蓋「路徑存不存在、指令存不存在」，本 Task 要處理的是**機器驗不到的行為性陳述**。

- [ ] **Step 1: 建立稽核報告骨架**

建立 `docs/DOC-AUDIT-2026-08-07.md`：

```markdown
# 文件稽核 2026-08-07

對照的程式碼版本：`<填入 git rev-parse --short HEAD>`

方法：逐份讀常駐文件，把每一條可查證的陳述回去比對實際程式碼。**不重跑**耗時的實測
（`verify:wysiwyg`／`verify:canvas`／效能數字）——既有實測數字保留原樣但標明出處與
「未重驗」。機檢涵蓋的部分（檔案路徑、npm script、被忽略的路徑）由
`scripts/docs-check.mjs` 保證，不列在這裡。

## 判定用語

- **不符**：文件說的與程式碼不一致，已改。
- **過期**：曾經正確，程式碼變了，已改。
- **無法查證**：需要重跑實測才知道，已標註出處與「未重驗」，未改內容。
- **正確**：核對過、無需更動（不逐條列出，只列有動作的）。
```

- [ ] **Step 2: 逐條核對 `CLAUDE.md`**

把 `CLAUDE.md`（84 行）的每一條陳述回去比對程式碼。**重點抽查項**（不是全部，實作者要逐行看）：

- 「單一 Node 程序在 :3845 同時服務靜態 UI、`/media`、`/mcp`、`/ws`」→ 讀 `server/src/index.ts` 確認路由確實是這幾條、port 預設值確實是 3845
- 「Server 服務的是 `ui/dist`（build 產物），不是 Vite dev server」→ 讀 `server/src/index.ts` 的靜態檔案掛載
- 鐵則三步的每一步 → 對照 `shared/src/types.ts`、`server/src/commands.ts`、`server/src/mcp.ts` 實際結構
- 「`npm run lint` 目前 exit 0」之類的**狀態陳述**→ 實跑確認；若與現況不符就改。這類句子最容易過期。
- Git 段那條 worktree／`npm install` 陷阱 → 確認描述的解析行為與 `node_modules/@vidcut/*` 的 symlink 結構相符

每發現一條不符，**先寫進報告再改文件**（寫下「原文、根據哪段程式碼、改成什麼」），避免改完忘記記。

- [ ] **Step 3: 逐條核對 `.claude/rules/ui-verification.md`**

同樣做法。重點抽查：

- 各 `verify:*` 腳本的前提（要不要先起 server、要不要 `ui/dist` 最新、吃哪些環境變數）→ 對照 `ui/e2e/*.mjs` 實際程式碼
- `findChrome()` 的搜尋順序 → 讀實際實作
- 「`verify:canvas` 檢查 1 的誤差 0.000% 不等於預覽跟成品對齊」這類**限制聲明** → 對照該腳本實際量了什麼

- [ ] **Step 4: 逐條核對 `.claude/rules/wysiwyg.md`**

重點抽查：

- 「預覽即成品」的三類結論（字幕 ✅／overlay ✅／karaoke ⚠️）→ 對照 `ui/src/player/Player.tsx`、`server/src/render.ts` 的實際合成路徑
- 「原生 `drawtext` 分支已整條刪掉」→ 確認 `render.ts` 真的沒有那條路徑，且 `render.test.ts` 真的有一條測試釘死它不准回來
- 表格裡的實測像素數字 → **不重跑**，但確認有標明出處；沒標的補上「某次實測，未重驗」

- [ ] **Step 5: 跑機檢確認沒改壞**

Run: `node scripts/docs-check.mjs`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add docs/DOC-AUDIT-2026-08-07.md CLAUDE.md .claude/rules/
git commit -m "docs: 稽核 CLAUDE.md 與 .claude/rules/，修正與程式碼不符之處"
```

---

## Task 5: 稽核 `HANDOFF.md`

**Files:**

- Modify: `HANDOFF.md`、`docs/DOC-AUDIT-2026-08-07.md`

**Interfaces:**

- Consumes: Task 4 建立的 `docs/DOC-AUDIT-2026-08-07.md`
- Produces: 該報告的「HANDOFF.md」章節

**背景：** 327 行，是「各檔案職責與已完成/未驗證的分界」。這份文件的價值全在那條**分界**——標成「已完成」但其實沒做、或標成「未驗證」但早就驗過，都會直接誤導下一個人。

- [ ] **Step 1: 核對檔案職責表**

`HANDOFF.md` 列出的每個檔案 → 確認它存在（機檢已保證）且**職責描述與實際內容相符**。特別注意本分支剛新增的 `server/test/tmp.ts`、`server/test/global-setup.ts`、`server/test/setup.ts` 有沒有被列進去；沒有就補。

- [ ] **Step 2: 核對「已完成 / 未驗證」分界**

逐條檢查。判定方式：

- 標「已完成」→ 找到對應的測試或實作；找不到就降級並註明。
- 標「未驗證」→ 檢查是不是其實已經有測試守著了（本分支就把好幾項補上了）；有就升級並指出是哪條測試。

- [ ] **Step 3: 核對里程碑與版本敘述**

M1–M4、T1、T2 之類的階段敘述 → 對照 `docs/ROADMAP.md` 與實際程式碼。兩份文件對同一件事的說法不一致時，**以程式碼為準**，並把兩邊都改對。

- [ ] **Step 4: 跑機檢**

Run: `node scripts/docs-check.mjs`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add HANDOFF.md docs/DOC-AUDIT-2026-08-07.md
git commit -m "docs: 稽核 HANDOFF.md，校正檔案職責與已完成/未驗證分界"
```

---

## Task 6: 稽核 31 個 MCP 工具描述

**Files:**

- Modify: `server/src/mcp.ts`（僅描述文字與 instructions）、`docs/DOC-AUDIT-2026-08-07.md`

**Interfaces:**

- Consumes: Task 1／Task 2 的守衛（結構面已保證，本 Task 只看**文字內容**）
- Produces: 報告的「MCP 工具描述」章節

**背景：** CLAUDE.md 鐵則：「MCP 描述是 AI 使用者唯一的文件，過期描述會直接害它踩坑」。前例是 `get_frame` 的描述殘留「M4 加 overlay 合成」的 roadmap 字句，功能從未做，AI 因此誤判 overlay 沒設定成功。Task 1／2 保證了「工具有沒有被寫進 instructions」「Command 有沒有工具可觸達」，但**描述文字本身說了什麼**只能人讀。

- [ ] **Step 1: 逐一比對描述與實作**

對 `mcp.ts` 的 31 個 `registerTool`，每一個做三件事：

1. 讀它的 `description` 與參數 schema 說明
2. 讀它的 handler 實作
3. 找出**描述承諾了但實作沒做**、或**實作做了但描述沒說**的地方

特別找這幾類（都是本 repo 踩過的）：

- 殘留的 roadmap 字句（「M4 會加…」「之後支援…」）——功能沒做卻寫在描述裡
- `annotations.readOnlyHint` 與實際行為不符（標唯讀卻會寫入，或反之）
- 參數描述沒說明邊界（例如某參數其實有上限、或某參數其實無效）
- 錯誤訊息的形狀與描述不符

- [ ] **Step 2: 核對 instructions 的流程敘事**

`mcp.ts` 的 instructions（約 1694 字元）描述了一條典型剪片流程。逐段確認：每個提到的步驟順序在實作上真的可行、提到的工具名都存在（Task 1 的第三條測試已守）、描述的限制（例如純音訊素材的軌道限制）與 `commands.ts` 的實際驗證一致。

- [ ] **Step 3: 改掉不符之處，逐條寫進報告**

只改文字，**不改任何行為**。若發現描述與實作不符且**實作才是錯的**，不要在本 Task 改實作——寫進報告並到 `docs/ROADMAP.md` 第 11 條加一條待辦。

- [ ] **Step 4: 跑 MCP 相關測試**

Run: `npx vitest run --root server test/mcp-docs-sync.test.ts test/mcp-tools.test.ts test/mcp.test.ts test/mcp-optim.test.ts`
Expected: 全過。改描述文字**不該**讓任何測試轉紅；若轉紅，代表有測試在斷言描述字串，讀懂它為什麼在意再決定改哪邊。

- [ ] **Step 5: 突變錨點檢查**

Run: `node scripts/mutate.mjs --check`
Expected: 全數命中。`mcp.ts` 有 mutant 錨在上面，改動那個檔案要確認 `find` 字串沒被打斷。

- [ ] **Step 6: Commit**

```bash
git add server/src/mcp.ts docs/DOC-AUDIT-2026-08-07.md docs/ROADMAP.md
git commit -m "docs(mcp): 稽核 31 個工具描述與 instructions，校正與實作不符之處"
```

---

## Task 7: 稽核 `README.md` 與 `README.zh-TW.md`

**Files:**

- Modify: `README.md`、`README.zh-TW.md`、`docs/DOC-AUDIT-2026-08-07.md`

**Interfaces:**

- Consumes: 前面各 Task 的稽核結論
- Produces: 報告的「README」章節

**背景：** 各 170 行，是對外的門面（GitHub 上第一眼看到的東西）。兩份必須**內容等價**——只是語言不同。

- [ ] **Step 1: 核對安裝與啟動步驟**

照著 README 寫的步驟，在一個乾淨的暫存目錄實際走一遍（clone 不必，用現有 repo 即可，但要照它寫的指令順序跑）。任何一步卡住或需要 README 沒提到的前置條件（python3、Pillow、ffmpeg、whisper.cpp…），補進去。

- [ ] **Step 2: 核對功能清單**

README 宣稱的每項功能 → 確認實作存在。特別注意宣稱「支援 X」但 X 其實只做了一半的情形。

- [ ] **Step 3: 核對中英兩份的等價性**

逐段比對 `README.md` 與 `README.zh-TW.md`。任何一邊有、另一邊沒有的段落都要補齊。若兩邊對同一件事說法不同，以程式碼為準改對兩邊。

- [ ] **Step 4: 跑機檢**

Run: `node scripts/docs-check.mjs`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add README.md README.zh-TW.md docs/DOC-AUDIT-2026-08-07.md
git commit -m "docs: 稽核中英 README，校正步驟、功能清單與兩份的等價性"
```

---

## Task 8: `docs/ROADMAP.md` 清理、前瞻型文件定位、收尾

**Files:**

- Modify: `docs/ROADMAP.md`、`docs/DOC-AUDIT-2026-08-07.md`
- Modify: `docs/superpowers/specs/`、`docs/superpowers/plans/` 底下各檔（僅加一行標頭）

**Interfaces:**

- Consumes: Task 4–7 的稽核結論（其中「發現但不在本計劃範圍內修」的項目要落到 ROADMAP）
- Produces: 完成的 `docs/DOC-AUDIT-2026-08-07.md`

**背景：** ROADMAP 304 行。specs 14 份、plans 11 份——這些是**某個時間點的設計定案**，不是現況描述。它們不該被「更新到最新」（那會抹掉當時的決策脈絡），但**必須讓讀者一眼看出它是歷史文件**，否則會被當成現況。

- [ ] **Step 1: 清掉 ROADMAP 已完成的項目**

逐條檢查「可行方向」與第 11 條的每一項，確認哪些已經做了（本分支就完成了好幾項）。做法照既有慣例：不要直接刪，用 `~~刪除線~~` + 「**已修**」並簡述怎麼修的、由哪個 mutant／測試守著——這樣讀者知道它曾經是問題。

- [ ] **Step 2: 在 ROADMAP 開頭標明它是前瞻型文件**

在檔案開頭的說明段加一句，明確它與斷言型文件的分工：

```markdown
> **這是前瞻型文件**：描述「可能要做的事」，引用的檔案路徑可能還不存在。
> 描述「現況」的是 `CLAUDE.md`、`.claude/rules/`、`HANDOFF.md` 與 `README.md`——
> 那幾份的引用由 `scripts/docs-check.mjs` 保證指向真實存在的東西，本檔不納入該檢查。
```

- [ ] **Step 3: 給 specs 與 plans 加歷史文件標頭**

在 `docs/superpowers/specs/*.md` 與 `docs/superpowers/plans/*.md` 每一份的標題**下一行**插入（`<日期>` 用該檔的 git 首次提交日期，`git log --diff-filter=A --format=%ad --date=short -- <file> | tail -1`）：

```markdown
> **歷史文件（<日期> 的設計定案）**：記錄當時的決策與理由，**不隨程式碼更新**。
> 現況以 `CLAUDE.md`／`HANDOFF.md` 為準。
```

**不要修改這些檔案的其他任何內容**——它們的價值就在於保存當時的判斷。

- [ ] **Step 3b: 給 `EVIDENCE.md` 同樣的定位標頭**

`EVIDENCE.md`（約 1424 行）也是歷史文件，但性質與 specs 不同，標頭要分開寫：它記錄的是**某幾次驗證執行的結果**，裡面的每個數字都綁定當時的 commit SHA。它**不該**被「更新到最新」——那會讓那些數字失去可查證性（讀者無法重跑當時的狀態）。在標題下一行插入：

```markdown
> **這是驗證記錄，不是現況描述**：每個數字都綁定當時的 commit SHA，**不隨程式碼更新**。
> 要知道現在的狀態，跑 `bash scripts/gauntlet.sh`。現況描述以 `CLAUDE.md`／`HANDOFF.md` 為準。
```

同時確認它**沒有**被列進 `scripts/docs-check.mjs` 的 `DOCS`（它會引用歷史狀態下存在、現在可能已改名的檔案，納入機檢必然誤報）。若 Task 3 誤把它列進去了，在這裡移除並在稽核報告記一筆。

- [ ] **Step 4: 補完稽核報告**

在 `docs/DOC-AUDIT-2026-08-07.md` 加一節「本次稽核發現但不在範圍內修的」，把 Task 4–7 過程中發現、屬於**行為缺陷**（而非文件錯誤）的項目列出，並確認每一項都已經在 `docs/ROADMAP.md` 有對應條目。

再加一節「本次建立的三道關卡」，說明各自守什麼、失效時會看到什麼訊息——讓下一個人知道紅了該怎麼讀。

- [ ] **Step 5: 跑完整 gauntlet**

Run: `bash scripts/gauntlet.sh`
Expected: `GAUNTLET: 全數通過`，且輸出裡看得到新的「文件引用」關卡。

**若任何關卡失敗**，不得放寬關卡或跳過——修到綠為止，並把過程如實寫進稽核報告。

- [ ] **Step 6: Commit**

```bash
git add docs/
git commit -m "docs: ROADMAP 清理、specs/plans 標為歷史文件、完成稽核報告"
```

---

## 執行前的注意事項

- **開新 worktree 之後第一件事是 `npm install`。** 沒裝之前跑出來的測試與型別檢查結果一律不算數，而且**不會報錯**——Node 會往上解析到主 repo 的 `node_modules/@vidcut/shared`，那是主 repo 當前檢出分支的 shared。自檢：`ls -l <worktree>/node_modules/@vidcut/shared` 必須指向該 worktree 內的 `shared`。
- **`main` 在這個工作區會頻繁前進**（本分支上一輪落後過 57 個 commit）。Task 之間如果隔了較久，先 `git merge main` 再繼續，不要等到最後一次合併才處理。
- **Task 4–7 是人工稽核，沒有「跑測試變綠」的收斂訊號。** 收斂條件是：那份文件的每一條可查證陳述都已回去比對過程式碼，且每一處變更都寫進了 `docs/DOC-AUDIT-2026-08-07.md`。報告寫不出「根據哪段程式碼」的變更，就是還沒查證完。
