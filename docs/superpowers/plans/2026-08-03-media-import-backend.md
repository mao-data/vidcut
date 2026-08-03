# 素材匯入 階段 1（後端能力）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 vidcut 能引用專案資料夾**外**的素材（零複製），並從素材夾挑檔匯入、直接排上主軌。

**Architecture:** `MediaAsset.path` 的語意擴充為「相對＝專案內、絕對＝外部引用」，
樞紐是 `server/src/paths.ts` 的 `resolveMediaPath()`；衍生檔（proxy/filmstrip/peaks）仍一律產在專案內，
因此 UI 預覽與 `/media/*` 靜態服務都不必改。新增 `addClip` command 走既有 `applyCommand`，
人與 AI 共用；耗時的 ffmpeg 走 `POST /api/import`，不塞進 command 層。

**Tech Stack:** Node + TypeScript、express、vitest（真 ffmpeg，不 mock）、`@vidcut/shared` 型別。

設計定案：`docs/superpowers/specs/2026-08-03-media-import-design.md`

## Global Constraints

- 任何專案狀態變更走 `applyCommand`（人）或 `aiWrite`→`applyCommand`（AI），不旁路直改 doc。
- `resolveMediaPath` 放 `server/`，**不可放 `shared/`** —— shared 會被瀏覽器打包，`node:path` 會讓 UI build 失敗。
- 衍生檔一律產在專案內的 `derived/<mediaId>/`，不論原檔在哪。
- 測試沿用專案慣例：真 ffmpeg、不 mock；測試專案用 `mkdtemp` 建在 tmp。
- 每個 Task 結束前跑 `npm test && npm run typecheck && npm run lint`，全綠才 commit。
- commit 只 stage 該 Task 動到的路徑，**不要 `git add -A`**（此工作區常有多個 session 並行）。

---

### Task 1: `resolveMediaPath` 與四處呼叫端

**Files:**
- Create: `server/src/paths.ts`
- Create: `server/test/paths.test.ts`
- Modify: `server/src/render.ts:195`、`server/src/render.ts:216`、`server/src/render.ts:411`
- Modify: `server/src/ingest.ts:32`

**Interfaces:**
- Consumes: 無
- Produces: `resolveMediaPath(projectDir: string, mediaPath: string): string`

- [ ] **Step 1: 寫失敗測試**

`server/test/paths.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { resolveMediaPath } from '../src/paths.js';

describe('resolveMediaPath', () => {
  it('相對路徑接在專案資料夾底下', () => {
    expect(resolveMediaPath('/proj', 'a.mp4')).toBe('/proj/a.mp4');
    expect(resolveMediaPath('/proj', 'assets/b.mov')).toBe('/proj/assets/b.mov');
  });

  it('絕對路徑原樣回傳，不接在專案底下', () => {
    expect(resolveMediaPath('/proj', '/Users/me/Movies/c.mp4')).toBe('/Users/me/Movies/c.mp4');
  });

  it('相對路徑中的 .. 會被正規化', () => {
    expect(resolveMediaPath('/proj/sub', '../d.mp4')).toBe('/proj/d.mp4');
  });

  it('空字串回專案資料夾本身', () => {
    expect(resolveMediaPath('/proj', '')).toBe('/proj');
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run server/test/paths.test.ts`
Expected: FAIL —— `Failed to resolve import "../src/paths.js"`

- [ ] **Step 3: 寫最小實作**

`server/src/paths.ts`：

```ts
import { isAbsolute, join } from 'node:path';

/**
 * 素材檔的實際位置。
 * 相對路徑＝專案資料夾內（既有行為）；絕對路徑＝外部引用（零複製匯入）。
 * 放在 server 而非 shared：shared 會被瀏覽器打包，引入 node:path 會讓 UI build 失敗。
 */
export function resolveMediaPath(projectDir: string, mediaPath: string): string {
  return isAbsolute(mediaPath) ? mediaPath : join(projectDir, mediaPath);
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run server/test/paths.test.ts`
Expected: PASS（4 項）

- [ ] **Step 5: 換掉四處呼叫端**

四處目前都是 `join(projectDir, <媒體路徑>)`，形狀相同：

- `server/src/render.ts:195` 與 `:411`：`join(projectDir, media.path)` → `resolveMediaPath(projectDir, media.path)`
- `server/src/render.ts:216`：`args.push('-i', join(projectDir, media.path))` → `args.push('-i', resolveMediaPath(projectDir, media.path))`
- `server/src/ingest.ts:32`：`const abs = join(projectDir, relPath);` → `const abs = resolveMediaPath(projectDir, relPath);`

兩個檔案都要加 `import { resolveMediaPath } from './paths.js';`。

**不要**改 `render.ts:504`（封面截圖的 `loc.media.proxyPath ?? loc.media.path`）以外的判斷邏輯——
只換路徑解析函式，其餘不動。該行也要換成 `resolveMediaPath`。

- [ ] **Step 6: 確認沒有漏網之魚**

Run: `grep -rn "join(projectDir, media.path)\|join(projectDir, relPath)" server/src`
Expected: 無輸出

- [ ] **Step 7: 跑全部測試**

Run: `npm test && npm run typecheck && npm run lint`
Expected: 全綠（既有測試不得退步）

- [ ] **Step 8: Commit**

```bash
git add server/src/paths.ts server/test/paths.test.ts server/src/render.ts server/src/ingest.ts
git commit -m "feat(server): resolveMediaPath 讓素材路徑可為專案外絕對路徑"
```

---

### Task 2: ingest 接受專案外絕對路徑

**Files:**
- Modify: `server/test/ingest.test.ts`
- Modify: `server/src/ingest.ts`（若 Task 1 已足夠則只補註解）

**Interfaces:**
- Consumes: `resolveMediaPath(projectDir, mediaPath)`
- Produces: `ingestMedia(store, projectDir, relPath, opts?)` 的 `relPath` 參數現在也接受絕對路徑；
  回傳 `mediaId`，且 `store.doc.media` 中該筆的 `path` 原樣保存傳入值。

- [ ] **Step 1: 寫失敗測試**

加到 `server/test/ingest.test.ts`（沿用該檔既有的 fixture 產生方式；若該檔目前用某支測試影片，
沿用同一支，只是把它放到專案資料夾**外**）：

```ts
it('可以 ingest 專案資料夾外的絕對路徑，原檔不被複製', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'vidcut-outside-'));
  const src = join(outside, 'external.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=30:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', src,
  ]);

  const dir = await mkdtemp(join(tmpdir(), 'vidcut-proj-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
  const id = await ingestMedia(store, dir, src);

  const m = store.doc.media.find((x) => x.id === id)!;
  expect(m.path).toBe(src);                                  // 絕對路徑原樣保存
  expect(existsSync(join(dir, 'external.mp4'))).toBe(false);  // 沒有複製進專案
  expect(m.proxyPath).toBeDefined();
  expect(existsSync(join(dir, m.proxyPath!))).toBe(true);     // 衍生檔仍在專案內
});

it('同一個絕對路徑重複 ingest 回同一個 id', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'vidcut-outside2-'));
  const src = join(outside, 'dup.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=30:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', src,
  ]);
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-proj2-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
  const a = await ingestMedia(store, dir, src);
  const b = await ingestMedia(store, dir, src);
  expect(b).toBe(a);
  expect(store.doc.media).toHaveLength(1);
});
```

檔頭需要的 import：`existsSync` 來自 `node:fs`、`runFfmpeg` 來自 `../src/ffmpeg.js`。

- [ ] **Step 2: 跑測試確認失敗或通過**

Run: `npx vitest run server/test/ingest.test.ts`

Task 1 若已把 `ingest.ts:32` 換成 `resolveMediaPath`，這兩項**可能直接通過** —— 那也要跑，
用來證明 Task 1 的改動確實達成了這個行為。若失敗，訊息會是 probe 找不到檔（路徑被拼成 `/proj/Users/...`）。

- [ ] **Step 3: 若失敗才改實作**

確認 `server/src/ingest.ts` 的 `const abs = resolveMediaPath(projectDir, relPath);`
且 `derivedRel` 仍是 `join('derived', id)`（相對專案），不受 `relPath` 影響。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run server/test/ingest.test.ts`
Expected: PASS

- [ ] **Step 5: 加 render 迴歸測**

這是 `resolveMediaPath` 最關鍵的迴歸點：輸出走原檔而非 proxy，路徑解析錯了會直接炸。
加到 `server/test/render.test.ts`（若無此檔則新建，import 沿用其他 server 測試的寫法）：

```ts
it('輸出吃專案外絕對路徑的素材', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'vidcut-ext-render-'));
  const src = join(outside, 'ext.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=30:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', src,
  ]);
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-ext-proj-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
  const mediaId = await ingestMedia(store, dir, src);
  store.mutate('ai', 'seed', (d) => {
    d.tracks.video = [{ id: 'c1', mediaId, in: 0, duration: 1, volume: 1 }];
  });

  const out = await render(store, dir, { width: 180, height: 320 });
  expect(existsSync(join(dir, out))).toBe(true);
});
```

`render()` 的實際簽名以 `server/src/render.ts` 的 export 為準；若參數形狀不同，
照該檔的簽名調整呼叫，**斷言不變**（輸出檔存在）。

- [ ] **Step 6: 跑測試確認通過**

Run: `npm test`
Expected: 全綠

- [ ] **Step 7: Commit**

```bash
git add server/test/ingest.test.ts server/test/render.test.ts server/src/ingest.ts
git commit -m "test(server): ingest 與 render 吃專案外絕對路徑的迴歸測"
```

---

### Task 3: `addClip` command

**Files:**
- Modify: `shared/src/types.ts`（`Command` union）
- Modify: `server/src/commands.ts`
- Modify: `server/test/commands.test.ts`

**Interfaces:**
- Consumes: 無
- Produces: Command variant `{ name: 'addClip'; mediaId: string; in: number; duration: number; label?: string }`，
  經 `applyCommand(store, source, cmd)` 套用，append 到 `store.doc.tracks.video` 尾端，
  新 clip 的 `id` 由 `nanoid(6)` 產生、`volume` 預設 1。

- [ ] **Step 1: 寫失敗測試**

加到 `server/test/commands.test.ts`（沿用該檔既有的 `storeWithClips()`，
它已 seed `m1`/`m2` 兩支 20 秒素材與 `c1`/`c2` 兩個片段）：

```ts
describe('addClip', () => {
  it('append 到主軌尾端', async () => {
    const store = await storeWithClips();
    const before = store.doc.tracks.video.length;
    const r = applyCommand(store, 'human', { name: 'addClip', mediaId: 'm1', in: 0, duration: 3 });
    expect(r.ok).toBe(true);
    const clips = store.doc.tracks.video;
    expect(clips).toHaveLength(before + 1);
    expect(clips[clips.length - 1]).toMatchObject({ mediaId: 'm1', in: 0, duration: 3, volume: 1 });
    expect(clips[clips.length - 1]!.id).toBeTruthy();
  });

  it('未知 mediaId 被拒絕', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', { name: 'addClip', mediaId: 'nope', in: 0, duration: 3 });
    expect(r.ok).toBe(false);
  });

  it('duration <= 0 被拒絕', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', { name: 'addClip', mediaId: 'm1', in: 0, duration: 0 });
    expect(r.ok).toBe(false);
  });

  it('in + duration 超出素材長度被拒絕', async () => {
    const store = await storeWithClips();
    // m1 全長 20 秒
    const r = applyCommand(store, 'human', { name: 'addClip', mediaId: 'm1', in: 18, duration: 5 });
    expect(r.ok).toBe(false);
  });

  it('剛好用滿素材長度是允許的', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', { name: 'addClip', mediaId: 'm1', in: 0, duration: 20 });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run server/test/commands.test.ts -t addClip`
Expected: FAIL —— TypeScript 會抱怨 `addClip` 不在 `Command` union 內

- [ ] **Step 3: 加 Command variant**

`shared/src/types.ts`，加在 `removeClip` 那一行後面：

```ts
  /** 新增一段畫面到主軌尾端（人從素材庫加入；AI 通常用 set_timeline 整組排） */
  | { name: 'addClip'; mediaId: string; in: number; duration: number; label?: string }
```

- [ ] **Step 4: 加 handler**

`server/src/commands.ts`，在 `case 'removeClip':` 後面加：

```ts
    case 'addClip':
      return addClip(store, source, cmd);
```

並在 `addOverlay` 函式附近加（沿用同檔既有的驗證風格）：

```ts
function addClip(
  store: ProjectStore,
  source: MutationSource,
  cmd: Extract<Command, { name: 'addClip' }>,
): CommandResult {
  const media = store.doc.media.find((m) => m.id === cmd.mediaId);
  if (!media) return { ok: false, error: `media not found: ${cmd.mediaId}` };
  if (cmd.duration <= 0) return { ok: false, error: 'clip duration must be > 0' };
  if (cmd.in < 0) return { ok: false, error: 'clip in must be >= 0' };
  if (cmd.in + cmd.duration > media.probe.duration + 1e-6) {
    return { ok: false, error: `clip out of bounds for ${cmd.mediaId}` };
  }
  return ok(
    store.mutate(source, `add clip ${cmd.label ?? cmd.mediaId}`, (d) => {
      d.tracks.video.push({
        id: nanoid(6),
        mediaId: cmd.mediaId,
        in: cmd.in,
        duration: cmd.duration,
        volume: 1,
        ...(cmd.label ? { label: cmd.label } : {}),
      });
    }),
  );
}
```

`1e-6` 的容差與 `mcp.ts` 的 `set_timeline` 邊界檢查一致，避免浮點誤差誤擋「剛好用滿」。

- [ ] **Step 5: 跑測試確認通過**

Run: `npx vitest run server/test/commands.test.ts -t addClip`
Expected: PASS（5 項）

- [ ] **Step 6: 跑全部測試**

Run: `npm test && npm run typecheck && npm run lint`
Expected: 全綠

- [ ] **Step 7: Commit**

```bash
git add shared/src/types.ts server/src/commands.ts server/test/commands.test.ts
git commit -m "feat(commands): addClip 把素材接到主軌尾端"
```

---

### Task 4: `scanSourceFolder`

**Files:**
- Create: `server/src/sourceFolder.ts`
- Create: `server/test/sourceFolder.test.ts`

**Interfaces:**
- Consumes: 無
- Produces:
  - `export interface SourceFile { name: string; size: number; mtime: number }`
  - `scanSourceFolder(dir: string): Promise<SourceFile[]>` —— 依 `name` 升冪排序
  - `export const MEDIA_EXTENSIONS: readonly string[]`

- [ ] **Step 1: 寫失敗測試**

`server/test/sourceFolder.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSourceFolder } from '../src/sourceFolder.js';

async function folderWith(names: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-src-'));
  for (const n of names) await writeFile(join(dir, n), 'x');
  return dir;
}

describe('scanSourceFolder', () => {
  it('只回白名單副檔名，依檔名排序', async () => {
    const dir = await folderWith(['b.mp4', 'a.mov', 'notes.txt', 'song.mp3']);
    const files = await scanSourceFolder(dir);
    expect(files.map((f) => f.name)).toEqual(['a.mov', 'b.mp4', 'song.mp3']);
  });

  it('副檔名比對不分大小寫', async () => {
    const dir = await folderWith(['A.MP4', 'B.MoV']);
    const files = await scanSourceFolder(dir);
    expect(files.map((f) => f.name)).toEqual(['A.MP4', 'B.MoV']);
  });

  it('排除隱藏檔', async () => {
    const dir = await folderWith(['.hidden.mp4', 'visible.mp4']);
    const files = await scanSourceFolder(dir);
    expect(files.map((f) => f.name)).toEqual(['visible.mp4']);
  });

  it('不遞迴子資料夾', async () => {
    const dir = await folderWith(['top.mp4']);
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'deep.mp4'), 'x');
    const files = await scanSourceFolder(dir);
    expect(files.map((f) => f.name)).toEqual(['top.mp4']);
  });

  it('帶回檔案大小與 mtime', async () => {
    const dir = await folderWith(['a.mp4']);
    const [f] = await scanSourceFolder(dir);
    expect(f!.size).toBeGreaterThan(0);
    expect(f!.mtime).toBeGreaterThan(0);
  });

  it('目錄不存在時丟錯', async () => {
    await expect(scanSourceFolder('/definitely/not/here')).rejects.toThrow();
  });

  it('傳入的是檔案而非目錄時丟錯', async () => {
    const dir = await folderWith(['a.mp4']);
    await expect(scanSourceFolder(join(dir, 'a.mp4'))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run server/test/sourceFolder.test.ts`
Expected: FAIL —— `Failed to resolve import "../src/sourceFolder.js"`

- [ ] **Step 3: 寫最小實作**

`server/src/sourceFolder.ts`：

```ts
import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

/** 可匯入的副檔名（小寫比對）。影片與音訊都收，音訊可放旁白／BGM。 */
export const MEDIA_EXTENSIONS = [
  '.mp4', '.mov', '.m4v', '.webm', '.mkv',
  '.mp3', '.m4a', '.wav', '.aac',
] as const;

export interface SourceFile {
  name: string;
  size: number;
  /** epoch ms */
  mtime: number;
}

/**
 * 列出素材夾內可匯入的檔案。不遞迴、排除隱藏檔、依檔名排序。
 * 目錄不存在或不是目錄時丟錯（由呼叫端轉成 400）。
 */
export async function scanSourceFolder(dir: string): Promise<SourceFile[]> {
  const info = await stat(dir); // 不存在會丟 ENOENT
  if (!info.isDirectory()) throw new Error(`not a directory: ${dir}`);

  const entries = await readdir(dir, { withFileTypes: true });
  const out: SourceFile[] = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    if (!MEDIA_EXTENSIONS.includes(extname(e.name).toLowerCase() as (typeof MEDIA_EXTENSIONS)[number])) {
      continue;
    }
    const s = await stat(join(dir, e.name));
    out.push({ name: e.name, size: s.size, mtime: s.mtimeMs });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run server/test/sourceFolder.test.ts`
Expected: PASS（7 項）

- [ ] **Step 5: 跑全部測試**

Run: `npm test && npm run typecheck && npm run lint`
Expected: 全綠

- [ ] **Step 6: Commit**

```bash
git add server/src/sourceFolder.ts server/test/sourceFolder.test.ts
git commit -m "feat(server): scanSourceFolder 列出素材夾內可匯入的檔案"
```

---

### Task 5: `GET /api/source`

**Files:**
- Modify: `server/src/app.ts`
- Create: `server/test/source-api.test.ts`

**Interfaces:**
- Consumes: `scanSourceFolder(dir)`、`resolveMediaPath(projectDir, path)`
- Produces: `GET /api/source?dir=<絕對路徑>` →
  `200 { dir, files: [{ name, size, mtime, imported: boolean }] }` 或 `400 { error }`

- [ ] **Step 1: 寫失敗測試**

`server/test/source-api.test.ts`。**這個專案沒有裝 supertest** —— 沿用
`server/test/assets-upload.test.ts` 的做法：`http.createServer(createApp(...))` 起在隨機埠，用真 `fetch` 打：

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { ProjectStore } from '../src/store.js';
import { createApp } from '../src/app.js';

async function startTestServer() {
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-source-api-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
  const server: Server = createServer(createApp(store, dir));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { dir, store, server, base: `http://127.0.0.1:${port}` };
}

interface SourceRes {
  dir: string;
  files: Array<{ name: string; size: number; mtime: number; imported: boolean }>;
}

describe('GET /api/source', () => {
  it('列出素材夾內的可匯入檔案', async () => {
    const { server, base } = await startTestServer();
    const src = await mkdtemp(join(tmpdir(), 'vidcut-api-src-'));
    await writeFile(join(src, 'a.mp4'), 'x');
    await writeFile(join(src, 'readme.txt'), 'x');

    const res = await fetch(`${base}/api/source?dir=${encodeURIComponent(src)}`);
    expect(res.status).toBe(200);
    const j = (await res.json()) as SourceRes;
    expect(j.files.map((f) => f.name)).toEqual(['a.mp4']);
    expect(j.files[0]!.imported).toBe(false);
    server.close();
  });

  it('已匯入的檔案標記 imported', async () => {
    const { store, server, base } = await startTestServer();
    const src = await mkdtemp(join(tmpdir(), 'vidcut-api-src2-'));
    await writeFile(join(src, 'a.mp4'), 'x');
    store.mutate('ai', 'seed', (d) => {
      d.media = [
        {
          id: 'm1',
          path: join(src, 'a.mp4'),
          probe: { duration: 5, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
    });

    const res = await fetch(`${base}/api/source?dir=${encodeURIComponent(src)}`);
    const j = (await res.json()) as SourceRes;
    expect(j.files[0]!.imported).toBe(true);
    server.close();
  });

  it('目錄不存在回 400', async () => {
    const { server, base } = await startTestServer();
    const res = await fetch(`${base}/api/source?dir=/definitely/not/here`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
    server.close();
  });

  it('沒帶 dir 回 400', async () => {
    const { server, base } = await startTestServer();
    const res = await fetch(`${base}/api/source`);
    expect(res.status).toBe(400);
    server.close();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run server/test/source-api.test.ts`
Expected: FAIL —— 404（路由不存在）

- [ ] **Step 3: 加路由**

`server/src/app.ts`，在 `app.get('/api/project', ...)` 之後加：

```ts
  // 素材夾掃描（零複製匯入的挑檔來源）。綁 127.0.0.1，故不做根目錄白名單，
  // 但仍只回白名單副檔名、排除隱藏檔、不遞迴。
  app.get('/api/source', (req, res, next) => {
    void (async () => {
      const dir = typeof req.query.dir === 'string' ? req.query.dir : '';
      if (!dir) {
        res.status(400).json({ error: 'need ?dir=' });
        return;
      }
      try {
        const files = await scanSourceFolder(dir);
        const imported = new Set(
          store.doc.media.map((m) => resolveMediaPath(projectDir, m.path)),
        );
        res.json({
          dir,
          files: files.map((f) => ({ ...f, imported: imported.has(join(dir, f.name)) })),
        });
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
      }
    })().catch(next);
  });
```

檔頭補 import：

```ts
import { scanSourceFolder } from './sourceFolder.js';
import { resolveMediaPath } from './paths.js';
```

（`join` 與 `basename`/`extname` 該檔已從 `node:path` 匯入，確認 `join` 在其中。）

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run server/test/source-api.test.ts`
Expected: PASS（4 項）

- [ ] **Step 5: 跑全部測試**

Run: `npm test && npm run typecheck && npm run lint`
Expected: 全綠

- [ ] **Step 6: Commit**

```bash
git add server/src/app.ts server/test/source-api.test.ts
git commit -m "feat(server): GET /api/source 掃描素材夾"
```

---

### Task 6: `POST /api/import` 與 MCP `import_media` 更新

**Files:**
- Modify: `server/src/app.ts`
- Modify: `server/src/mcp.ts:243-263`（`import_media` 的 description）
- Create: `server/test/import-api.test.ts`

**Interfaces:**
- Consumes: `scanSourceFolder`、`ingestMedia(store, projectDir, absPath, opts?)`、
  `applyCommand(store, 'human', { name: 'addClip', ... })`
- Produces: `POST /api/import`
  body `{ dir: string; names: string[]; addToTimeline?: boolean }` →
  `200 { ok: [{ name, mediaId }], failed: [{ name, error }] }`；`dir` 或 `names` 缺漏回 `400 { error }`

- [ ] **Step 1: 寫失敗測試**

`server/test/import-api.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { ProjectStore } from '../src/store.js';
import { createApp } from '../src/app.js';
import { runFfmpeg } from '../src/ffmpeg.js';

async function startTestServer() {
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-imp-proj-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
  const src = await mkdtemp(join(tmpdir(), 'vidcut-imp-src-'));
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=30:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(src, 'a.mp4'),
  ]);
  const server: Server = createServer(createApp(store, dir));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { dir, store, src, server, base: `http://127.0.0.1:${port}` };
}

interface ImportRes {
  ok: Array<{ name: string; mediaId: string }>;
  failed: Array<{ name: string; error: string }>;
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/import', () => {
  it('匯入後素材進 doc.media 且原檔不被複製', async () => {
    const { store, src, server, base } = await startTestServer();
    const res = await post(base, { dir: src, names: ['a.mp4'] });
    expect(res.status).toBe(200);
    const j = (await res.json()) as ImportRes;
    expect(j.failed).toEqual([]);
    expect(j.ok).toHaveLength(1);
    const m = store.doc.media.find((x) => x.id === j.ok[0]!.mediaId)!;
    expect(m.path).toBe(join(src, 'a.mp4'));
    expect(store.doc.tracks.video).toHaveLength(0); // 預設不排上時間軸
    server.close();
  });

  it('addToTimeline 會把整支接到主軌尾端', async () => {
    const { store, src, server, base } = await startTestServer();
    const res = await post(base, { dir: src, names: ['a.mp4'], addToTimeline: true });
    expect(res.status).toBe(200);
    expect(store.doc.tracks.video).toHaveLength(1);
    const clip = store.doc.tracks.video[0]!;
    expect(clip.in).toBe(0);
    expect(clip.duration).toBeCloseTo(2, 0);
    server.close();
  });

  it('壞檔進 failed，其餘繼續', async () => {
    const { src, server, base } = await startTestServer();
    const res = await post(base, { dir: src, names: ['a.mp4', 'missing.mp4'] });
    expect(res.status).toBe(200);
    const j = (await res.json()) as ImportRes;
    expect(j.ok).toHaveLength(1);
    expect(j.failed).toHaveLength(1);
    expect(j.failed[0]!.name).toBe('missing.mp4');
    server.close();
  });

  it('沒帶 dir 或 names 回 400', async () => {
    const { src, server, base } = await startTestServer();
    expect((await post(base, { names: ['a.mp4'] })).status).toBe(400);
    expect((await post(base, { dir: src })).status).toBe(400);
    server.close();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run server/test/import-api.test.ts`
Expected: FAIL —— 404（路由不存在）

- [ ] **Step 3: 加路由**

`server/src/app.ts`，在 `/api/source` 之後加：

```ts
  // 匯入素材：零複製引用原檔，只在專案內產衍生檔。
  // ffmpeg 一支動輒數秒到數分鐘，逐支序列處理（並行只會互搶 CPU）。
  app.post('/api/import', (req, res, next) => {
    void (async () => {
      const { dir, names, addToTimeline } = req.body as {
        dir?: string;
        names?: string[];
        addToTimeline?: boolean;
      };
      if (!dir || !Array.isArray(names) || names.length === 0) {
        res.status(400).json({ error: 'need dir and names[]' });
        return;
      }
      const ok: Array<{ name: string; mediaId: string }> = [];
      const failed: Array<{ name: string; error: string }> = [];
      for (const name of names) {
        try {
          const abs = join(dir, basename(name)); // basename 防 traversal
          const mediaId = await ingestMedia(store, projectDir, abs, { label: name });
          if (addToTimeline) {
            const media = store.doc.media.find((m) => m.id === mediaId)!;
            const r = applyCommand(store, 'human', {
              name: 'addClip',
              mediaId,
              in: 0,
              duration: media.probe.duration,
              label: name,
            });
            if (!r.ok) throw new Error(r.error);
          }
          ok.push({ name, mediaId });
        } catch (e) {
          failed.push({ name, error: (e as Error).message });
        }
      }
      res.json({ ok, failed });
    })().catch(next);
  });
```

檔頭補 import：

```ts
import { ingestMedia } from './ingest.js';
import { applyCommand } from './commands.js';
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run server/test/import-api.test.ts`
Expected: PASS（4 項）

- [ ] **Step 5: 更新 MCP `import_media` 的說明**

`server/src/mcp.ts:246`，description 改成：

```ts
      description:
        '登記素材檔並產生 proxy/filmstrip/peaks。relPath 可為專案內相對路徑，' +
        '也可為專案外的絕對路徑（零複製引用，原檔留在原地）。回 mediaId。',
```

同時把 `server/src/mcp.ts:140` 的 server instructions 中「import_media 匯入素材」該句
補上「（可直接引用專案外的絕對路徑）」。

- [ ] **Step 6: 跑全部測試**

Run: `npm test && npm run typecheck && npm run lint && npm run format:check`
Expected: 全綠（`format:check` 若只抓到 `ui/coverage/*.json` 可忽略，那是產生檔）

- [ ] **Step 7: 手動驗一次真實流程**

```bash
npx tsx server/src/index.ts projects/demo
```
另開一個 shell：
```bash
curl -s "http://127.0.0.1:3845/api/source?dir=$HOME/Movies" | head -c 400
```
Expected: 回你 `~/Movies` 內的影音檔清單（若該資料夾為空，換一個有影片的資料夾）。

- [ ] **Step 8: Commit**

```bash
git add server/src/app.ts server/src/mcp.ts server/test/import-api.test.ts
git commit -m "feat(server): POST /api/import 零複製匯入素材夾選取的檔案"
```

---

### Task 7: 失敗清理與缺檔預檢

spec「錯誤處理」中的兩項，前六個 Task 都沒涵蓋。

**Files:**
- Modify: `server/src/ingest.ts`
- Modify: `server/src/render.ts`
- Modify: `server/test/ingest.test.ts`
- Modify: `server/test/render.test.ts`

**Interfaces:**
- Consumes: `resolveMediaPath(projectDir, mediaPath)`
- Produces: 無新公開介面；`ingestMedia` 失敗時不留 `derived/<id>/`；
  `render()` 在啟動 ffmpeg 前對缺檔丟 `Error`，訊息含缺少的路徑。

- [ ] **Step 1: 寫失敗測試 —— ingest 失敗要清掉半成品**

加到 `server/test/ingest.test.ts`：

```ts
it('ingest 失敗不留下半成品 derived 目錄', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'vidcut-bad-'));
  const bad = join(outside, 'not-a-video.mp4');
  await writeFile(bad, 'this is not a video');

  const dir = await mkdtemp(join(tmpdir(), 'vidcut-bad-proj-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));

  await expect(ingestMedia(store, dir, bad)).rejects.toThrow();
  expect(store.doc.media).toHaveLength(0);
  // derived 下不應留任何目錄
  const derived = join(dir, 'derived');
  const left = existsSync(derived) ? await readdir(derived) : [];
  expect(left).toEqual([]);
});
```

檔頭需要 `writeFile`、`readdir`（`node:fs/promises`）與 `existsSync`（`node:fs`）。

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx vitest run server/test/ingest.test.ts -t 半成品`
Expected: FAIL —— `derived/<id>` 目錄殘留（probe 或 proxy 失敗後沒清）

- [ ] **Step 3: 實作清理**

`server/src/ingest.ts`：把建立 `derivedAbs` 之後的所有步驟包進 try/catch，失敗時移除該目錄再往外丟：

```ts
  await mkdir(derivedAbs, { recursive: true });
  try {
    // …既有的 proxy / filmstrip / peaks 三段與最後寫入 store.doc.media 的程式碼原樣移入…
  } catch (e) {
    await rm(derivedAbs, { recursive: true, force: true });
    throw e;
  }
```

檔頭 `node:fs/promises` 的 import 補上 `rm`。
**注意**：`probe(abs)` 在 `mkdir` 之前就會丟錯（檔案不存在或不是影片），
那條路徑本來就不會建目錄，不需額外處理。

- [ ] **Step 4: 跑測試確認通過**

Run: `npx vitest run server/test/ingest.test.ts`
Expected: PASS

- [ ] **Step 5: 寫失敗測試 —— 輸出前的缺檔預檢**

加到 `server/test/render.test.ts`：

```ts
it('素材原檔不見時，輸出丟出含路徑的明確錯誤', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'vidcut-gone-'));
  const src = join(outside, 'gone.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=30:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', src,
  ]);
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-gone-proj-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
  const mediaId = await ingestMedia(store, dir, src);
  store.mutate('ai', 'seed', (d) => {
    d.tracks.video = [{ id: 'c1', mediaId, in: 0, duration: 1, volume: 1 }];
  });

  await rm(src); // 原檔被移走／刪除

  await expect(render(store, dir, { width: 180, height: 320 })).rejects.toThrow(/gone\.mp4/);
});
```

- [ ] **Step 6: 跑測試確認失敗**

Run: `npx vitest run server/test/render.test.ts -t 不見`
Expected: FAIL —— 目前會是 ffmpeg 的原始錯誤訊息，不含缺少的檔名，或錯誤形狀不同

- [ ] **Step 7: 實作預檢**

`server/src/render.ts`，在組 ffmpeg 參數**之前**加一段：

```ts
  // 零複製引用的素材可能被移走。先檢查，給出比 ffmpeg 原始輸出更明確的錯誤。
  const missing = project.media
    .filter((m) => project.tracks.video.some((c) => c.mediaId === m.id)
                || project.tracks.audio.some((a) => a.mediaId === m.id))
    .map((m) => resolveMediaPath(projectDir, m.path))
    .filter((p) => !existsSync(p));
  if (missing.length > 0) {
    throw new Error(`render: 找不到素材原檔：${missing.join(', ')}`);
  }
```

檔頭補 `import { existsSync } from 'node:fs';`（若尚未 import）。

- [ ] **Step 8: 跑測試確認通過**

Run: `npx vitest run server/test/render.test.ts`
Expected: PASS

- [ ] **Step 9: 跑全部測試**

Run: `npm test && npm run typecheck && npm run lint`
Expected: 全綠

- [ ] **Step 10: Commit**

```bash
git add server/src/ingest.ts server/src/render.ts server/test/ingest.test.ts server/test/render.test.ts
git commit -m "fix(server): ingest 失敗清理半成品、輸出前預檢缺檔"
```

---

## 完成後

階段 1 完成即可透過 MCP 使用：`import_media` 傳絕對路徑 → `addClip`（或 `set_timeline`）排片。
階段 2（素材庫面板）另開計畫，屆時參考 `docs/superpowers/specs/2026-08-03-media-import-design.md`
的「階段 2」與「錯誤處理」兩節。

實作中若發現 spec 與現實不符（例如 `render()` 的實際簽名與計畫中的呼叫不同），
**先回報再改**，不要默默偏離設計。
