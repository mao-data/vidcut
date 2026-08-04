# 素材匯入的 MCP 面補完 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓階段 1 做出來的後端能力（素材夾掃描、零複製匯入、接片到主軌尾端）真的有使用者——補上 MCP 工具面，並收掉盤點時發現的文件與維護債。

**Architecture:** 兩個新 MCP 工具都是既有已驗證能力的薄殼：`list_source` 包 `scanSourceFolder`、`add_clip` 走 `aiWrite` → `applyCommand`（不複製 `set_timeline` 直接 `store.mutate` 的既有例外）。`imported` 判定從 `app.ts` 抽成共用函式讓 HTTP 與 MCP 共享。另補 `setAudio` 的逐項驗證（本案唯一行為變更）。

**Tech Stack:** Node + TypeScript、`@modelcontextprotocol/sdk`、`zod`、`vitest`（真 ffmpeg，不 mock）、`@vidcut/shared` 型別。

設計定案：[`docs/superpowers/specs/2026-08-03-mcp-surface-completion-design.md`](../specs/2026-08-03-mcp-surface-completion-design.md)

## Global Constraints

- **Tier 2（old-coder）。** 每個 Task 都是 RED → 驗證紅 → GREEN → 驗證綠 → commit。
- **零新依賴、零新工具。** 只用既有 `@modelcontextprotocol/sdk`、`zod`、`vitest`。
- **不得 `git add -A`**（`CLAUDE.md` 鐵則：工作區常有多個 session）。只 stage 該 Task 動過的路徑。
- **不得放寬任何 gauntlet 關卡**，不得修改 `scripts/gauntlet.sh`。
- **不得修改既有測試的斷言。** 既有 412 條測試必須零新增失敗。
- **不得動** `server/src/sourceFolder.ts` 的 `MEDIA_EXTENSIONS` 白名單、`server/src/commands.ts:155` 與 `:497` 的 `1e-6` 容差。
- **不得為配合文件而加無意義的程式碼**；反之，程式碼裡沒有的檢查不得寫進文件。
- **prettier 設定**：`singleQuote`、`semi`、`printWidth: 100`、`trailingComma: "all"`、`arrowParens: "always"`。每個 Task 收尾前跑 `npx prettier --write <動過的檔案>`。
- **工作目錄**：`ai-video-cut/.claude/worktrees/media-import-backend`（git worktree，分支 `worktree-media-import-backend`）。所有指令在此執行，不要 `cd` 回原 repo。
- **起點 commit**：`013a0fc`。

## Baseline（開工前實測，`bash scripts/gauntlet.sh`，source `d30aace`）

- 全測試套件 **412 passed**（shared 27／server 215／ui 170），0 failed
- 突變 **67 killed + 1 equivalent control**（`store-corrupt-load`）＝ `scripts/mutants.json` 全部 68 隻
- typecheck ×3、eslint、prettier、隨機順序、秘密掃描皆 PASS
- `GAUNTLET: 全數通過`

## File Structure

| 檔案                                                           | 動作 | 職責                                                                                        |
| -------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------- |
| `server/src/sourceFolder.ts`                                   | 修改 | 既有 `scanSourceFolder` 不動；新增 `listSource()`——掃描 + 標記 `imported`，HTTP 與 MCP 共用 |
| `server/src/app.ts`                                            | 修改 | `GET /api/source` 改用 `listSource()`（行為不變的重構）                                     |
| `server/src/commands.ts`                                       | 修改 | `case 'setAudio'` 補逐項驗證                                                                |
| `server/src/render.ts`                                         | 修改 | 音訊素材找不到時的錯誤訊息補上 `mediaId`                                                    |
| `server/src/mcp.ts`                                            | 修改 | 新增 `list_source` 與 `add_clip` 兩個工具；`instructions` 同步                              |
| `server/test/sourceFolder.test.ts`                             | 修改 | `listSource` 的測試                                                                         |
| `server/test/commands.test.ts`                                 | 修改 | `setAudio` 驗證的測試                                                                       |
| `server/test/render.test.ts`                                   | 修改 | 錯誤訊息含 `mediaId` 的測試                                                                 |
| `server/test/mcp-tools.test.ts`                                | 修改 | `list_source`、`add_clip` 的測試 + instructions 同步的守衛測試                              |
| `scripts/mutants.json`                                         | 修改 | 新增 3 隻 mutant                                                                            |
| `CLAUDE.md` / `HANDOFF.md` / `docs/ROADMAP.md` / `EVIDENCE.md` | 修改 | 鐵則修正、去數字化、債歸檔、證據補記                                                        |

**Task 相依順序**：Task 1 → Task 4（`list_source` 用 `listSource()`）。Task 2、3 彼此與其他 Task 獨立。Task 6 需要 Task 4、5 完成（要描述已存在的工具）。Task 8 最後。

---

### Task 1: `listSource()` 共用輔助（純重構，行為不變）

`imported` 判定目前寫死在 `app.ts` 的 route 裡，MCP 要用就得複製一份。先抽出來，兩邊共用一個測得到的函式。

**Files:**

- Modify: `server/src/sourceFolder.ts`
- Modify: `server/src/app.ts:28-46`
- Test: `server/test/sourceFolder.test.ts`

**Interfaces:**

- Consumes: 既有 `scanSourceFolder(dir): Promise<SourceFile[]>`、`resolveMediaPath(projectDir, path): string`
- Produces: `listSource(dir: string, media: readonly MediaAsset[], projectDir: string): Promise<{ dir: string; files: Array<SourceFile & { imported: boolean }> }>` —— Task 4 會用

- [ ] **Step 1: 寫失敗的測試**

加到 `server/test/sourceFolder.test.ts` 檔案最後（`import` 區塊補 `listSource`、`MediaAsset` 型別）：

```typescript
describe('listSource', () => {
  it('標記素材夾內哪些檔案已匯入本專案（絕對路徑素材）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-ls-'));
    await writeFile(join(dir, 'a.mp4'), 'x');
    await writeFile(join(dir, 'b.mp4'), 'x');
    const media: MediaAsset[] = [
      {
        id: 'm1',
        path: join(dir, 'a.mp4'),
        probe: { duration: 1, width: 10, height: 10, fps: 30, hasAudio: false, rotation: 0 },
      },
    ];
    const r = await listSource(dir, media, '/proj');
    expect(r.dir).toBe(dir);
    expect(r.files.map((f) => [f.name, f.imported])).toEqual([
      ['a.mp4', true],
      ['b.mp4', false],
    ]);
  });

  it('專案內的相對路徑素材也比對得出來（解析後才比）', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'vidcut-ls-proj-'));
    await writeFile(join(projectDir, 'c.mp4'), 'x');
    const media: MediaAsset[] = [
      {
        id: 'm1',
        path: 'c.mp4', // 相對路徑＝專案內
        probe: { duration: 1, width: 10, height: 10, fps: 30, hasAudio: false, rotation: 0 },
      },
    ];
    const r = await listSource(projectDir, media, projectDir);
    expect(r.files.find((f) => f.name === 'c.mp4')!.imported).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認它失敗**

```bash
npx vitest run --root server test/sourceFolder.test.ts -t listSource
```

預期：FAIL，`ReferenceError: listSource is not defined`（或 import 解析失敗）。

> 若失敗訊息是 import 錯誤而非 `listSource is not defined`，那是更弱的 RED——先在 `sourceFolder.ts` 加一個 `export async function listSource(): never { throw new Error('not implemented'); }` 樁，重跑，讓它紅在行為上。

- [ ] **Step 3: 寫最小實作**

在 `server/src/sourceFolder.ts` 的 `import` 區塊補：

```typescript
import type { MediaAsset } from '@vidcut/shared';
import { resolveMediaPath } from './paths.js';
```

檔案最後加：

```typescript
export interface SourceListing {
  dir: string;
  files: Array<SourceFile & { imported: boolean }>;
}

/**
 * 掃素材夾並標記哪些檔案已匯入本專案。HTTP（GET /api/source）與 MCP（list_source）
 * 共用同一個實作，兩邊回應形狀因此保證一致。
 *
 * `imported` 比對的是**解析後的絕對路徑**：doc.media 裡相對路徑代表專案內、
 * 絕對路徑代表零複製外部引用，直接比字串會漏判。
 */
export async function listSource(
  dir: string,
  media: readonly MediaAsset[],
  projectDir: string,
): Promise<SourceListing> {
  const files = await scanSourceFolder(dir);
  const imported = new Set(media.map((m) => resolveMediaPath(projectDir, m.path)));
  return { dir, files: files.map((f) => ({ ...f, imported: imported.has(join(dir, f.name)) })) };
}
```

- [ ] **Step 4: 跑測試確認它通過**

```bash
npx vitest run --root server test/sourceFolder.test.ts
```

預期：PASS，該檔案測試數從 12 增為 14。

- [ ] **Step 5: 把 `app.ts` 改成用它（重構，斷言不動）**

`server/src/app.ts` 的 `GET /api/source` handler，把這段：

```typescript
const files = await scanSourceFolder(dir);
const imported = new Set(store.doc.media.map((m) => resolveMediaPath(projectDir, m.path)));
res.json({
  dir,
  files: files.map((f) => ({ ...f, imported: imported.has(join(dir, f.name)) })),
});
```

換成：

```typescript
res.json(await listSource(dir, store.doc.media, projectDir));
```

import 要同步改三處（已逐行核對過 `app.ts` 的實際使用情況）：

- 第 6 行 `import { scanSourceFolder } from './sourceFolder.js';` → 改成
  `import { listSource } from './sourceFolder.js';`
  （`scanSourceFolder` 在 `app.ts` 只有第 36 行那一處用到，重構後就沒人用了）
- 第 7 行 `import { resolveMediaPath } from './paths.js';` → **整行刪除**
  （只有第 37 行那一處用到）
- 第 4 行的 `join` **保留**——`/api/import` 與 `/assets` 還有 5 處在用
  （第 65、99、102、103、104、106 行）

`npm run lint` 會抓到未使用的 import，改完務必跑。

- [ ] **Step 6: 跑既有 API 測試確認重構沒改行為**

```bash
npx vitest run --root server test/source-api.test.ts
npm run lint
npx tsc --noEmit -p server
```

預期：`source-api.test.ts` 5 條全過（**斷言一個字都沒改**），lint 與 typecheck 乾淨。

- [ ] **Step 7: Commit**

```bash
npx prettier --write server/src/sourceFolder.ts server/src/app.ts server/test/sourceFolder.test.ts
git add server/src/sourceFolder.ts server/src/app.ts server/test/sourceFolder.test.ts
git commit -m "refactor(server): 抽出 listSource，HTTP 與 MCP 共用 imported 判定"
```

---

### Task 2: `setAudio` 逐項驗證（本案唯一行為變更）

實測過的問題：`set_audio` 給不存在的 `mediaId` 會被接受 → 落盤 → 重啟後 `undo` 回「nothing to undo」 → 直到 render 才丟錯。補成與 `addClip` 對稱。

**Files:**

- Modify: `server/src/commands.ts:109-114`
- Test: `server/test/commands.test.ts`
- Modify: `scripts/mutants.json`

**Interfaces:**

- Consumes: 既有 `applyCommand(store, source, cmd)`、`storeWithClips()` 測試輔助（提供 `m1`/`m2` 兩個素材，`probe.duration` 皆為 20）
- Produces: 無（純行為收緊）

- [ ] **Step 1: 寫失敗的測試**

加到 `server/test/commands.test.ts` 檔案最後。檔頭 import 區塊補一行 `import type { AudioItem } from '@vidcut/shared';`：

```typescript
// setAudio 原本零驗證（d.tracks.audio = cmd.audio），與 addClip 的五道守衛不對稱。
// 實測後果：AI 抄錯一個 8 字元 mediaId → 被接受 → 落盤 → 重啟後 undo 堆疊已失效
// （「nothing to undo」）→ 直到 render 才丟 "media not found for audio"。
describe('setAudio 驗證', () => {
  // 型別化的 helper：patch 用 Partial<AudioItem> 而非 Record<string, unknown>，
  // 這樣每個測試都不需要 as never 轉型——'NOPE' 是合法的 string，型別上過得去，
  // 執行期才該被新驗證擋下，正好是我們要測的東西。
  const item = (patch: Partial<AudioItem> = {}): AudioItem => ({
    id: 'a1',
    mediaId: 'm1',
    start: 0,
    in: 0,
    duration: 5,
    volume: 1,
    ...patch,
  });

  it('mediaId 不存在 → 拒絕，且音訊軌維持原樣（不得半套寫入）', async () => {
    const store = await storeWithClips();
    store.mutate('ai', 'seed audio', (d) => {
      d.tracks.audio = [item()];
    });
    const before = structuredClone(store.doc.tracks.audio);
    const r = applyCommand(store, 'human', {
      name: 'setAudio',
      audio: [item({ id: 'a2', mediaId: 'NOPE' })],
    });
    expect(r.ok).toBe(false);
    expect(store.doc.tracks.audio).toEqual(before);
  });

  it('duration <= 0 → 拒絕', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'setAudio',
      audio: [item({ duration: 0 })],
    });
    expect(r.ok).toBe(false);
  });

  it('負的 in → 拒絕', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'setAudio',
      audio: [item({ in: -1, duration: 1 })],
    });
    expect(r.ok).toBe(false);
  });

  it('in + duration 超過素材長度 → 拒絕', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'setAudio',
      audio: [item({ in: 18, duration: 5 })],
    });
    expect(r.ok).toBe(false);
  });

  it('剛好用滿素材長度是允許的（1e-6 容差，與 addClip 一致）', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'setAudio',
      audio: [item({ in: 0, duration: 20 })],
    });
    expect(r.ok).toBe(true);
  });

  it('多個 item 其中一個壞 → 整批拒，音訊軌維持原樣', async () => {
    const store = await storeWithClips();
    const before = structuredClone(store.doc.tracks.audio);
    const r = applyCommand(store, 'human', {
      name: 'setAudio',
      audio: [item(), item({ id: 'a2', mediaId: 'NOPE' })],
    });
    expect(r.ok).toBe(false);
    expect(store.doc.tracks.audio).toEqual(before);
  });

  // 迴歸護甲：audio: [] 是清空音訊軌的慣用法（mcp-tools.test.ts:174 正在用）。
  // 新驗證若寫成「必須非空」就會打破它——這是本 Task 最容易做錯的地方。
  it('audio: [] 清空音訊軌（既有行為，不得因新驗證而破壞）', async () => {
    const store = await storeWithClips();
    store.mutate('ai', 'seed audio', (d) => {
      d.tracks.audio = [item()];
    });
    const r = applyCommand(store, 'human', { name: 'setAudio', audio: [] });
    expect(r.ok).toBe(true);
    expect(store.doc.tracks.audio).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑測試確認它們紅在對的地方**

```bash
npx vitest run --root server test/commands.test.ts -t 'setAudio 驗證'
```

預期：**6 紅 1 綠**。

- 紅的 6 條全部是 `AssertionError: expected true to be false`（或音訊軌比對不符），**不是** crash、不是 import 錯誤。
- 綠的 1 條是「`audio: []` 清空音訊軌」——它測的是既有行為，現在就會過。

> 「`audio: []`」那條立刻通過**不代表它沒價值**，但也不能就這樣算數。Step 4 之後會用一次性 mutant 證明它真的有殺傷力。

- [ ] **Step 3: 寫最小實作**

`server/src/commands.ts`，把：

```typescript
    case 'setAudio':
      return ok(
        store.mutate(source, 'set audio', (d) => {
          d.tracks.audio = cmd.audio as AudioItem[];
        }),
      );
```

換成（注意：`case` 內有 `for` 的語彙宣告，必須加大括號，否則 ESLint `no-case-declarations` 會報）：

```typescript
    case 'setAudio': {
      // 與 addClip 對稱的逐項驗證。空陣列＝清空音訊軌，是合法且被既有測試依賴的用法，
      // 所以驗證放在迴圈裡（空陣列自然不進迴圈），不要在外面加「必須非空」。
      for (const a of cmd.audio) {
        const media = store.doc.media.find((m) => m.id === a.mediaId);
        if (!media) return { ok: false, error: `audio ${a.id}: media not found: ${a.mediaId}` };
        if (a.duration <= 0) return { ok: false, error: `audio ${a.id}: duration must be > 0` };
        if (a.in < 0) return { ok: false, error: `audio ${a.id}: in must be >= 0` };
        if (a.in + a.duration > media.probe.duration + 1e-6) {
          return { ok: false, error: `audio ${a.id}: out of bounds for ${a.mediaId}` };
        }
      }
      return ok(
        store.mutate(source, 'set audio', (d) => {
          d.tracks.audio = cmd.audio as AudioItem[];
        }),
      );
    }
```

- [ ] **Step 4: 跑測試確認全綠**

```bash
npx vitest run --root server test/commands.test.ts
npx vitest run --root server
```

預期：`commands.test.ts` 全過（22 → 29 條）；server 全套 215 → 221 條，0 failed。

- [ ] **Step 5: 用一次性 mutant 證明「`audio: []`」那條測試有殺傷力**

暫時在 `for` 迴圈**前面**插入一行：

```typescript
if (cmd.audio.length === 0) return { ok: false, error: 'audio must not be empty' };
```

跑：

```bash
npx vitest run --root server test/commands.test.ts -t 'audio: \[\] 清空音訊軌'
```

預期：**FAIL**（`expected false to be true`）。同時 `npx vitest run --root server test/mcp-tools.test.ts -t set_audio` 也應該紅。

確認後**刪掉那一行**，重跑 `npx vitest run --root server test/commands.test.ts` 確認回到全綠。

> 這一步是必要的：一個立刻通過的測試若沒被驗證過殺傷力，它可能什麼都沒測。

- [ ] **Step 6: 加 mutant 並實跑**

`scripts/mutants.json` 陣列最後加一筆（`find` 的換行用 `\n`，縮排是 6 空格）：

```json
{
  "id": "setaudio-validate",
  "file": "server/src/commands.ts",
  "find": "      for (const a of cmd.audio) {\n        const media = store.doc.media.find((m) => m.id === a.mediaId);\n        if (!media) return { ok: false, error: `audio ${a.id}: media not found: ${a.mediaId}` };\n        if (a.duration <= 0) return { ok: false, error: `audio ${a.id}: duration must be > 0` };\n        if (a.in < 0) return { ok: false, error: `audio ${a.id}: in must be >= 0` };\n        if (a.in + a.duration > media.probe.duration + 1e-6) {\n          return { ok: false, error: `audio ${a.id}: out of bounds for ${a.mediaId}` };\n        }\n      }\n",
  "replace": "",
  "tests": "server/test/commands.test.ts",
  "note": "拿掉 setAudio 的逐項驗證 → 不存在的 mediaId／負 in／超界全部會被默默接受並落盤，直到 render 才炸；拒絕的斷言必須抓到"
}
```

> **`find` 必須與檔案裡的文字逐字相符。** 跑 prettier 之後用這個指令確認它恰好出現一次，不是一次就修 `find`：
>
> ```bash
> node -e "const fs=require('fs'),m=require('./scripts/mutants.json').find(x=>x.id==='setaudio-validate');console.log(fs.readFileSync(m.file,'utf8').split(m.find).length-1)"
> ```
>
> 必須印出 `1`。

實跑：

```bash
node scripts/mutate.mjs setaudio-validate
```

預期：`✔ setaudio-validate`、`1/1 mutants killed`。

- [ ] **Step 7: Commit**

```bash
npx prettier --write server/src/commands.ts server/test/commands.test.ts scripts/mutants.json
git add server/src/commands.ts server/test/commands.test.ts scripts/mutants.json
git commit -m "fix(commands): setAudio 補逐項驗證，與 addClip 對稱"
```

---

### Task 3: render 找不到音訊素材時，錯誤訊息補上 `mediaId`

現在丟的是 `render: media not found for audio bgm1`——`bgm1` 是 audio item 的 id，不是那個找不到的素材編號。拿到錯誤的人還要自己翻 `project.json`。

**Files:**

- Modify: `server/src/render.ts:223`
- Test: `server/test/render.test.ts`

**Interfaces:**

- Consumes: 既有 `buildRenderArgs(project, projectDir, outPath, opts)`、`demoLikeProject()` 測試輔助
- Produces: 無

- [ ] **Step 1: 寫失敗的測試**

加到 `server/test/render.test.ts` 的 `describe('buildRenderArgs', ...)` 區塊內（與其他純函式斷言放一起）：

```typescript
// 錯誤訊息品質：只報 audio item 的 id 會讓人得自己翻 project.json 才知道
// 是哪個素材編號錯了。兩個 id 都要出現。
it('音訊素材找不到時，錯誤訊息同時含 audio item id 與 mediaId', () => {
  const p = demoLikeProject();
  p.tracks.audio = [{ id: 'bgm1', mediaId: 'GHOST_ID', start: 0, in: 0, duration: 1, volume: 1 }];
  expect(() => buildRenderArgs(p, '/proj', '/proj/out.mp4', { hasDrawtext: false })).toThrow(
    /bgm1.*GHOST_ID|GHOST_ID.*bgm1/,
  );
});
```

- [ ] **Step 2: 跑測試確認它失敗**

```bash
npx vitest run --root server test/render.test.ts -t '錯誤訊息同時含'
```

預期：FAIL。訊息會顯示實際丟出的是 `render: media not found for audio bgm1`，不符合要求兩個 id 都在的正則。

- [ ] **Step 3: 寫最小實作**

`server/src/render.ts` 第 223 行，把：

```typescript
if (!media) throw new Error(`render: media not found for audio ${a.id}`);
```

換成：

```typescript
if (!media) throw new Error(`render: media not found for audio ${a.id} (mediaId=${a.mediaId})`);
```

- [ ] **Step 4: 跑測試確認通過**

```bash
npx vitest run --root server test/render.test.ts
```

預期：PASS，`render.test.ts` 從 10 條變 11 條。

> 不加 mutant：這是錯誤訊息的字串內容，新測試本身就是它唯一的守護，再打一隻 mutant 只是重述同一條斷言。

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/src/render.ts server/test/render.test.ts
git add server/src/render.ts server/test/render.test.ts
git commit -m "fix(render): 音訊素材缺失的錯誤訊息補上 mediaId"
```

---

### Task 4: `list_source` MCP 工具

**Files:**

- Modify: `server/src/mcp.ts`
- Test: `server/test/mcp-tools.test.ts`
- Modify: `scripts/mutants.json`

**Interfaces:**

- Consumes: Task 1 的 `listSource(dir, media, projectDir)`；既有 `result(structured, summary)`、`err(s)` 回覆輔助
- Produces: MCP 工具 `list_source`，`structuredContent` 形狀為 `{ dir, files: Array<{name, size, mtime, imported}>, total, truncated? }`

- [ ] **Step 1: 寫失敗的測試**

加到 `server/test/mcp-tools.test.ts` 檔案最後。該檔已 import `mkdtemp`／`rm`／`tmpdir`／`join`，只需在 `node:fs/promises` 那行補 `writeFile`：

```typescript
describe('list_source', () => {
  it('列出素材夾內的白名單檔案並標記已匯入者', async () => {
    const src = await mkdtemp(join(tmpdir(), 'vidcut-mcpsrc-'));
    await writeFile(join(src, 'b.mp4'), 'x');
    await writeFile(join(src, 'a.mov'), 'x');
    await writeFile(join(src, 'notes.txt'), 'x'); // 非白名單，不該出現

    const r = await call('list_source', { dir: src });
    const sc = r.structuredContent as {
      files: Array<{ name: string; imported: boolean; size: number; mtime: number }>;
      total: number;
    };
    expect(sc.files.map((f) => f.name)).toEqual(['a.mov', 'b.mp4']); // 依 name 排序
    expect(sc.total).toBe(2);
    expect(sc.files.every((f) => f.imported === false)).toBe(true);
    expect(sc.files[0]!.size).toBeGreaterThan(0);
    expect(typeof sc.files[0]!.mtime).toBe('number');
  });

  it('已匯入的素材標 imported: true', async () => {
    // beforeAll 匯入的是專案內的 a.mp4（相對路徑），素材夾就指專案資料夾本身
    const r = await call('list_source', { dir });
    const sc = r.structuredContent as { files: Array<{ name: string; imported: boolean }> };
    expect(sc.files.find((f) => f.name === 'a.mp4')!.imported).toBe(true);
  });

  it('目錄不存在 → isError', async () => {
    const r = await call('list_source', { dir: join(tmpdir(), 'vidcut-does-not-exist-12345') });
    expect(r.isError).toBe(true);
  });

  // AI 的 context 有限，一個放了幾千支檔的素材夾不能整包塞回去。
  it('超過 200 筆只內嵌前 200 筆並標 truncated', async () => {
    const big = await mkdtemp(join(tmpdir(), 'vidcut-mcpbig-'));
    for (let i = 0; i < 250; i++) {
      await writeFile(join(big, `f${String(i).padStart(3, '0')}.mp4`), 'x');
    }
    const r = await call('list_source', { dir: big });
    const sc = r.structuredContent as {
      files: unknown[];
      total: number;
      truncated?: boolean;
    };
    expect(sc.total).toBe(250);
    expect(sc.files).toHaveLength(200);
    expect(sc.truncated).toBe(true);
  }, 60_000);

  it('標 readOnlyHint: true（唯讀工具）', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'list_source');
    expect(t?.annotations?.readOnlyHint).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
npx vitest run --root server test/mcp-tools.test.ts -t list_source
```

預期：5 條全紅。前 4 條的失敗原因是工具不存在（MCP SDK 回 `isError` 或丟 `Tool list_source not found`），第 5 條是 `expect(undefined).toBe(true)`。

> 「目錄不存在 → isError」那條在工具不存在時**也會通過**——這是假綠。Step 4 之後必須確認它是因為 `scanSourceFolder` 丟錯而綠，不是因為工具不存在。做法：暫時把 `dir` 改成存在的目錄，確認該條會轉綠再改回。

- [ ] **Step 3: 寫最小實作**

`server/src/mcp.ts`：

（a）`import` 區塊補：

```typescript
import { listSource } from './sourceFolder.js';
```

（b）在 `const MAX_WORDS_INLINE = 1000;` 那一行下面加：

```typescript
/** list_source 內嵌回傳的檔案數上限：素材夾可能有上千支檔，整包回去會灌爆 AI 的 context。 */
const MAX_FILES_INLINE = 200;
```

（c）在 `// ---- 匯入 / 排片 ----` 註解**下面、`import_media` 註冊之前**插入：

```typescript
server.registerTool(
  'list_source',
  {
    description:
      '列出素材夾內可匯入的檔案（不遞迴、排除隱藏檔、只回白名單副檔名）。' +
      'dir 為絕對路徑。imported 標示該檔是否已在本專案的 doc.media 裡。' +
      `超過 ${MAX_FILES_INLINE} 筆只內嵌前段並標 truncated。`,
    inputSchema: { dir: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ dir }) => {
    try {
      const all = await listSource(dir, store.doc.media, projectDir);
      const truncated = all.files.length > MAX_FILES_INLINE;
      const files = truncated ? all.files.slice(0, MAX_FILES_INLINE) : all.files;
      return result(
        { dir, files, total: all.files.length, ...(truncated ? { truncated: true } : {}) },
        `${all.files.length} file(s) in ${dir}` +
          (truncated ? `，僅內嵌前 ${MAX_FILES_INLINE} 筆` : ''),
      );
    } catch (e) {
      return err(`list_source failed: ${(e as Error).message}`);
    }
  },
);
```

- [ ] **Step 4: 跑測試確認通過**

```bash
npx vitest run --root server test/mcp-tools.test.ts
npx tsc --noEmit -p server
```

預期：`mcp-tools.test.ts` 從 20 條變 25 條，全過。並依 Step 2 的提醒，確認「目錄不存在」那條不是假綠。

- [ ] **Step 5: 加 mutant 並實跑**

`scripts/mutants.json` 加：

```json
{
  "id": "listsource-truncate",
  "file": "server/src/mcp.ts",
  "find": "        const files = truncated ? all.files.slice(0, MAX_FILES_INLINE) : all.files;",
  "replace": "        const files = all.files;",
  "tests": "server/test/mcp-tools.test.ts",
  "note": "拿掉 list_source 的 200 筆截斷 → 上千支檔的素材夾會整包塞回 AI 的 context；truncated 測試的 files 長度斷言必須抓到"
}
```

用 Task 2 Step 6 的同一支指令確認 `find` 恰好出現一次，然後：

```bash
node scripts/mutate.mjs listsource-truncate
```

預期：`✔ listsource-truncate`、`1/1 mutants killed`。

- [ ] **Step 6: Commit**

```bash
npx prettier --write server/src/mcp.ts server/test/mcp-tools.test.ts scripts/mutants.json
git add server/src/mcp.ts server/test/mcp-tools.test.ts scripts/mutants.json
git commit -m "feat(mcp): list_source 工具，AI 看得到素材夾"
```

---

### Task 5: `add_clip` MCP 工具

**Files:**

- Modify: `server/src/mcp.ts`
- Test: `server/test/mcp-tools.test.ts`
- Modify: `scripts/mutants.json`

**Interfaces:**

- Consumes: 既有 `aiWrite(store, cmd, ifVersion)`、`writeResultText(r)`、`result()`、`err()`；`addClip` Command variant `{ name: 'addClip'; mediaId: string; in: number; duration: number; label?: string }`
- Produces: MCP 工具 `add_clip`，`structuredContent` 為 `{ clipId: string; version: number }`

- [ ] **Step 1: 先讓 fixture 不會洩漏 review 狀態**

`server/test/mcp-tools.test.ts` 的 `beforeEach` 目前重置 tracks 與 render，但不重置 `review`。本 Task 會有測試把 `d.review` 設成非 null，若不重置就會污染後續測試——而 gauntlet 會跑隨機順序，一定會炸。

在 `beforeEach` 的 mutate 裡加一行：

```typescript
d.review = null;
```

跑 `npx vitest run --root server test/mcp-tools.test.ts` 確認既有測試仍全過（這是預防性修改，行為不變）。

- [ ] **Step 2: 寫失敗的測試**

加到 `server/test/mcp-tools.test.ts` 檔案最後：

```typescript
describe('add_clip', () => {
  it('接到主軌尾端，回新 clip 的 id', async () => {
    const before = store.doc.tracks.video.length;
    const r = await call('add_clip', { mediaId, in: 0, duration: 1, label: 'tail' });
    expect(r.isError ?? false).toBe(false);
    expect(store.doc.tracks.video).toHaveLength(before + 1);

    const sc = r.structuredContent as { clipId: string; version: number };
    expect(sc.clipId).toBe(store.doc.tracks.video.at(-1)!.id);
    expect(store.doc.tracks.video.at(-1)!.label).toBe('tail');
  });

  it('mediaId 不存在 → isError，主軌不變', async () => {
    const before = structuredClone(store.doc.tracks.video);
    const r = await call('add_clip', { mediaId: 'NOPE', in: 0, duration: 1 });
    expect(r.isError).toBe(true);
    expect(store.doc.tracks.video).toEqual(before);
  });

  it('in + duration 超過素材長度 → isError', async () => {
    // beforeAll 的 a.mp4 是 6 秒
    const r = await call('add_clip', { mediaId, in: 5, duration: 5 });
    expect(r.isError).toBe(true);
  });

  it('純音訊素材 → isError，訊息含 audio-only', async () => {
    store.mutate('ai', 'seed audio-only media', (d) => {
      d.media.push({
        id: 'bgmonly',
        path: '/outside/bgm.mp3',
        probe: {
          duration: 30,
          width: 0,
          height: 0,
          fps: 30,
          hasAudio: true,
          rotation: 0,
          hasVideo: false,
        },
      });
    });
    const r = await call('add_clip', { mediaId: 'bgmonly', in: 0, duration: 5 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/audio-only/);
  });

  // aiWrite 守衛：審核進行中不得寫入。若 add_clip 直接呼叫 applyCommand 就會漏掉這道。
  it('審核進行中 → isError', async () => {
    store.mutate('human', 'open review', (d) => {
      d.review = {
        id: 'r1',
        summary: 'check',
        sinceVersion: store.version,
        requestedAt: '2026-08-03T00:00:00.000Z',
      };
    });
    const r = await call('add_clip', { mediaId, in: 0, duration: 1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/review/);
  });

  // aiWrite 守衛：ifVersion 過期不得覆蓋人剛做的修改。
  it('過期的 ifVersion → isError', async () => {
    const r = await call('add_clip', { mediaId, in: 0, duration: 1, ifVersion: 999999 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/stale/);
  });
});
```

- [ ] **Step 3: 跑測試確認失敗**

```bash
npx vitest run --root server test/mcp-tools.test.ts -t add_clip
```

預期：6 條全紅，原因是工具不存在。

> 其中「mediaId 不存在」「超界」「純音訊」「審核中」「stale」五條在工具不存在時**都會通過 `isError` 斷言**——全是假綠。實作完成後必須逐條確認它們是因為對的原因而綠：`mediaId 不存在` 那條另外斷言了主軌不變、`純音訊` 與 `審核中` 與 `stale` 三條另外斷言了訊息內容，這些附加斷言就是防假綠的設計。第一條「接到主軌尾端」是唯一在工具不存在時必紅的，以它為 RED 的主證據。

- [ ] **Step 4: 寫最小實作**

`server/src/mcp.ts`，在 `set_timeline` 註冊**之後**插入：

```typescript
server.registerTool(
  'add_clip',
  {
    description:
      '把已匯入的素材接到主軌尾端（不動既有片段，適合逐支加片）。' +
      '純音訊素材會被拒——放 BGM／旁白請用 set_audio。回新 clip 的 clipId。',
    inputSchema: {
      mediaId: z.string(),
      in: z.number(),
      duration: z.number(),
      label: z.string().optional(),
      ifVersion: z.number().optional(),
    },
  },
  async ({ mediaId, in: clipIn, duration, label, ifVersion }) => {
    const cmd = { name: 'addClip', mediaId, in: clipIn, duration, label } as const;
    const r = aiWrite(store, cmd, ifVersion);
    if (!r.ok) return err(writeResultText(r));
    // addClip 的語意就是 append，所以新 clip 必為尾端那一個。
    const clipId = store.doc.tracks.video.at(-1)!.id;
    return result({ clipId, version: r.version }, `ok, clipId=${clipId}, version=${r.version}`);
  },
);
```

- [ ] **Step 5: 跑測試確認通過**

```bash
npx vitest run --root server test/mcp-tools.test.ts
npx vitest run --root server
npx tsc --noEmit -p server
```

預期：`mcp-tools.test.ts` 從 25 條變 31 條、server 全套 236 條（Task 6 之後會再 +2），全過。逐條檢查 Step 3 點名的五條假綠風險，確認訊息斷言真的命中（`audio-only`／`review`／`stale`）。

- [ ] **Step 6: 加 mutant 並實跑**

`scripts/mutants.json` 加（與既有 `mcp-ifversion-drop` 同型）：

```json
{
  "id": "addclip-mcp-ifversion",
  "file": "server/src/mcp.ts",
  "find": "      const r = aiWrite(store, cmd, ifVersion);",
  "replace": "      const r = aiWrite(store, cmd);",
  "tests": "server/test/mcp-tools.test.ts",
  "note": "add_clip 掉 ifVersion 佈線 → AI 的過期寫入會覆蓋人剛做的修改；stale 測試必須抓到"
}
```

確認 `find` 恰好一次後：

```bash
node scripts/mutate.mjs addclip-mcp-ifversion
```

預期：`✔ addclip-mcp-ifversion`、`1/1 mutants killed`。

> **不為「審核進行中」那條加 mutant，理由要寫進 EVIDENCE**：能表達它的 find/replace 是把 `aiWrite(store, cmd, ifVersion)` 換成 `applyCommand(store, 'ai', cmd)`，但 `applyCommand` 沒有被 `mcp.ts` import，突變版會在執行期丟 `ReferenceError` → 工具回 isError → 「審核中 → isError」那條反而**照樣綠**，真正殺掉它的會是「接到主軌尾端」那條快樂路徑測試。那是錯誤歸因，不是有效的 mutant。該路徑由測試守護、但無 mutant 覆蓋，如實記錄。

- [ ] **Step 7: Commit**

```bash
npx prettier --write server/src/mcp.ts server/test/mcp-tools.test.ts scripts/mutants.json
git add server/src/mcp.ts server/test/mcp-tools.test.ts scripts/mutants.json
git commit -m "feat(mcp): add_clip 工具，AI 能把素材接到主軌尾端"
```

---

### Task 6: MCP `instructions` 同步 + `CLAUDE.md` 鐵則修正

`CLAUDE.md` 的鐵則寫「加 Command variant → `commands.ts` 加驗證與 case → UI 與 MCP **自動**都能用」。`addClip` 就是反例：command 早就加好了，MCP 完全碰不到，這條分支做出來的能力因此沒有任何使用者。**這條錯誤的鐵則正是本案要補的缺口的根因。**

**Files:**

- Modify: `server/src/mcp.ts`（`instructions`）
- Modify: `CLAUDE.md:31-33`
- Test: `server/test/mcp-tools.test.ts`（instructions 同步的守衛測試）

**Interfaces:** 無程式碼介面變更。

- [ ] **Step 1: 更新 MCP `instructions`**

`server/src/mcp.ts` 的 `instructions` 字串，把開頭這兩行：

```typescript
        'vidcut 直式短影音時間軸編輯器（1080×1920）。典型流程：import_media 匯入素材' +
        '（可直接引用專案外的絕對路徑） → ' +
```

換成：

```typescript
        'vidcut 直式短影音時間軸編輯器（1080×1920）。典型流程：' +
        'list_source 看素材夾裡有什麼（dir 為絕對路徑，imported 標示已匯入者）→ ' +
        'import_media 逐支匯入（可直接引用專案外的絕對路徑，零複製）→ ' +
        'set_timeline 初次排片，或 add_clip 逐支接到主軌尾端（不動既有片段）→ ' +
```

並把原本 `'set_timeline 排片 → timeline_op 粗剪…'` 那一行開頭的 `set_timeline 排片 → ` 刪掉（避免重複），該行變成：

```typescript
        'timeline_op 粗剪（split/deleteBefore/deleteAfter/freeze）→ ' +
```

> **修正（執行時發現）**：初稿要求把純音訊那句補在 `set_audio …→ ` 之後。那個位置是
> 錯的——它會讓 `set_audio` 的 `→` 指向一句非步驟的說明，而真正的下一步 `request_review`
> 反而沒有箭頭引導，步驟鏈就斷了。正確做法是比照同段的 `set_canvas_fit blur` 補充句，
> **放在主鏈（`render 輸出。`）結束之後**的補充句區塊。以下文字內容不變，只改擺放位置。

在主鏈結束後的補充句區塊補一句純音訊語意：

```typescript
        '純音訊素材（mp3/wav…）只能上音訊軌，add_clip 與 set_timeline 會擋下它。' +
```

- [ ] **Step 2: 把「instructions 與工具清單同步」寫成測試**

`CLAUDE.md` 的鐵則要求「改了工具行為或語意，必須同步更新 `mcp.ts` 的工具描述與
instructions」。這條規則目前沒有任何東西在守——它被違反過一次（`get_frame` 的描述
殘留從未實作的 roadmap 字句，害 AI 誤判 overlay 沒設定成功），現在再違反一次也不會
有人發現。

MCP SDK 的 `Client` 有正式 API `getInstructions(): string | undefined`
（`node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.d.ts:167`），
所以這件事測得到。加到 `server/test/mcp-tools.test.ts` 檔案最後：

```typescript
// CLAUDE.md 鐵則「改了工具行為或語意必須同步 instructions」的執行面守衛。
// instructions 是 AI 使用者唯一的總覽文件——工具存在但沒寫進流程，等於沒人會用它。
describe('instructions 與工具清單同步', () => {
  it('寫入型的主線工具都出現在 instructions 裡', () => {
    const instructions = client.getInstructions() ?? '';
    for (const name of [
      'list_source',
      'import_media',
      'add_clip',
      'set_timeline',
      'set_audio',
      'render',
    ]) {
      expect(instructions, `${name} 不在 instructions 裡`).toContain(name);
    }
  });

  it('instructions 說明了純音訊素材的軌道限制', () => {
    expect(client.getInstructions() ?? '').toMatch(/純音訊/);
  });
});
```

**執行順序很重要**：這個測試要在 Step 1 的修改**之前**跑一次看它紅。若你已經先做完
Step 1，就用 `git stash` 把修改暫存起來、跑一次確認紅、再 `git stash pop`。

```bash
npx vitest run --root server test/mcp-tools.test.ts -t 'instructions 與工具清單同步'
```

- 未套用 Step 1 時預期：**2 條紅**，第一條的訊息會直接指出是 `list_source`
  不在 instructions 裡（`toContain` 加了自訂訊息）。
- 套用 Step 1 後預期：2 條綠，`mcp-tools.test.ts` 從 31 條變 33 條。

- [ ] **Step 3: 修 `CLAUDE.md` 的鐵則**

把 `CLAUDE.md` 第 31–33 行：

```markdown
- **任何專案狀態變更都走 `applyCommand`**（人）或 `aiWrite`→`applyCommand`（AI）。
  不要旁路直改 doc。新增一種編輯操作 = 在 `shared` 的 `Command` 加 variant
  - `commands.ts` 加驗證與 case → UI 與 MCP 自動都能用。
```

換成：

```markdown
- **任何專案狀態變更都走 `applyCommand`**（人）或 `aiWrite`→`applyCommand`（AI）。
  不要旁路直改 doc。新增一種編輯操作是**三步，第三步不會自動發生**：
  1. `shared/src/types.ts` 的 `Command` 加 variant
  2. `commands.ts` 加驗證與 case（驗證一律寫在這層，不要寫在 MCP 或 UI）
  3. **`mcp.ts` 手動 `registerTool` 並同步 `instructions`** —— 漏了第三步，
     AI 就永遠碰不到這個能力（前例：`addClip` 做完八輪 TDD 卻沒人能用，
     因為只做了 1、2 步）
```

- [ ] **Step 4: 全套驗證**

```bash
npm run typecheck && npm run lint && npm run format:check
npx vitest run --root server
```

預期：全綠。

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/src/mcp.ts CLAUDE.md
git add server/src/mcp.ts CLAUDE.md
git commit -m "docs(mcp): instructions 補素材夾流程與純音訊語意；修正 CLAUDE.md 誤導的鐵則"
```

---

### Task 7: 常駐文件去數字化 + ROADMAP 修正 + 技術債歸檔

**Files:**

- Modify: `HANDOFF.md:12`、`HANDOFF.md:18`、`HANDOFF.md:141`
- Modify: `docs/ROADMAP.md`

**Interfaces:** 無。

- [ ] **Step 1: `HANDOFF.md` 去數字化**

三處都錯，而且彼此矛盾（`:12` 說 15 個工具、`:141` 說 23 個，實際 31 個）。

第 12 行，把 `MCP server（15 工具）` 改成 `MCP server（工具清單見 mcp.ts）`。

第 18 行整行換成：

```markdown
**自動化狀態全綠**：typecheck 三 workspace 乾淨、ESLint 0 問題、prettier 乾淨、全測試套件通過、突變測試全滅、UI 可 build。全部走真 ffmpeg、真 whisper 與真 MCP/WS transport 驗證過。**當下數字跑 `bash scripts/gauntlet.sh` 看**——這份文件不寫會過期的數字（快照數字看 `EVIDENCE.md`，它帶 commit SHA）。
```

第 141 行，把 `server/src/mcp.ts         23 個 MCP 工具 + /mcp 掛載 ★` 改成：

```
server/src/mcp.ts         MCP 工具註冊 + /mcp 掛載（工具清單以本檔為準）★
```

- [ ] **Step 2: 確認沒有其他常駐文件殘留過期數字**

```bash
grep -rn "個測試\|個 MCP 工具\|[0-9]\+ 工具\|tests passed" CLAUDE.md HANDOFF.md README.md docs/ROADMAP.md
```

預期：只剩指向 `gauntlet.sh` / `EVIDENCE.md` 的敘述，沒有具體數字。有漏的就一併改掉。

- [ ] **Step 3: 修 ROADMAP 第 9 條的音訊說法**

實測結論：`import_media（絕對路徑 .mp3）` → `set_audio` 已經通了並渲染成功（`set_audio` 的 schema 本來就吃 `mediaId`）。ROADMAP 現在寫「剩下的是掛上音訊軌那半」不準。

把 `docs/ROADMAP.md` 第 9 條的第二段（`**剩下的是「掛上音訊軌」那半**：…` 整段）換成：

```markdown
**MCP 那條也已經通了**：`import_media`（吃絕對路徑）→ `set_audio`（schema 本來就吃
`mediaId`）→ `render`，實測可產出含 BGM 的成品。缺的只有 `POST /api/import` 帶
`addToTimeline: true` 時的分流——目前它一律呼叫 `addClip`（只上視訊軌且擋 audio-only），
所以匯入 BGM 會進 `failed[]`（素材其實已匯入）。可行方向：新增 `addAudio` command
（`{ mediaId, start, in, duration }` → append 到 `tracks.audio`），`/api/import` 依
`probe.hasVideo` 分流到 `addClip` 或 `addAudio`。這是產品決策，待定。
```

- [ ] **Step 4: 把仍有效的技術債從 `progress.md` 歸檔進 ROADMAP**

`.superpowers/sdd/2026-08-03-media-import-backend/progress.md` 累積 14 條 deferred minor，只活在分支的 sdd 目錄，分支收掉就蒸發。挑仍有效的五條，加到 `docs/ROADMAP.md` 的「可行方向」區塊最後：

```markdown
### 11. 素材匯入分支留下的已知缺口

八輪 TDD 期間逐條記錄、經 controller 裁決延後的項目（原始紀錄在該分支的
`.superpowers/sdd/2026-08-03-media-import-backend/progress.md`）：

- **`commands.ts:155`（`updateClip`）與 `:497`（`updateAudio`）的 `1e-6` 容差無 mutant
  覆蓋**——與 `addClip:218` 同形，但只有 `addClip` 那處有 `addclip-float-tolerance`
  守著。補兩隻 mutant 即可，屬小 Task。
- **`GET /api/source` 的「素材夾無權限」分支無專屬測資**——與「目錄不存在」共用同一條
  catch，行為正確但沒有獨立驗證。
- **`POST /api/import` 的 `failed[].error` 可能夾帶絕對路徑**——與既有 `/api/source`
  的錯誤格式一致，非新增問題，但若日後要對外開放需一併處理。
- **無全域 ffmpeg 佇列**——「逐支序列」只在單一 `/api/import` 請求內成立（由
  `import-api.test.ts` 的 `maxInFlight===1` 守著）；兩個併發請求、或 import 與
  `render`／`transcribe` 併行時不成立。
- **`scanSourceFolder` 逐檔序列 `await stat`**——上萬檔的素材夾會慢，目前規模無影響。
```

- [ ] **Step 5: 驗證格式**

```bash
npx prettier --check HANDOFF.md docs/ROADMAP.md CLAUDE.md
```

預期：`All matched files use Prettier code style!`（不符就先 `--write`）。

- [ ] **Step 6: Commit**

```bash
npx prettier --write HANDOFF.md docs/ROADMAP.md
git add HANDOFF.md docs/ROADMAP.md
git commit -m "docs: 常駐文件去數字化、修正音訊說法、技術債歸檔進 ROADMAP"
```

---

### Task 8: 完整 gauntlet + EVIDENCE 補記

**Files:**

- Modify: `EVIDENCE.md`

**Interfaces:** 無。

- [ ] **Step 1: 跑完整 gauntlet（背景執行，不要用會逾時被殺的前景執行）**

```bash
bash scripts/gauntlet.sh 2>&1 | tee /tmp/gauntlet-mcp-surface.log
```

突變測試會跑數分鐘（71 隻各跑一次 vitest，且 gauntlet 會跑兩次）。若中途被殺，務必 `git status` 確認沒有留下未還原的 mutant，有就 `git checkout -- <file>`。

預期最後一行：`GAUNTLET: 全數通過`。

- [ ] **Step 2: 逐格核對數字**

從 log 取實際數字，不要抄本計劃的預估值：

| 項目                   | 開工前                         | 本案新增                             | 預期                           |
| ---------------------- | ------------------------------ | ------------------------------------ | ------------------------------ |
| `sourceFolder.test.ts` | 12                             | +2（Task 1）                         | 14                             |
| `commands.test.ts`     | 22                             | +7（Task 2）                         | 29                             |
| `render.test.ts`       | 10                             | +1（Task 3）                         | 11                             |
| `mcp-tools.test.ts`    | 20                             | +5（Task 4）+6（Task 5）+2（Task 6） | 33                             |
| **server 全部**        | **215**                        | **+23**                              | **238**                        |
| shared／ui             | 27／170                        | 0                                    | 27／170                        |
| **全測試套件**         | **412**                        | **+23**                              | **435**                        |
| 突變                   | 68（67 killed + 1 equivalent） | +3                                   | 71（70 killed + 1 equivalent） |

唯一預期存活的是 `store-corrupt-load`（既有等價對照組）。typecheck／lint／prettier／
隨機順序／秘密掃描皆須 PASS。

任何一格對不上就是問題，先查清楚再往下走，**不要調整文件去遷就**。

- [ ] **Step 3: 寫 EVIDENCE 補記**

在 `EVIDENCE.md` 檔案最後加一節「## 補記：MCP 面補完」，內容必須包含：

1. **行為 → 測試對映表**：spec 的 21 條驗收條件逐條對到實際測試名稱（檔案:行號）。
2. **本案新增的 3 隻 mutant** 與實跑結果。
3. **誠實記錄兩項無 mutant 覆蓋者**：
   - `add_clip` 的「審核進行中被拒」路徑——理由照 Task 5 Step 6 的說明寫（表達它的 mutant 會因 `applyCommand` 未 import 而錯誤歸因）。
   - Task 3 的錯誤訊息字串——新測試本身就是唯一守護，再打 mutant 只是重述同一條斷言。
4. **行為變更聲明**：`setAudio` 從零驗證改為逐項驗證，附「全 repo 只有兩處呼叫、兩處都會過、UI 完全不走 `setAudio`」的查證結果。
5. **GAUNTLET 表**：照 `EVIDENCE.md` 既有格式，附 `source` commit SHA。
6. 若 GAUNTLET 那次執行早於收錄它的 commit，照既有慣例加註（見 `EVIDENCE.md` 的「補記三」寫法）。

- [ ] **Step 4: 格式與 commit**

```bash
npx prettier --write EVIDENCE.md
npx prettier --check EVIDENCE.md
git add EVIDENCE.md
git commit -m "docs(evidence): MCP 面補完的證據補記"
```

- [ ] **Step 5: 收尾檢查**

```bash
git status --porcelain   # 必須是空的
git log --oneline 013a0fc..HEAD
```

預期：8 個 commit（Task 1–8 各一），工作區乾淨。

---

## Self-Review（本計劃寫完後對照 spec 的檢查結果）

**1. Spec 覆蓋率**——spec 的 8 個「做」項目逐條對應：

| spec 項目                           | Task                          |
| ----------------------------------- | ----------------------------- |
| 1. `list_source` 工具               | Task 4（+ Task 1 的共用輔助） |
| 2. `add_clip` 工具                  | Task 5                        |
| 3. `setAudio` 補驗證                | Task 2                        |
| 4. `render.ts` 錯誤訊息補 `mediaId` | Task 3                        |
| 5. MCP `instructions` 同步          | Task 6                        |
| 6. `CLAUDE.md` 鐵則修正             | Task 6                        |
| 7. 常駐文件去數字化                 | Task 7                        |
| 8. ROADMAP 修正與技術債歸檔         | Task 7                        |

spec 的 21 條驗收條件：1–6 → Task 4；7–13 → Task 5；14–20 → Task 2；21 → Task 3。無遺漏。

spec 的 3 隻 mutant 中，`addclip-mcp-aiwrite` 在 Task 5 改為 `addclip-mcp-ifversion`
並附了改名理由（原設計的 find/replace 會造成錯誤歸因）。這是 spec 的可執行細節在實作
規劃時被修正，已在 Task 5 Step 6 與 Task 8 Step 3 兩處記錄，符合 old-coder「spec 是
append-only，發現錯了要明講並可見地修正」的要求。

**2. 占位符掃描**——無 TBD／TODO／「類似 Task N」／「加上適當的錯誤處理」。每個程式碼步驟都有完整可貼上的程式碼。

**3. 型別一致性**——`listSource(dir, media, projectDir)` 的簽章在 Task 1 定義、Task 4 使用，參數順序一致；`SourceListing.files` 的欄位（`name`/`size`/`mtime`/`imported`）在 Task 1 與 Task 4 的測試中一致；`add_clip` 的 `structuredContent` 形狀 `{ clipId, version }` 在 Task 5 的實作與測試中一致；`MAX_FILES_INLINE` 在 Task 4 的實作、描述字串與 mutant 中都是同一個常數名。

**4. 已知的執行風險（給執行者的提醒）**

- **mutant 的 `find` 字串必須逐字相符**。prettier 可能把本計劃預期的換行方式改掉。每隻 mutant 都附了「確認恰好出現一次」的指令，務必跑。
- **假綠風險集中在 Task 4 與 Task 5**：工具不存在時，`expect(isError).toBe(true)` 會照樣通過。兩個 Task 的 Step 2/3 都標明了哪幾條有此風險、以及靠哪些附加斷言防它。
- **Task 5 Step 1 的 `d.review = null` 不是可有可無**：gauntlet 會跑隨機順序，漏了它會出現「單獨跑過、隨機順序爆掉」的假通過。
