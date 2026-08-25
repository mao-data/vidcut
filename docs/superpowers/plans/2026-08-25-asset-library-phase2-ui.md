# 跨專案素材庫 第二期（Media 面板 + 圖片入庫）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 右側面板新增 Media 分頁（專案媒體／素材庫／素材夾三區），並讓素材庫收圖片（匯入專案走 image overlay）——人類這一側的素材庫入口。

**Architecture:** 後端在第一期地基上加三小截：圖片 kind（無 ffmpeg derived，檔案本身即縮圖）、兩條 UI 專用入庫路由（from-media 反向沉澱／from-path 素材夾直接入庫）、匯入路由對 image 分流（複製進 `assets/` 回 relPath）。前端全新 `MediaPanel`（`.panel-col` 慣例、zustand 讀 doc、REST 打 `/api/library*`），App.tsx 分頁 union 加 `'media'`。

**Tech Stack:** React + zustand + 既有 theme.css class；express 路由；vitest（真 ffmpeg）+ verify:panels（CDP）。

**Spec:** `docs/superpowers/specs/2026-08-21-asset-library-design.md` §「HTTP 路由與 UI」（三區內容與按鈕已定案）+ 本輪使用者決策（2026-08-25）：**素材庫收圖片、匯入走 image overlay**；「靜圖上主軌」獨立成案不在本期；overlay 不改名。

## Global Constraints

- 工作目錄 `ai-video-cut/`；新 worktree 第一件事 `npm install` 並自檢 `node_modules/@vidcut/shared` symlink 指向本 worktree。
- 不要 `git add -A`；commit 結尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- MCP 三步鐵則：動 `mcp.ts` 工具面 → snapshot 先讀 diff 再 `-u`。
- **UI 鐵則**（`ui/DESIGN.md` + `.claude/rules/ui-verification.md`）：
  - zustand selector fallback 必須是**模組級常數**（`?? []` 會 React #185 白屏，見 `CaptionList.tsx:63-67`）。
  - 右欄分頁一律 `.seg`（不是 `.tab-link`）；間距只用 4 的倍數；面板內 icon 13px；顏色走 token 不硬寫；卡片底用 `--card` 或 `--panel`+`--line`（**不可**動用 `--panel-2`）；**拖曳上傳區不得用虛線框**；不用紅色做選取/badge；hover 是 `translate(0,-1px)` 不是加陰影。
  - 所有 `<img>` 一律 `draggable={false}`；新按鈕務必給 `title`（verify:panels 靠它定位）。
  - **Media 分頁內的任何操作都不呼叫 `useSelection.select()`**——App.tsx:230 的「選取跳 Properties」會把使用者踢出 Media 分頁（本計畫的頭號架構風險，Task 4 起逐條遵守）。
  - 改完 UI 原始碼必須 `npm run build -w @vidcut/ui` 才會反映到 :3845。
  - UI 單元測試中相對 URL fetch 預設 404（`ui/src/test/setup.ts`），要驗回應用 `vi.stubGlobal('fetch', ...)`。
- 測試暫存目錄用 `server/test/tmp.ts` 的 `tmpDir`；UI 字串一律英文；註解繁中講「為什麼」。
- `gauntlet.sh` 跑時不 commit；prettier 修正要在 gauntlet 前 commit（突變層還原會洗掉未 commit 的格式修正——第一期教訓）。

---

### Task 1: 圖片入庫（後端：`kind: 'image'`）

**Files:**

- Modify: `shared/src/types.ts`（`LibraryAsset.kind` union）
- Modify: `server/src/sourceFolder.ts`（新增 `IMAGE_EXTENSIONS` 常數——放這裡與 `MEDIA_EXTENSIONS` 並列，**不併入** `MEDIA_EXTENSIONS`：素材夾掃描與 `import_media` 仍只認影音，圖片不能變成 clip）
- Modify: `server/src/libraryIngest.ts`（`addToLibrary` 圖片分支、`probeImageSize`）
- Test: `server/test/libraryIngest.test.ts`（新增 describe）

**Interfaces:**

- Consumes: 第一期 `addToLibrary`／`LibraryStore`、`runFfmpeg` 所在的 `./ffmpeg.js`（用 `ffprobe` 同層工具——見實作）
- Produces: `IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.svg'] as const`（與 mograph assets 白名單同一組）；`addToLibrary` 收圖片副檔名 → `kind: 'image'`、**不產任何 derived**、`probe` 為資訊性尺寸（`{duration:0, width, height, fps:0, hasAudio:false, rotation:0}`，svg 量不到時 `width/height` 為 0）；`prepareFromLibrary` 對 `kind === 'image'` 丟 `image asset ${id} cannot be imported as media; use the image import path`

- [ ] **Step 1: 寫失敗測試**

`server/test/libraryIngest.test.ts` 新增：

```ts
describe('addToLibrary: image kind', () => {
  it('png 入庫：kind=image、無 derived、probe 帶尺寸', async () => {
    const { lib, srcDir, libDir } = await setup();
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=320x240:duration=0.1',
      '-frames:v',
      '1',
      join(srcDir, 'logo.png'),
    ]);
    const { asset } = await addToLibrary(lib, join(srcDir, 'logo.png'), {
      label: '品牌 logo',
      tags: ['brand'],
      origin: { type: 'source' },
    });
    expect(asset.kind).toBe('image');
    expect(asset.file).toBe(join('files', `${asset.hash}.png`));
    expect(asset.probe.width).toBe(320);
    expect(asset.probe.height).toBe(240);
    expect(asset.probe.duration).toBe(0);
    expect(existsSync(join(libDir, 'derived', asset.hash))).toBe(false); // 圖片零 derived
    expect(lib.list({ kind: 'image' })).toHaveLength(1);
    expect(lib.list({ kind: 'media' })).toHaveLength(0);
  }, 30_000);

  it('圖片同內容冪等去重；壞圖（副檔名對、內容爛）拒收零殘留', async () => {
    const { lib, srcDir, libDir } = await setup();
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=8x8:duration=0.1',
      '-frames:v',
      '1',
      join(srcDir, 'a.png'),
    ]);
    const first = await addToLibrary(lib, join(srcDir, 'a.png'), { origin: { type: 'source' } });
    const { copyFile } = await import('node:fs/promises');
    await copyFile(join(srcDir, 'a.png'), join(srcDir, 'b.png'));
    const second = await addToLibrary(lib, join(srcDir, 'b.png'), { origin: { type: 'source' } });
    expect(second.existing).toBe(true);
    expect(second.asset.id).toBe(first.asset.id);
    await writeFile(join(srcDir, 'junk.png'), 'not an image');
    await expect(
      addToLibrary(lib, join(srcDir, 'junk.png'), { origin: { type: 'source' } }),
    ).rejects.toThrow();
    expect(await readdir(join(libDir, 'files'))).toHaveLength(1); // 只有 a.png 那筆
  }, 30_000);

  it('prepareFromLibrary 拒絕 image kind', async () => {
    const { lib, srcDir } = await setup();
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=8x8:duration=0.1',
      '-frames:v',
      '1',
      join(srcDir, 'a.png'),
    ]);
    const { asset } = await addToLibrary(lib, join(srcDir, 'a.png'), {
      origin: { type: 'source' },
    });
    const store = await ProjectStore.load(
      join(await tmpDir('vidcut-libimg-proj-'), 'project.json'),
    );
    await expect(
      prepareFromLibrary(store, dirname(store['#filePath'] ?? ''), lib, asset.id),
    ).rejects.toThrow('cannot be imported as media');
  }, 30_000);
});
```

（第三個測試的 projectDir 取法照檔內既有 setup 慣例改寫——用 `tmpDir` 建 projDir 再 `ProjectStore.load(join(projDir,'project.json'))`，不要真的碰私有欄位；上面示意以現有測試檔的 setup helper 為準。`runFfmpeg`、`readdir`、`writeFile`、`dirname` 依需要補 import。）

- [ ] **Step 2: 跑紅** — `npm test -w @vidcut/server -- libraryIngest`，Expected: FAIL（unsupported extension: .png）

- [ ] **Step 3: 實作**

`shared/src/types.ts`：`kind: 'media'` → `kind: 'media' | 'image'`，註解補「'image'＝2026-08-25 第二期新增：匯入專案走 image overlay，不是 clip；'font' | 'stylePreset' | 'mograph' 仍預留」。`probe` 欄註解補「image kind 的 probe 是資訊性尺寸（duration/fps 為 0），匯入分流看 kind 不看 probe」。

`server/src/sourceFolder.ts`（`MEDIA_EXTENSIONS` 之後）：

```ts
/**
 * 素材庫可收的圖片副檔名（小寫比對）。與 mograph assets 白名單同一組。
 * 刻意**不**併入 MEDIA_EXTENSIONS：素材夾掃描與 import_media 只認影音——
 * 圖片在專案裡是 overlay 素材不是 clip（「靜圖上主軌」另案）。
 */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.svg'] as const;
```

`server/src/libraryIngest.ts`：

```ts
import { IMAGE_EXTENSIONS, MEDIA_EXTENSIONS } from './sourceFolder.js';
import { runFfprobe } from './ffmpeg.js'; // 若 ffmpeg.ts 沒有現成 ffprobe helper，見下方註記

/** 圖片尺寸（資訊性）。svg 等 ffprobe 量不到的回 0×0——匯入分流看 kind，不靠這裡。 */
async function probeImageSize(abs: string): Promise<{ width: number; height: number }> {
  try {
    const out = await runFfprobe([
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'json',
      abs,
    ]);
    const s = (JSON.parse(out) as { streams?: Array<{ width?: number; height?: number }> })
      .streams?.[0];
    if (!s?.width || !s?.height) throw new Error('no dimensions');
    return { width: s.width, height: s.height };
  } catch {
    if (extname(abs).toLowerCase() === '.svg') return { width: 0, height: 0 };
    throw new Error(`not a decodable image: ${abs}`);
  }
}
```

（**註記**：先看 `server/src/ffmpeg.ts` 有沒有可執行 ffprobe 並回 stdout 的既有 helper（`probe()` 內部一定有呼叫 ffprobe 的路徑）；有就複用，沒有就在 ffmpeg.ts 加一個 `export async function runFfprobe(args: string[]): Promise<string>`（spawn ffprobe、收 stdout、非零 exit 丟錯——與 `runFfmpeg` 同款式）。壞圖判定靠它丟錯。）

`addToLibrary` 改動（副檔名判斷與分支）：

```ts
const ext = extname(absPath).toLowerCase();
const isImage = (IMAGE_EXTENSIONS as readonly string[]).includes(ext);
if (!isImage && !(MEDIA_EXTENSIONS as readonly string[]).includes(ext)) {
  throw new Error(`unsupported extension: ${ext || '(none)'}`);
}
// …hash、byHash 去重照舊…
// probe 分流：影音走 ffprobe 全量（壞檔在落地前擋下），圖片走尺寸探測（同樣先於落地）
const info: ProbeInfo = isImage
  ? { duration: 0, ...(await probeImageSize(absPath)), fps: 0, hasAudio: false, rotation: 0 }
  : await probe(absPath);
// …copy/move 照舊…
if (!isImage) await buildLibraryDerivatives(fileAbs, derivedAbs, info); // 圖片零 derived：檔案本身即縮圖（/library/files/<hash><ext>）
// …組 asset 時 kind: isImage ? 'image' : 'media'，mutate 入索引與清理照舊
//（失敗清理的 rm derivedAbs 對圖片是 no-op，不用分流）
```

`prepareFromLibrary` 開頭（`lib.get` 之後）：

```ts
if (a.kind === 'image') {
  throw new Error(
    `image asset ${assetId} cannot be imported as media; use the image import path (it becomes an overlay)`,
  );
}
```

- [ ] **Step 4: 跑綠** — `npm test -w @vidcut/server -- libraryIngest && npm test -w @vidcut/server -- import-from-library && npm run typecheck`
- [ ] **Step 5: Commit** — `git add shared/src/types.ts server/src/sourceFolder.ts server/src/libraryIngest.ts server/src/ffmpeg.ts server/test/libraryIngest.test.ts`（ffmpeg.ts 只在真的加了 helper 時）；`feat: image kind in asset library (no derived; file is its own thumbnail)`

---

### Task 2: UI 專用路由三條（from-media／from-path／image import 分流）

**Files:**

- Modify: `server/src/app.ts`
- Test: `server/test/library-api.test.ts`（新增 describe）

**Interfaces:**

- Consumes: Task 1、第一期 `addToLibrary`／`prepareFromLibrary`／`discardPrepared`、既有 `resolveMediaPath`（`./paths.js`）
- Produces:
  - `POST /api/library/from-media` body `{mediaId, label?, tags?}` → 把專案素材沉澱入庫（反向沉澱鈕的後端）；回 `addToLibrary` 的 `{asset, existing}`
  - `POST /api/library/from-path` body `{path, label?, tags?}` → 素材夾「直接入庫」；path 必須絕對；回同上
  - `POST /api/library/:id/import` 分流：`kind==='image'` → 複製進 `projects/<p>/assets/`（basename 消毒 + 重名編號，與 `POST /assets` 同款）→ 回 `{kind:'image', relPath}`；影音照舊回 `{mediaId}`（形狀不變，向後相容）

- [ ] **Step 1: 寫失敗測試**

`server/test/library-api.test.ts` 新增：

```ts
describe('phase 2 routes', () => {
  it('POST /api/library/from-media 反向沉澱：專案素材入庫、origin=project', async () => {
    const { lib, srcDir, store, projDir, server, base } = await startTestServer();
    await makeVideo(srcDir, 'v.mp4', { duration: 2 });
    const mediaId = await ingestMediaFully(store, projDir, join(srcDir, 'v.mp4'), { label: 'v' });
    const res = await fetch(`${base}/api/library/from-media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaId, label: '常用片頭', tags: ['intro'] }),
    });
    expect(res.status).toBe(200);
    const { asset, existing } = (await res.json()) as {
      asset: { origin: { type: string }; label: string };
      existing: boolean;
    };
    expect(existing).toBe(false);
    expect(asset.origin.type).toBe('project');
    expect(asset.label).toBe('常用片頭');
    expect(
      (
        await fetch(`${base}/api/library/from-media`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mediaId: 'nope' }),
        })
      ).status,
    ).toBe(404);
    server.close();
  }, 120_000);

  it('POST /api/library/from-path 直接入庫；相對路徑 400', async () => {
    const { lib, srcDir, server, base } = await startTestServer();
    await makeVideo(srcDir, 'v.mp4', { duration: 2 });
    const res = await fetch(`${base}/api/library/from-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: join(srcDir, 'v.mp4'), tags: ['broll'] }),
    });
    expect(res.status).toBe(200);
    expect(lib.list({ tag: 'broll' })).toHaveLength(1);
    expect(
      (
        await fetch(`${base}/api/library/from-path`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: 'relative/v.mp4' }),
        })
      ).status,
    ).toBe(400);
    server.close();
  }, 120_000);

  it('image asset 匯入：複製進 assets/ 回 relPath；重名自動編號', async () => {
    const { lib, srcDir, projDir, server, base } = await startTestServer();
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=8x8:duration=0.1',
      '-frames:v',
      '1',
      join(srcDir, 'logo.png'),
    ]);
    const { asset } = await addToLibrary(lib, join(srcDir, 'logo.png'), {
      label: 'logo',
      origin: { type: 'source' },
    });
    const imp = () =>
      fetch(`${base}/api/library/${asset.id}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    const r1 = (await (await imp()).json()) as { kind: string; relPath: string };
    expect(r1.kind).toBe('image');
    expect(r1.relPath).toBe(join('assets', 'logo.png'));
    expect(existsSync(join(projDir, r1.relPath))).toBe(true);
    const r2 = (await (await imp()).json()) as { relPath: string };
    expect(r2.relPath).toBe(join('assets', 'logo-1.png')); // 重名編號（不做內容去重——專案內 assets 本來就允許多份）
    server.close();
  }, 60_000);
});
```

（`ingestMediaFully` 由 `../src/ingest.js` import；`startTestServer` 回傳值若缺 `projDir` 就順手補上。）

- [ ] **Step 2: 跑紅** — `npm test -w @vidcut/server -- library-api`，Expected: FAIL（404）
- [ ] **Step 3: 實作**（插在既有 `/api/library/:id/import` 附近；`libErr` 複用）

```ts
// 反向沉澱：人監修時把 AI 匯入的好素材一鍵入庫（Veed 式，spec §UI 三區）
app.post('/api/library/from-media', (req, res, next) => {
  void (async () => {
    if (!lib) {
      res.status(503).json({ error: 'library unavailable' });
      return;
    }
    const { mediaId, label, tags } = (req.body ?? {}) as {
      mediaId?: string;
      label?: string;
      tags?: string[];
    };
    const m = mediaId ? store.doc.media.find((x) => x.id === mediaId) : undefined;
    if (!m) {
      res.status(404).json({ error: `no media ${mediaId ?? ''} in this project` });
      return;
    }
    try {
      res.json(
        await addToLibrary(lib, resolveMediaPath(projectDir, m.path), {
          label: label ?? m.label ?? basename(m.path),
          tags,
          origin: { type: 'project', note: store.doc.name },
        }),
      );
    } catch (e) {
      libErr(res, e);
    }
  })().catch(next);
});

// 素材夾「直接入庫」（掃描列表旁的按鈕；path 來自 GET /api/source 的結果組合）
app.post('/api/library/from-path', (req, res, next) => {
  void (async () => {
    if (!lib) {
      res.status(503).json({ error: 'library unavailable' });
      return;
    }
    const { path, label, tags } = (req.body ?? {}) as {
      path?: string;
      label?: string;
      tags?: string[];
    };
    if (!path || !isAbsolute(path)) {
      res.status(400).json({ error: 'path must be absolute' });
      return;
    }
    try {
      res.json(
        await addToLibrary(lib, path, {
          label,
          tags,
          origin: { type: 'source', note: path },
        }),
      );
    } catch (e) {
      libErr(res, e);
    }
  })().catch(next);
});
```

既有 `POST /api/library/:id/import` handler 開頭（`prepareFromLibrary` 之前）加分流：

```ts
const a = lib.get(req.params.id);
if (a?.kind === 'image') {
  // 圖片＝overlay 素材：複製進 assets/（與 POST /assets 同款消毒+重名編號），
  // overlay 的 imagePath 走專案相對路徑（/media 靜態與渲染都吃這個），
  // 所以這裡是複製不是零複製引用。
  const clean = basename(a.file); // files/<hash>.<ext> 的 basename 不含使用者輸入
  const ext = extname(clean);
  const stem = (a.label || 'image').replace(/[^\w.\-一-鿿]/g, '_');
  await mkdir(join(projectDir, 'assets'), { recursive: true });
  let rel = join('assets', `${stem}${ext}`);
  for (let i = 1; existsSync(join(projectDir, rel)); i++) {
    rel = join('assets', `${stem}-${i}${ext}`);
  }
  await copyFile(lib.fileAbs(a), join(projectDir, rel));
  res.json({ kind: 'image', relPath: rel });
  return;
}
```

（`isAbsolute`、`copyFile` 補 import；`mkdir`/`existsSync`/`basename`/`extname` 已有。）

- [ ] **Step 4: 跑綠** — `npm test -w @vidcut/server -- library-api && npm run typecheck`
- [ ] **Step 5: Commit** — `feat: UI-facing library routes — from-media, from-path, image import branch`

---

### Task 3: MCP 面收圖片 + snapshot

**Files:**

- Modify: `server/src/mcp.ts`
- Test: `server/test/library-mcp.test.ts`（新增一條）、snapshot 更新

**Interfaces:**

- Consumes: Task 1／2
- Produces: `list_library` 的 `kind` enum 變 `['media','image']`、輸出多 `width`/`height`（optional）；`add_to_library` 描述補圖片；`import_from_library` 對 image asset 分流——複製進 assets/（與 Task 2 路由同邏輯，抽成 `server/src/libraryIngest.ts` 的 `export async function importImageToProject(projectDir: string, lib: LibraryStore, asset: LibraryAsset): Promise<string /* relPath */>`，Task 2 的路由**改為呼叫它**避免兩份實作）→ 回 `{ kind:'image', assetPath }` 並在文字回覆指引「use add_overlay with imagePath=<assetPath>」；instructions 句補一小段圖片語意

- [ ] **Step 1: 先做小重構**：把 Task 2 寫在路由裡的圖片複製邏輯抽成 `importImageToProject`（libraryIngest.ts），路由改呼叫；跑 `npm test -w @vidcut/server -- library-api` 守住行為。
- [ ] **Step 2: 寫失敗測試**（`library-mcp.test.ts`）：

```ts
it('image asset：list_library 可過濾、import_from_library 回 assetPath 而非 mediaId', async () => {
  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=red:size=8x8:duration=0.1',
    '-frames:v',
    '1',
    join(srcDir, 'logo.png'),
  ]);
  const added = await call('add_to_library', { path: join(srcDir, 'logo.png'), label: 'logo' });
  expect(added.isError).toBeFalsy();
  const assetId = (added.structuredContent as { assetId: string }).assetId;
  const listed = await call('list_library', { kind: 'image' });
  expect(
    (listed.structuredContent as { assets: Array<{ id: string }> }).assets.map((a) => a.id),
  ).toContain(assetId);
  const imp = await call('import_from_library', { assetId });
  expect(imp.isError).toBeFalsy();
  const sc = imp.structuredContent as { kind?: string; assetPath?: string; mediaId?: string };
  expect(sc.kind).toBe('image');
  expect(sc.assetPath).toMatch(/^assets\//);
  expect(sc.mediaId).toBeUndefined();
}, 60_000);
```

- [ ] **Step 3: 跑紅**，**Step 4: 實作**：

`list_library`：inputSchema `kind: z.enum(['media', 'image']).optional()`；outputSchema assets 元素加 `width: z.number().optional(), height: z.number().optional()`；map 時 `...(a.kind === 'image' ? { width: a.probe.width, height: a.probe.height } : {})`。

`add_to_library` 描述句尾加：`' Images (png/jpg/webp/svg) are accepted too — they become kind:"image" assets that import as overlay material, not clips.'`

`import_from_library`：outputSchema 加 `kind: z.string().optional(), assetPath: z.string().optional()`，`mediaId` 改 optional；handler 在 `prepareFromLibrary` 之前：

```ts
const a = library!.get(assetId);
if (a?.kind === 'image') {
  const rel = await importImageToProject(projectDir, library!, a);
  return result(
    { kind: 'image', assetPath: rel },
    `copied ${assetId} into the project as ${rel} — place it with add_overlay (imagePath: "${rel}")`,
  );
}
```

instructions 那句（第一期插入的）在 `update_library_asset renames/retags one already there. ` 之後補：`'Image assets import as overlay material: import_from_library returns an assetPath — place it with add_overlay, not on the clip track. '`

- [ ] **Step 5: library-mcp 跑綠 → snapshot 閘門**（先讀 diff：只有上述 schema/描述/instructions 變化 → `-u` → 綠）→ `npm test -w @vidcut/server && npm run typecheck && npm run lint`
- [ ] **Step 6: Commit** — `feat: MCP library tools accept images (import returns assetPath for add_overlay)`

---

### Task 4: Media 分頁骨架（App.tsx + MediaPanel 殼 + 三區子切換）

**Files:**

- Modify: `ui/src/App.tsx`
- Create: `ui/src/panels/MediaPanel.tsx`
- Modify: `ui/DESIGN.md`（右欄分頁敘述那段：兩分頁 → 三分頁）
- Test: `ui/src/panels/MediaPanel.test.tsx`

**Interfaces:**

- Consumes: `useProject`／`.seg`／`.panel-col`／`.panel-bar`／`.panel-body` class、GSAP 分頁動畫（吃 `tab` 值，零改動）
- Produces: `App.tsx` 的 `tab` union 加 `'media'`＋分頁列第三顆 `.seg` 按鈕（放 Captions 之前——媒體在工作流順序上先於字幕；badge 顯示 `doc.media.length`，>0 才顯示，照 Captions 範本）；`MediaPanel` 內部子區切換 `useState<'project' | 'library' | 'source'>('project')`，子區列同樣用 `.seg`（小一號靠 `fontSize` 不動——`.seg` 本身即可，DESIGN.md 允許同 class 兩層）

- [ ] **Step 1: 寫失敗測試**（`MediaPanel.test.tsx`，照 `panels.test.tsx` 慣例 render + 斷言）：

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MediaPanel } from './MediaPanel.js';
import { useProject } from '../stores/project.js';
import { makeDoc } from '../test/fixtures.js';

describe('MediaPanel', () => {
  it('三個子區可切換；預設專案媒體', () => {
    useProject.setState({ doc: makeDoc() });
    render(<MediaPanel />);
    expect(screen.getByTitle('Project media')).toBeTruthy();
    expect(screen.getByTitle('Library')).toBeTruthy();
    expect(screen.getByTitle('Source folder')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Library'));
    expect(screen.getByPlaceholderText('Search library')).toBeTruthy();
  });
});
```

（`makeDoc` 以 `ui/src/test/fixtures.ts` 實際輸出為準；fixture 若無 helper 就 setState 一個含空 `media` 的最小 doc。）

- [ ] **Step 2: 跑紅** — `npm test -w @vidcut/ui -- MediaPanel`
- [ ] **Step 3: 實作**

`MediaPanel.tsx` 殼（三區元件 Task 5–7 逐一填）：

```tsx
import { useState } from 'react';

/**
 * Media 分頁：專案媒體／素材庫／素材夾 三區（spec 2026-08-21 §UI；CapCut Space 心智模型）。
 * ⚠️ 本面板內任何操作都不呼叫 useSelection.select()——App.tsx 的「選取跳 Properties」
 * 會把使用者踢出本分頁（那條 effect 是 2026-08-16 版面定案，不改它，改我們自己）。
 */
export function MediaPanel() {
  const [zone, setZone] = useState<'project' | 'library' | 'source'>('project');
  return (
    <div className="panel-col" style={{ minWidth: 0 }}>
      <div className="panel-bar" style={{ gap: 4 }}>
        <button
          className={`seg${zone === 'project' ? ' on' : ''}`}
          title="Project media"
          onClick={() => setZone('project')}
        >
          Project
        </button>
        <button
          className={`seg${zone === 'library' ? ' on' : ''}`}
          title="Library"
          onClick={() => setZone('library')}
        >
          Library
        </button>
        <button
          className={`seg${zone === 'source' ? ' on' : ''}`}
          title="Source folder"
          onClick={() => setZone('source')}
        >
          Folder
        </button>
      </div>
      {zone === 'project' && <ProjectMediaZone />}
      {zone === 'library' && <LibraryZone />}
      {zone === 'source' && <SourceFolderZone />}
    </div>
  );
}
```

（本 task 內 `ProjectMediaZone`／`LibraryZone`／`SourceFolderZone` 先做最小可測殼：`LibraryZone` 至少含 `<input placeholder="Search library" />` 讓測試立足；Task 5–7 換成真身。）

`App.tsx`：`useState<'captions' | 'properties'>` → 加 `'media'`；分頁列在 Captions 前插：

```tsx
<button className={`seg${tab === 'media' ? ' on' : ''}`} onClick={() => setTab('media')}>
  Media {mediaCount > 0 && <span className="badge">{mediaCount}</span>}
</button>
```

（`const mediaCount = doc?.media.length ?? 0;` 加在 `captionCount` 旁。）內容區三元改三分支（Media 分支 `<MediaPanel />`，走 CaptionList 同款「內部自帶 panel-col 自己捲」契約）。

`ui/DESIGN.md` 右欄敘述段同步為三分頁（保留「選取跳 Properties／取消不跳走」原文，補一句「Media 分頁內的操作不觸發 select，避免被跳走」）。

- [ ] **Step 4: 跑綠** — `npm test -w @vidcut/ui -- MediaPanel && npm run typecheck && npm run lint`
- [ ] **Step 5: Commit** — `git add ui/src/App.tsx ui/src/panels/MediaPanel.tsx ui/src/panels/MediaPanel.test.tsx ui/DESIGN.md`；`feat(ui): Media tab skeleton with three zones`

---

### Task 5: 專案媒體區（列表＋加到時間軸＋反向沉澱）

**Files:**

- Modify: `ui/src/panels/MediaPanel.tsx`（`ProjectMediaZone` 真身）
- Test: `ui/src/panels/MediaPanel.test.tsx`（新增）

**Interfaces:**

- Consumes: `useProject`（`doc.media`——**fallback 用模組級常數 `NO_MEDIA`**）、`sendCommand`（`addClip`／`setAudio`）、`usePlayback`（playhead）、Task 2 `POST /api/library/from-media`
- Produces: 每列——filmstrip 首格縮圖（`/media/${m.filmstripPath}`，`background-size` 用 `filmstripTiles` 換算取第一格；audio-only 顯示 `Music` icon 13px）＋label＋`mono` 時長＋來自素材庫的 `tag` 掛標（`m.meta?.libraryId` 存在時顯示 `lib`）＋兩顆 `icon-btn`：**Add**（video → `sendCommand({name:'addClip', mediaId, in:0, duration: m.probe.duration})`；audio-only → `sendCommand({name:'setAudio', audio:[...現有 audio, 新 AudioItem]})`，start=playhead、volume 1）與 **Save to library**（`POST /api/library/from-media`，成功/已存在都 `useToast` 提示 `Saved to library` / `Already in library`）。**兩顆都不 select**。空清單 `empty-note`：`No media yet. Import from the Folder tab or ask the AI.`

- [ ] **Step 1: 寫失敗測試**（重點三條：列表渲染 doc.media；audio-only 列顯示 Add to audio 而非 Add clip；Save to library 打 `/api/library/from-media`（`vi.stubGlobal('fetch', ...)` 驗 URL 與 body、回 200 後 toast——toast 斷言看 `useToast.getState()`）。實際斷言照 `panels.test.tsx` 慣例寫。）
- [ ] **Step 2: 跑紅** → **Step 3: 實作**（`AudioItem` 形狀從 `@vidcut/shared` 讀；id 產生照 Toolbar 慣例 `au_${Math.random().toString(36).slice(2,10)}`；縮圖 div 用 `--card` 底＋`--line` 邊、寬 48 高 27（16:9 內縮）；所有間距 4 的倍數）
- [ ] **Step 4: 跑綠 + `npm run build -w @vidcut/ui`**
- [ ] **Step 5: Commit** — `feat(ui): project media zone — list, add-to-timeline, save-to-library`

---

### Task 6: 素材庫區（搜尋／上傳／匯入／標籤／刪除）

**Files:**

- Modify: `ui/src/panels/MediaPanel.tsx`（`LibraryZone` 真身；檔案若超過 ~400 行就把三區拆成 `MediaPanel/` 目錄三檔——以計畫的檔案結構原則為準，拆了要在 report 說明）
- Test: `ui/src/panels/MediaPanel.test.tsx`（新增）

**Interfaces:**

- Consumes: `GET /api/library?query=&tag=`、`POST /api/library?name=&label=&tags=`（**`body: file` 直接傳 File 物件**——不 arrayBuffer，讓瀏覽器串流；這正是後端刻意串流化的原因）、`POST /api/library/:id/import`、`PATCH`／`DELETE /api/library/:id`、`sendCommand addOverlay`（image 匯入後放 playhead、3s、頂部置中——照 Toolbar `addOverlayFile` 參數）
- Produces:
  - 頂列：`<input placeholder="Search library">`（300ms debounce 重查，模組級 timer 照 CaptionList `schedulePreview` 款式）＋上傳鈕（`<input type="file" multiple accept="video/*,audio/*,image/*,.mkv">` 隱藏、icon-btn 觸發；逐檔序列上傳，進度用 toast）
  - 卡片列（`rowline`）：縮圖（media → `/library/derived/<hash>/filmstrip.jpg` 首格、audio→icon、image → `/library/files/<hash><ext>` 本身；`<img draggable={false}>`）＋label（雙擊就地編輯 → PATCH，Enter/blur commit、Escape 取消——CaptionList 的 draft 模式照抄）＋tags（`tag` class 顯示；點 tag = 以該 tag 過濾）＋broken 標記（`color: var(--text-3)` 的 `broken` 字樣，匯入鈕 disabled）
  - 每列 icon-btn ×2：**Import**（media/audio → `POST /:id/import` 後 toast `Imported`；image → 拿 relPath 後 `sendCommand addOverlay`（start=playhead、duration 3、position {x:0.5,y:0.1,scale:1}）＋toast `Placed as overlay`；**不 select**）與 **Delete**（`window.confirm` 帶後果文案：`Delete from library? Projects referencing this file will lose it at export.` → DELETE → 重查）
  - 資料流：zone 內 `useState<LibraryListing[]>`＋`refresh()`；掛載與每次寫操作後重查。**不進 zustand store**（無跨元件消費者，遵守「fetch 散元件層」現況慣例）
- [ ] **Step 1–5**：測試（搜尋 debounce 打對 URL、上傳用 File body、image 匯入送出 addOverlay 命令——`vi.stubGlobal` fetch＋spy `ws.ts` 的 `sendCommand`（`vi.mock`）、刪除需 confirm）→ 紅 → 實作 → 綠＋build → Commit `feat(ui): library zone — search, upload, import, retag, delete`

---

### Task 7: 素材夾區（掃描＋勾選匯入＋直接入庫）

**Files:**

- Modify: `ui/src/panels/MediaPanel.tsx`（`SourceFolderZone` 真身）
- Test: `ui/src/panels/MediaPanel.test.tsx`（新增）

**Interfaces:**

- Consumes: `GET /api/source?dir=`、`POST /api/import`（body `{dir, names[], addToTimeline?}`）、Task 2 `POST /api/library/from-path`
- Produces: dir 輸入列（`mono` input＋Scan 鈕；**值存 `localStorage['vidcut.sourceDir']`**，掛載時回填自動掃）；結果列表（`rowline`：檔名＋`mono` 大小 MB＋`imported` 掛 `tag`）＋checkbox 多選＋底列 `Import selected` 鈕（POST /api/import，完成後 toast 成功/失敗數）＋每列 icon-btn `Save to library`（`POST /api/library/from-path`，path=`join` 語意在前端用 `${dir}/${name}` 組——後端 basename 消毒已存在）。錯誤（目錄不存在）顯示 `empty-note` 帶 server 錯字。**匯入後不 select。**

- [ ] **Step 1–5**：測試（掃描打對 URL、勾選匯入 body 正確、localStorage 回填）→ 紅 → 實作 → 綠＋build → Commit `feat(ui): source folder zone — scan, batch import, save-to-library`

---

### Task 8: verify:panels case + 文件同步 + 全套驗證

**Files:**

- Modify: `ui/e2e/panel-affordance.mjs`（新增 Media 分頁 cases）
- Modify: `HANDOFF.md`／`docs/ROADMAP.md`／`README.md`／`README.zh-TW.md`（素材匯入階段 2 收掉、Media 面板落地、圖片入庫）；`docs/superpowers/specs/2026-08-21-asset-library-design.md` 檔尾加**帶日期補記**（不改正文——歷史文件紀律）：「2026-08-25 補記：導言『影／音／圖』與白名單的矛盾以第二期決策收斂——圖片以 `kind:'image'` 入庫、匯入專案走 image overlay；『靜圖上主軌』另案」

**Steps:**

- [ ] **Step 1: verify:panels 加 cases**（照 `clickable(title)` 模板；先驗前置再驗目標）：切到 Media 分頁（`click('Media')`？——分頁按鈕沒有 title，定位用文字：加一個 `await evalJs` 以 `.seg` 文字找按鈕點擊，或**給三顆 zone 按鈕的既有 title**（Project media/Library/Source folder）直接 `clickable(...)` ×3；再驗 Library zone 的上傳鈕與搜尋框存在且可命中。分頁主按鈕給 `title="Media"` 以便定位——Task 4 實作時就帶上）。
      Run: `npx tsx server/src/index.ts projects/demo`（另終端）＋ `npm run build -w @vidcut/ui` ＋ `npm run verify:panels`，Expected: 全綠（含既有 cases）
- [ ] **Step 2: docs-sync-review skill** 走完整文件矩陣（上列檔案是起點不是上限）。
- [ ] **Step 3: `npm run format` → commit 格式修正 → `bash scripts/gauntlet.sh`**（期間不 commit；等 `GAUNTLET: 全數通過`）。⚠️ 第一期教訓：format 要**先 commit** 再跑 gauntlet，突變層還原會洗掉未 commit 的格式修正。
- [ ] **Step 4: Commit** — `docs: asset library phase 2 — Media panel + image kind sync`

---

## Self-Review 紀錄（計畫作者填）

- Spec 覆蓋：三區內容與按鈕逐項對照 spec §UI（專案媒體含存入素材庫、素材庫含搜尋/上傳/匯入/改標籤/刪除確認、素材夾含掃描勾選匯入與直接入庫）；本輪新決策（圖片=kind:'image'、匯入走 overlay、from-media/from-path 路由）為 spec 之外的使用者定案，記於計畫頭與 spec 補記。
- 一致性自查：`IMAGE_EXTENSIONS` 不進 `MEDIA_EXTENSIONS`（素材夾/import_media 不收圖片——素材夾區列不出圖片檔，「直接入庫」自然只作用於影音；圖片入庫走上傳鈕或 AI 的 add_to_library，**這是本期已知限制**，寫進 HANDOFF）；`importImageToProject` 單一實作、路由與 MCP 共用（T3 Step 1 重構）；Media 面板零 `select()`（T4 註解＋T5/6/7 逐條）；`LibraryListing` 型別由 shared 匯出？——**不是**，它在 `server/src/libraryStore.ts`，UI 端自行宣告最小介面型別（fetch JSON 本來就無型別保證），不要從 server workspace import（會把 node 依賴拖進 UI build）。
- 已知留白（刻意）：拖曳上傳區（僅檔案選擇器——虛線 dropzone 被 DESIGN.md 反面清單擋下，拖放互動留給有設計方案之後）；素材試聽播放器（無現成元件，首版縮圖+匯入後在播放器看）；素材夾遞迴掃描與縮圖（ROADMAP 既有「素材夾體驗」項）。
