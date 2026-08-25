# 跨專案素材庫 第一期（庫核心）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地跨專案素材庫的後端全套（LibraryStore、入庫、匯入專案、HTTP 路由、四支 MCP 工具），做完 AI 即可透過 MCP 使用完整素材庫，不必等 UI。

**Architecture:** 素材庫是伺服器上獨立於任何專案的目錄（預設 `~/.vidcut/library/`，`VIDCUT_LIBRARY_DIR` 覆寫）：`library.json` 索引 + `files/<sha256>.<ext>` 內容定址原檔 + `derived/<sha256>/` 可拋棄快取。庫→專案沿用既有零複製絕對路徑引用（`resolveMediaPath` 不改）；庫檔內容定址永不搬家，所以引用不斷鏈。庫變更走 `LibraryStore.mutate()`（不進 undo、不走 Command）；登記進專案沿用既有 `registerMedia`。

**Tech Stack:** Node + TypeScript（三 workspace monorepo）、express、zod、@modelcontextprotocol/sdk、vitest（真 ffmpeg）、immer（僅專案 store，庫 store 不用）。

**Spec:** `docs/superpowers/specs/2026-08-21-asset-library-design.md`（執行前先讀全文）

**第二期（Media 面板 UI）不在本計畫**：等本計畫落地後另寫獨立計畫（需另讀 `ui/DESIGN.md` 與面板慣例）。

## Global Constraints

- 工作目錄是 `ai-video-cut/`；所有指令在該目錄執行。若在新 worktree 工作，**第一件事 `npm install`**，並自檢 `ls -l node_modules/@vidcut/shared` 指向本 worktree 的 `shared`（CLAUDE.md 的 worktree 鐵則，違反則所有測試數字作廢）。
- **不要 `git add -A`**；只 stage 自己動過的路徑。commit 訊息結尾帶 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- MCP 三步鐵則：改了 `server/src/mcp.ts` 的工具面，`server/test/mcp-surface-snapshot.test.ts` 必紅——**先讀 diff 確認新描述屬實，再 `-u` 更新**。
- `bash scripts/gauntlet.sh` 跑的時候不要 commit（突變層會故意改壞工作樹）。
- 型別 JSON-safe：不得出現 `Infinity`/`undefined` 落盤（`shared/src/types.ts` 檔頭規則）。
- 測試暫存目錄一律用 `server/test/tmp.ts` 的 `tmpDir(prefix)`，不要裸 `mkdtemp`。
- 註解語言與密度跟隨周邊程式碼（繁中、講「為什麼」不講「做什麼」）。
- `projects/*/.env` 與密鑰不得提交或印出。

---

### Task 1: 從 `prepareMedia` 抽出 `buildDerivatives`（重構）

庫入庫與專案 ingest 要共用同一套 ffmpeg 衍生檔管線（proxy/filmstrip/peaks），先把它從 `prepareMedia` 抽成獨立函式。**行為保持不變，靠既有測試守。**

**Files:**
- Modify: `server/src/ingest.ts`
- Test: 既有 `server/test/ingest.test.ts`（不新增測試——這是行為保持的重構）

**Interfaces:**
- Produces: `export async function buildDerivatives(abs: string, derivedAbs: string, info: ProbeInfo): Promise<{ audioOnly: boolean }>` —— 在 `derivedAbs` 產 `proxy.mp4`（audio-only 跳過）、`filmstrip.jpg`（audio-only 跳過）、`peaks.json`；無可用串流丟錯（在 mkdir 之前）；失敗時自己 `rm derivedAbs` 再 rethrow。Task 3、4 消費它。

- [ ] **Step 1: 綠色基線**

Run: `npm test -w @vidcut/server -- ingest`
Expected: PASS（記下通過數字）

- [ ] **Step 2: 抽函式**

在 `server/src/ingest.ts` 把 `prepareMedia` 的 ffmpeg 主體（audioOnly 判定、mkdir、proxy、filmstrip、peaks、失敗清理）搬進新函式。搬的是**原始碼原文**，只把錯誤訊息裡的 `relPath` 換成 `abs`、`try/catch` 的清理移進來：

```ts
import type { MediaAsset, ProbeInfo } from '@vidcut/shared';

/**
 * 在 derivedAbs 產出衍生檔（proxy / filmstrip / peaks）。專案 ingest 與素材庫入庫
 * 共用（spec 2026-08-21 素材庫）。audio-only 只產 peaks。
 * 「無可用串流直接丟錯」刻意排在 mkdir 之前——不留空的 derived 目錄；
 * 中途失敗把整個 derivedAbs 清掉再 rethrow（呼叫端不必自己收拾）。
 * 產出順序 proxy → filmstrip → peaks：peaks.json 是最後一步，所以
 * **peaks.json 存在 ⇒ 這組衍生檔完整**（prepareFromLibrary 靠這個哨兵判斷）。
 */
export async function buildDerivatives(
  abs: string,
  derivedAbs: string,
  info: ProbeInfo,
): Promise<{ audioOnly: boolean }> {
  const audioOnly = info.hasVideo === false;
  if (audioOnly && !info.hasAudio) throw new Error(`no usable stream in ${abs}`);
  await mkdir(derivedAbs, { recursive: true });
  try {
    // …原 prepareMedia 的 1. proxy、2. filmstrip、3. peaks 三段原文搬入…
    return { audioOnly };
  } catch (e) {
    await rm(derivedAbs, { recursive: true, force: true });
    throw e;
  }
}
```

`prepareMedia` 瘦身成：

```ts
export async function prepareMedia(
  store: ProjectStore,
  projectDir: string,
  relPath: string,
  opts: IngestOpts = {},
): Promise<PreparedMedia> {
  const wanted = resolveMediaPath(projectDir, relPath);
  const existing = store.doc.media.find((m) => resolveMediaPath(projectDir, m.path) === wanted);
  if (existing) return { existingId: existing.id };

  const abs = resolveMediaPath(projectDir, relPath);
  const info = await probe(abs);
  const id = nanoid(8);
  const derivedRel = join('derived', id);
  const { audioOnly } = await buildDerivatives(abs, join(projectDir, derivedRel), info);
  const asset: MediaAsset = {
    id,
    path: relPath,
    ...(audioOnly
      ? {}
      : {
          proxyPath: join(derivedRel, 'proxy.mp4'),
          filmstripPath: join(derivedRel, 'filmstrip.jpg'),
        }),
    peaksPath: join(derivedRel, 'peaks.json'),
    probe: info,
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.meta ? { meta: opts.meta } : {}),
  };
  return { asset };
}
```

原 `prepareMedia` 開頭的函式註解（冪等判斷用解析後絕對路徑那段）保留在 `prepareMedia` 上；衍生檔細節的註解跟著搬去 `buildDerivatives`。

- [ ] **Step 3: 驗證行為不變**

Run: `npm test -w @vidcut/server -- ingest && npm run typecheck`
Expected: PASS，數字與 Step 1 相同

- [ ] **Step 4: Commit**

```bash
git add server/src/ingest.ts
git commit -m "refactor: extract buildDerivatives from prepareMedia for library reuse"
```

---

### Task 2: `LibraryAsset` 型別 + `LibraryStore`

**Files:**
- Modify: `shared/src/types.ts`（`PeaksFile` 之後加 `LibraryAsset`）
- Create: `server/src/libraryStore.ts`
- Test: `server/test/libraryStore.test.ts`

**Interfaces:**
- Consumes: 無（純新增）
- Produces（Task 3–6 消費）:
  - `shared`: `interface LibraryAsset { id: string; kind: 'media'; hash: string; file: string; probe: ProbeInfo; label: string; tags: string[]; origin: { type: 'upload' | 'project' | 'source'; note?: string }; addedAt: string; meta?: Record<string, unknown> }`
  - `LibraryStore.load(dir: string): Promise<LibraryStore>`（索引損毀時丟錯——呼叫端降級）
  - `get dir(): string`、`get(id): LibraryAsset | undefined`、`byHash(hash): LibraryAsset | undefined`
  - `fileAbs(a): string`、`derivedAbs(a): string`
  - `list(f?: { query?: string; tag?: string; kind?: 'media' }): LibraryListing[]`，`type LibraryListing = LibraryAsset & { broken: boolean }`
  - `updateAsset(id, patch: { label?: string; tags?: string[] }): Promise<LibraryAsset>`（id 不存在丟 `no library asset <id>`）
  - `removeAsset(id): Promise<void>`（同上錯誤字樣；連 files/ 與 derived/ 一起清）
  - `mutate(fn: (assets: LibraryAsset[]) => void): Promise<void>`

- [ ] **Step 1: 寫失敗測試**

`server/test/libraryStore.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LibraryAsset } from '@vidcut/shared';
import { LibraryStore } from '../src/libraryStore.js';
import { tmpDir } from './tmp.js';

const fakeAsset = (over: Partial<LibraryAsset> = {}): LibraryAsset => ({
  id: `lib-${Math.random().toString(36).slice(2, 10)}`,
  kind: 'media',
  hash: 'a'.repeat(64),
  file: `files/${'a'.repeat(64)}.mp4`,
  probe: { duration: 2, width: 320, height: 568, fps: 30, hasAudio: true, rotation: 0 },
  label: '片頭 v2',
  tags: ['intro'],
  origin: { type: 'upload' },
  addedAt: '2026-08-21T00:00:00.000Z',
  ...over,
});

describe('LibraryStore', () => {
  it('load 建出 files/ 與 derived/，空庫回空清單', async () => {
    const dir = await tmpDir('vidcut-lib-');
    const lib = await LibraryStore.load(dir);
    expect(existsSync(join(dir, 'files'))).toBe(true);
    expect(existsSync(join(dir, 'derived'))).toBe(true);
    expect(lib.list()).toEqual([]);
  });

  it('mutate 原子落盤且可重載', async () => {
    const dir = await tmpDir('vidcut-lib-');
    const lib = await LibraryStore.load(dir);
    const a = fakeAsset();
    await lib.mutate((assets) => assets.push(a));
    expect(existsSync(join(dir, '.library.json.tmp'))).toBe(false); // rename 收尾，不留 tmp
    const again = await LibraryStore.load(dir);
    expect(again.get(a.id)?.label).toBe('片頭 v2');
  });

  it('mutate 前重讀：兩個實例各加一筆，兩筆都在', async () => {
    const dir = await tmpDir('vidcut-lib-');
    const a = await LibraryStore.load(dir);
    const b = await LibraryStore.load(dir);
    const x = fakeAsset({ hash: 'b'.repeat(64), file: `files/${'b'.repeat(64)}.mp4` });
    const y = fakeAsset({ hash: 'c'.repeat(64), file: `files/${'c'.repeat(64)}.mp4` });
    await a.mutate((assets) => assets.push(x));
    await b.mutate((assets) => assets.push(y));
    expect((await LibraryStore.load(dir)).list()).toHaveLength(2);
  });

  it('索引損毀時 load 丟錯（不靜默清空）', async () => {
    const dir = await tmpDir('vidcut-lib-');
    await writeFile(join(dir, 'library.json'), '{not json', 'utf8');
    await expect(LibraryStore.load(dir)).rejects.toThrow();
  });

  it('list：query 對 label+tags、tag 精確、broken 反映 files/ 缺檔', async () => {
    const dir = await tmpDir('vidcut-lib-');
    const lib = await LibraryStore.load(dir);
    const hit = fakeAsset({ label: '常用 BGM-輕快', tags: ['bgm'] });
    const miss = fakeAsset({ hash: 'd'.repeat(64), file: `files/${'d'.repeat(64)}.mp4`, label: 'logo', tags: ['brand'] });
    await lib.mutate((assets) => assets.push(hit, miss));
    await mkdir(join(dir, 'files'), { recursive: true });
    await writeFile(lib.fileAbs(hit), 'x'); // hit 的檔案存在、miss 的不存在
    expect(lib.list({ query: 'bgm' }).map((a) => a.id)).toEqual([hit.id]);
    expect(lib.list({ tag: 'brand' }).map((a) => a.id)).toEqual([miss.id]);
    expect(lib.list().find((a) => a.id === hit.id)?.broken).toBe(false);
    expect(lib.list().find((a) => a.id === miss.id)?.broken).toBe(true);
  });

  it('updateAsset 改 label/tags；不存在丟 no library asset', async () => {
    const dir = await tmpDir('vidcut-lib-');
    const lib = await LibraryStore.load(dir);
    const a = fakeAsset();
    await lib.mutate((assets) => assets.push(a));
    const r = await lib.updateAsset(a.id, { label: '片頭 v3', tags: ['intro', 'v3'] });
    expect(r.label).toBe('片頭 v3');
    expect((await LibraryStore.load(dir)).get(a.id)?.tags).toEqual(['intro', 'v3']);
    await expect(lib.updateAsset('lib-nope', { label: 'x' })).rejects.toThrow('no library asset');
  });

  it('removeAsset 清索引 + files/ + derived/', async () => {
    const dir = await tmpDir('vidcut-lib-');
    const lib = await LibraryStore.load(dir);
    const a = fakeAsset();
    await lib.mutate((assets) => assets.push(a));
    await writeFile(lib.fileAbs(a), 'x');
    await mkdir(lib.derivedAbs(a), { recursive: true });
    await writeFile(join(lib.derivedAbs(a), 'peaks.json'), '{}');
    await lib.removeAsset(a.id);
    expect(lib.get(a.id)).toBeUndefined();
    expect(existsSync(lib.fileAbs(a))).toBe(false);
    expect(existsSync(lib.derivedAbs(a))).toBe(false);
  });

  it('removeAsset 拒刪形狀可疑的 file 路徑', async () => {
    const dir = await tmpDir('vidcut-lib-');
    const lib = await LibraryStore.load(dir);
    const evil = fakeAsset({ file: '../outside.mp4' });
    await lib.mutate((assets) => assets.push(evil));
    await expect(lib.removeAsset(evil.id)).rejects.toThrow('suspicious');
    const raw = JSON.parse(await readFile(join(dir, 'library.json'), 'utf8')) as { assets: unknown[] };
    expect(raw.assets).toHaveLength(1); // 索引也不動
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -w @vidcut/server -- libraryStore`
Expected: FAIL（模組不存在）

- [ ] **Step 3: 實作**

`shared/src/types.ts`（`PeaksFile` 之後）：

```ts
/**
 * 跨專案素材庫的一筆素材（`~/.vidcut/library/library.json` 的元素）。
 * spec：docs/superpowers/specs/2026-08-21-asset-library-design.md。
 * 型別放 shared 是為了第二期 UI 直接消費；LibraryStore 本體在 server。
 */
export interface LibraryAsset {
  /** 'lib-' 前綴 + nanoid，永久穩定（專案 meta.libraryId 引用它） */
  id: string;
  /** 第一階段只有 media；'font' | 'stylePreset' | 'mograph' 預留給後續獨立成案 */
  kind: 'media';
  /** sha256，同時是 files/ 與 derived/ 的定址鍵；一個 hash 只會有一筆 asset */
  hash: string;
  /** 庫內相對路徑，如 'files/<hash>.mp4' */
  file: string;
  probe: ProbeInfo;
  /** 人/AI 取的名字（「片頭 v2」「常用 BGM-輕快」）——搜尋與辨識靠它 */
  label: string;
  /** 扁平標籤；刻意不做資料夾樹（spec 的競品結論） */
  tags: string[];
  /** 來源溯源。'stock' | 'generated' 預留給 Pro（授權/prompt 溯源） */
  origin: { type: 'upload' | 'project' | 'source'; note?: string };
  addedAt: string;
  meta?: Record<string, unknown>;
}
```

`server/src/libraryStore.ts` 全文：

```ts
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LibraryAsset } from '@vidcut/shared';

/** library.json 的落盤形狀。 */
interface LibraryFile {
  assets: LibraryAsset[];
}

export interface LibraryFilter {
  query?: string;
  tag?: string;
  kind?: LibraryAsset['kind'];
}

/** list() 的元素：asset + 執行期算出的 broken（索引有記錄但 files/ 缺檔）。不落盤。 */
export type LibraryListing = LibraryAsset & { broken: boolean };

/**
 * 跨專案素材庫的唯一真相來源（spec 2026-08-21）。獨立於任何專案：
 * 變更不進 undo、不走 Command——它不是專案狀態。所有庫變更走 mutate()。
 *
 * 併發模型：這個工作區常態多 session 同開，每次 mutate 先重讀再套用再原子寫，
 * 檔案層級最後寫贏。單人本地庫可接受；不做鎖（spec 明文記錄此取捨）。
 */
export class LibraryStore {
  #dir: string;
  #assets: LibraryAsset[] = [];

  private constructor(dir: string) {
    this.#dir = dir;
  }

  /**
   * 載入（目錄不存在則建立）。library.json 損毀（parse 失敗）時**丟錯**而不是
   * 靜默清空——清空再寫回等於丟掉整個索引。呼叫端（index.ts）降級成「無素材庫」
   * 並警告，其餘功能照常（同字型表先例）。
   */
  static async load(dir: string): Promise<LibraryStore> {
    const s = new LibraryStore(dir);
    await mkdir(join(dir, 'files'), { recursive: true });
    await mkdir(join(dir, 'derived'), { recursive: true });
    await s.#reload();
    return s;
  }

  get dir(): string {
    return this.#dir;
  }

  get(id: string): LibraryAsset | undefined {
    return this.#assets.find((a) => a.id === id);
  }

  /** 去重靠它：一個 hash 永遠只有一筆 asset（addToLibrary 保證）。 */
  byHash(hash: string): LibraryAsset | undefined {
    return this.#assets.find((a) => a.hash === hash);
  }

  fileAbs(a: LibraryAsset): string {
    return join(this.#dir, a.file);
  }

  derivedAbs(a: LibraryAsset): string {
    return join(this.#dir, 'derived', a.hash);
  }

  list(f: LibraryFilter = {}): LibraryListing[] {
    let out = this.#assets;
    if (f.kind) out = out.filter((a) => a.kind === f.kind);
    if (f.tag) out = out.filter((a) => a.tags.includes(f.tag!));
    if (f.query) {
      const q = f.query.toLowerCase();
      out = out.filter((a) => `${a.label} ${a.tags.join(' ')}`.toLowerCase().includes(q));
    }
    // broken 執行期算不落盤：檔案在不在是檔案系統的事實，快取它只會製造過期資訊
    return out.map((a) => ({ ...a, broken: !existsSync(this.fileAbs(a)) }));
  }

  /** 改 label/tags。id 不存在丟錯（錯誤字樣 `no library asset` 是 HTTP 404 的判據）。 */
  async updateAsset(id: string, patch: { label?: string; tags?: string[] }): Promise<LibraryAsset> {
    let updated: LibraryAsset | undefined;
    await this.mutate((assets) => {
      const a = assets.find((x) => x.id === id);
      if (!a) throw new Error(`no library asset ${id}`);
      if (patch.label !== undefined) a.label = patch.label;
      if (patch.tags !== undefined) a.tags = patch.tags;
      updated = a;
    });
    return updated!;
  }

  /**
   * 刪除：索引先寫、檔案後刪（反過來的話索引寫失敗會留下指向已刪檔案的記錄）。
   * a.file 先驗形狀再 rm——索引正常只會有 files/<hash>.<ext>，但 rm 前多驗一步，
   * 防止手改壞的索引讓我們刪到庫外的路徑。
   */
  async removeAsset(id: string): Promise<void> {
    const a = this.get(id);
    if (!a) throw new Error(`no library asset ${id}`);
    if (!/^files\/[0-9a-f]{64}\.[A-Za-z0-9]+$/.test(a.file.replaceAll('\\', '/'))) {
      throw new Error(`refusing to delete suspicious file path: ${a.file}`);
    }
    await this.mutate((assets) => {
      const i = assets.findIndex((x) => x.id === id);
      if (i === -1) throw new Error(`no library asset ${id}`);
      assets.splice(i, 1);
    });
    await rm(this.fileAbs(a), { force: true });
    await rm(this.derivedAbs(a), { recursive: true, force: true });
  }

  /** 所有庫變更的唯一路徑：重讀 → 套用 → 原子寫（temp+rename）。fn 丟錯則不落盤。 */
  async mutate(fn: (assets: LibraryAsset[]) => void): Promise<void> {
    await this.#reload();
    const next = structuredClone(this.#assets);
    fn(next);
    const tmp = join(this.#dir, '.library.json.tmp');
    await writeFile(tmp, JSON.stringify({ assets: next } satisfies LibraryFile, null, 2), 'utf8');
    await rename(tmp, join(this.#dir, 'library.json'));
    this.#assets = next;
  }

  async #reload(): Promise<void> {
    try {
      const raw = await readFile(join(this.#dir, 'library.json'), 'utf8');
      this.#assets = (JSON.parse(raw) as LibraryFile).assets ?? [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#assets = []; // 還沒有索引＝空庫，正常初始
        return;
      }
      throw e;
    }
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test -w @vidcut/server -- libraryStore && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shared/src/types.ts server/src/libraryStore.ts server/test/libraryStore.test.ts
git commit -m "feat: LibraryAsset type + LibraryStore (cross-project asset library core)"
```

---

### Task 3: `addToLibrary`（入庫：hash → 複製 → derived → 索引，全有全無）

**Files:**
- Create: `server/src/libraryIngest.ts`
- Test: `server/test/libraryIngest.test.ts`

**Interfaces:**
- Consumes: Task 1 `buildDerivatives`、Task 2 `LibraryStore`、既有 `probe`（`./ffmpeg.js`）、`MEDIA_EXTENSIONS`（`./sourceFolder.js`）
- Produces（Task 5、6 消費）:
  - `hashFile(abs: string): Promise<string>`（sha256 hex，串流計算）
  - `interface AddToLibraryOpts { label?: string; tags?: string[]; origin: LibraryAsset['origin']; move?: boolean }`
  - `addToLibrary(lib: LibraryStore, absPath: string, opts: AddToLibraryOpts): Promise<{ asset: LibraryAsset; existing: boolean }>`

- [ ] **Step 1: 寫失敗測試**

`server/test/libraryIngest.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LibraryStore } from '../src/libraryStore.js';
import { addToLibrary, hashFile } from '../src/libraryIngest.js';
import { makeAudio, makeVideo } from './fixtures.js';
import { tmpDir } from './tmp.js';

async function setup() {
  const libDir = await tmpDir('vidcut-libing-lib-');
  const srcDir = await tmpDir('vidcut-libing-src-');
  return { lib: await LibraryStore.load(libDir), libDir, srcDir };
}

describe('addToLibrary', () => {
  it('影片入庫：複製為 files/<hash>.mp4、derived 三件齊、索引一筆', async () => {
    const { lib, srcDir } = await setup();
    await makeVideo(srcDir, 'a.mp4', { duration: 2 });
    const { asset, existing } = await addToLibrary(lib, join(srcDir, 'a.mp4'), {
      label: '片頭 v2',
      tags: ['intro'],
      origin: { type: 'source', note: join(srcDir, 'a.mp4') },
    });
    expect(existing).toBe(false);
    expect(asset.file).toBe(join('files', `${asset.hash}.mp4`));
    expect(asset.hash).toBe(await hashFile(lib.fileAbs(asset)));
    expect(existsSync(lib.fileAbs(asset))).toBe(true);
    expect(existsSync(join(srcDir, 'a.mp4'))).toBe(true); // 預設複製，原檔還在
    for (const f of ['proxy.mp4', 'filmstrip.jpg', 'peaks.json']) {
      expect(existsSync(join(lib.derivedAbs(asset), f))).toBe(true);
    }
    expect(lib.list()).toHaveLength(1);
  }, 60_000);

  it('同內容再入庫（即使檔名不同）冪等回既有 asset', async () => {
    const { lib, srcDir } = await setup();
    await makeVideo(srcDir, 'a.mp4', { duration: 2 });
    const first = await addToLibrary(lib, join(srcDir, 'a.mp4'), {
      origin: { type: 'source' },
    });
    const { copyFile } = await import('node:fs/promises');
    await copyFile(join(srcDir, 'a.mp4'), join(srcDir, 'b.mp4'));
    const second = await addToLibrary(lib, join(srcDir, 'b.mp4'), {
      origin: { type: 'source' },
    });
    expect(second.existing).toBe(true);
    expect(second.asset.id).toBe(first.asset.id);
    expect(lib.list()).toHaveLength(1);
  }, 60_000);

  it('audio-only：只產 peaks，probe.hasVideo === false', async () => {
    const { lib, srcDir } = await setup();
    await makeAudio(srcDir, 'a.mp3', { duration: 1 });
    const { asset } = await addToLibrary(lib, join(srcDir, 'a.mp3'), { origin: { type: 'source' } });
    expect(asset.probe.hasVideo).toBe(false);
    expect(existsSync(join(lib.derivedAbs(asset), 'peaks.json'))).toBe(true);
    expect(existsSync(join(lib.derivedAbs(asset), 'proxy.mp4'))).toBe(false);
  }, 60_000);

  it('label 預設原檔名；tags 預設空陣列', async () => {
    const { lib, srcDir } = await setup();
    await makeVideo(srcDir, 'a.mp4', { duration: 2 });
    const { asset } = await addToLibrary(lib, join(srcDir, 'a.mp4'), { origin: { type: 'source' } });
    expect(asset.label).toBe('a.mp4');
    expect(asset.tags).toEqual([]);
  }, 60_000);

  it('白名單外副檔名拒收，什麼都不落地', async () => {
    const { lib, srcDir, libDir } = await setup();
    await writeFile(join(srcDir, 'a.txt'), 'x');
    await expect(
      addToLibrary(lib, join(srcDir, 'a.txt'), { origin: { type: 'source' } }),
    ).rejects.toThrow('unsupported');
    expect(await readdir(join(libDir, 'files'))).toEqual([]);
  });

  it('壞檔（probe 失敗）不留任何落地物', async () => {
    const { lib, srcDir, libDir } = await setup();
    await writeFile(join(srcDir, 'junk.mp4'), 'not a video');
    await expect(
      addToLibrary(lib, join(srcDir, 'junk.mp4'), { origin: { type: 'source' } }),
    ).rejects.toThrow();
    expect(await readdir(join(libDir, 'files'))).toEqual([]);
    expect(await readdir(join(libDir, 'derived'))).toEqual([]);
    expect(lib.list()).toEqual([]);
  });

  it('move:true 入庫後原檔消失（上傳暫存檔路徑用）', async () => {
    const { lib, srcDir } = await setup();
    await makeVideo(srcDir, 'a.mp4', { duration: 2 });
    const { asset } = await addToLibrary(lib, join(srcDir, 'a.mp4'), {
      origin: { type: 'upload' },
      move: true,
    });
    expect(existsSync(join(srcDir, 'a.mp4'))).toBe(false);
    expect(existsSync(lib.fileAbs(asset))).toBe(true);
  }, 60_000);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -w @vidcut/server -- libraryIngest`
Expected: FAIL（模組不存在）

- [ ] **Step 3: 實作**

`server/src/libraryIngest.ts`：

```ts
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, rename, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { nanoid } from 'nanoid';
import type { LibraryAsset } from '@vidcut/shared';
import { probe } from './ffmpeg.js';
import { buildDerivatives } from './ingest.js';
import { MEDIA_EXTENSIONS } from './sourceFolder.js';
import type { LibraryStore } from './libraryStore.js';

/** sha256（hex）。串流計算——庫素材可以是幾百 MB 的片頭檔，不整檔進記憶體。 */
export async function hashFile(abs: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export interface AddToLibraryOpts {
  label?: string;
  tags?: string[];
  origin: LibraryAsset['origin'];
  /** true = absPath 是我們自己的暫存檔（HTTP 上傳），入庫用 rename 而非複製 */
  move?: boolean;
}

/**
 * 入庫（spec 2026-08-21）：hash → 去重 → 複製為 files/<hash>.<ext> → 生 derived → 寫索引。
 * **全有全無**：任一步失敗把已落地的 files/derived 清掉再 rethrow——半套狀態
 * （檔在、索引沒有）是延遲引爆的孤兒檔。
 * 冪等：同 hash 已在庫中回既有 asset（existing: true），不重跑任何 ffmpeg。
 * derived 在入庫時就生（而非首次匯入專案時）：ingest 約 7× 實時是整條路的瓶頸，
 * 之後每次匯入專案都只是複製。
 */
export async function addToLibrary(
  lib: LibraryStore,
  absPath: string,
  opts: AddToLibraryOpts,
): Promise<{ asset: LibraryAsset; existing: boolean }> {
  const ext = extname(absPath).toLowerCase();
  if (!(MEDIA_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new Error(`unsupported extension: ${ext || '(none)'}`);
  }
  const hash = await hashFile(absPath);
  const dup = lib.byHash(hash);
  if (dup) {
    if (opts.move) await rm(absPath, { force: true }); // 上傳暫存檔：內容已在庫中，收掉
    return { asset: dup, existing: true };
  }
  const info = await probe(absPath); // 壞檔在任何落地之前就擋下
  const fileRel = join('files', `${hash}${ext}`);
  const fileAbs = join(lib.dir, fileRel);
  const derivedAbs = join(lib.dir, 'derived', hash);
  try {
    if (opts.move) await rename(absPath, fileAbs);
    else await copyFile(absPath, fileAbs);
    // derived 一律以庫內那份為來源——它才是之後被引用的檔
    await buildDerivatives(fileAbs, derivedAbs, info);
    const asset: LibraryAsset = {
      id: `lib-${nanoid(8)}`,
      kind: 'media',
      hash,
      file: fileRel,
      probe: info,
      label: opts.label ?? basename(absPath),
      tags: opts.tags ?? [],
      origin: opts.origin,
      addedAt: new Date().toISOString(),
    };
    await lib.mutate((assets) => {
      assets.push(asset);
    });
    return { asset, existing: false };
  } catch (e) {
    await rm(fileAbs, { force: true });
    await rm(derivedAbs, { recursive: true, force: true });
    throw e;
  }
}
```

注意 `label` 預設取 `basename(absPath)`——`move` 路徑（HTTP 上傳）的暫存檔名不是原檔名，所以上傳端點一定要自己帶 `label`（Task 5 有做）。

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test -w @vidcut/server -- libraryIngest && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/libraryIngest.ts server/test/libraryIngest.test.ts
git commit -m "feat: addToLibrary — content-addressed ingest into the asset library"
```

---

### Task 4: `prepareFromLibrary`（庫 → 專案：derived 複用 + lazy 重建）

**Files:**
- Modify: `server/src/libraryIngest.ts`
- Test: `server/test/import-from-library.test.ts`

**Interfaces:**
- Consumes: Task 3、既有 `PreparedMedia`／`resolveMediaPath`／`applyCommand`、`ProjectStore`
- Produces（Task 5、6 消費）: `prepareFromLibrary(store: ProjectStore, projectDir: string, lib: LibraryStore, assetId: string): Promise<PreparedMedia>` —— 與 `prepareMedia` 同形狀：回 `{ existingId }` 或 `{ asset }`（**不寫文件**，登記交給呼叫端走 `applyCommand`／`aiWrite`）

- [ ] **Step 1: 寫失敗測試**

`server/test/import-from-library.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { applyCommand } from '../src/commands.js';
import { LibraryStore } from '../src/libraryStore.js';
import { addToLibrary, prepareFromLibrary } from '../src/libraryIngest.js';
import { makeVideo } from './fixtures.js';
import { tmpDir } from './tmp.js';

async function setup() {
  const libDir = await tmpDir('vidcut-ifl-lib-');
  const srcDir = await tmpDir('vidcut-ifl-src-');
  const projDir = await tmpDir('vidcut-ifl-proj-');
  const lib = await LibraryStore.load(libDir);
  const store = await ProjectStore.load(join(projDir, 'project.json'));
  await makeVideo(srcDir, 'a.mp4', { duration: 2 });
  const { asset } = await addToLibrary(lib, join(srcDir, 'a.mp4'), {
    label: '片頭 v2',
    origin: { type: 'source' },
  });
  return { lib, store, projDir, asset };
}

describe('prepareFromLibrary', () => {
  it('登記為指向庫檔的絕對路徑引用，帶 libraryId/libraryHash 溯源', async () => {
    const { lib, store, projDir, asset } = await setup();
    const prepared = await prepareFromLibrary(store, projDir, lib, asset.id);
    expect('asset' in prepared).toBe(true);
    if (!('asset' in prepared)) return;
    const r = applyCommand(store, 'human', { name: 'registerMedia', asset: prepared.asset });
    expect(r.ok).toBe(true);
    const m = store.doc.media[0]!;
    expect(m.path).toBe(lib.fileAbs(asset)); // 絕對路徑 = 零複製引用庫檔
    expect(m.meta).toMatchObject({ libraryId: asset.id, libraryHash: asset.hash });
    expect(m.label).toBe('片頭 v2');
    // derived 已複製進專案（UI 預覽/波形都在專案內，與一般匯入無異）
    expect(existsSync(join(projDir, m.proxyPath!))).toBe(true);
    expect(existsSync(join(projDir, m.peaksPath!))).toBe(true);
  }, 60_000);

  it('derived 是複製不是重算（庫的 proxy mtime 不變）', async () => {
    const { lib, store, projDir, asset } = await setup();
    const libProxy = join(lib.derivedAbs(asset), 'proxy.mp4');
    const before = (await stat(libProxy)).mtimeMs;
    await prepareFromLibrary(store, projDir, lib, asset.id);
    expect((await stat(libProxy)).mtimeMs).toBe(before);
  }, 60_000);

  it('庫的 derived 被清掉時 lazy 重建（衍生檔是可拋棄快取）', async () => {
    const { lib, store, projDir, asset } = await setup();
    await rm(lib.derivedAbs(asset), { recursive: true, force: true });
    const prepared = await prepareFromLibrary(store, projDir, lib, asset.id);
    expect('asset' in prepared).toBe(true);
    expect(existsSync(join(lib.derivedAbs(asset), 'peaks.json'))).toBe(true); // 庫也補回
  }, 60_000);

  it('同 asset 再匯入同專案：冪等回既有 id', async () => {
    const { lib, store, projDir, asset } = await setup();
    const first = await prepareFromLibrary(store, projDir, lib, asset.id);
    if ('asset' in first) applyCommand(store, 'human', { name: 'registerMedia', asset: first.asset });
    const second = await prepareFromLibrary(store, projDir, lib, asset.id);
    expect('existingId' in second && second.existingId === store.doc.media[0]!.id).toBe(true);
  }, 60_000);

  it('broken（files/ 缺檔）拒絕匯入；不存在的 assetId 丟 no library asset', async () => {
    const { lib, store, projDir, asset } = await setup();
    await rm(lib.fileAbs(asset), { force: true });
    await expect(prepareFromLibrary(store, projDir, lib, asset.id)).rejects.toThrow();
    await expect(prepareFromLibrary(store, projDir, lib, 'lib-nope')).rejects.toThrow(
      'no library asset',
    );
  }, 60_000);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -w @vidcut/server -- import-from-library`
Expected: FAIL（`prepareFromLibrary` 不存在）

- [ ] **Step 3: 實作**

加進 `server/src/libraryIngest.ts`（新增 import：`existsSync` from `node:fs`、`cp`、`stat` from `node:fs/promises`、`resolveMediaPath` from `./paths.js`、`PreparedMedia` from `./ingest.js`、`MediaAsset` type、`ProjectStore` type from `./store.js`）：

```ts
/**
 * 庫素材匯入專案（spec 2026-08-21）：專案引用**庫內檔案的絕對路徑**（零複製語意
 * 原樣沿用；庫檔內容定址永不搬家，所以這個引用不會斷鏈），derived 從庫複製進
 * 專案（不重跑 ffmpeg）；庫的 derived 被清過就先重建（衍生檔是可拋棄快取）。
 * 與 prepareMedia 同一約定：**不寫文件**，登記交給呼叫端
 * （HTTP 走 applyCommand human、MCP 走 aiWrite 吃審核鎖）。
 * 冪等判斷同 prepareMedia：解析後絕對路徑相同 ⇒ 已匯入。
 */
export async function prepareFromLibrary(
  store: ProjectStore,
  projectDir: string,
  lib: LibraryStore,
  assetId: string,
): Promise<PreparedMedia> {
  const a = lib.get(assetId);
  if (!a) throw new Error(`no library asset ${assetId}`);
  const srcAbs = lib.fileAbs(a);
  await stat(srcAbs); // broken（files/ 缺檔）：ENOENT 直接擋在任何落地之前

  const existing = store.doc.media.find((m) => resolveMediaPath(projectDir, m.path) === srcAbs);
  if (existing) return { existingId: existing.id };

  const libDerived = lib.derivedAbs(a);
  // peaks.json 是 buildDerivatives 的最後一步 ⇒ 它存在就代表整組完整（見該函式註解）
  if (!existsSync(join(libDerived, 'peaks.json'))) {
    await buildDerivatives(srcAbs, libDerived, a.probe);
  }
  const id = nanoid(8);
  const derivedRel = join('derived', id);
  await cp(libDerived, join(projectDir, derivedRel), { recursive: true });

  const audioOnly = a.probe.hasVideo === false;
  const asset: MediaAsset = {
    id,
    path: srcAbs,
    ...(audioOnly
      ? {}
      : {
          proxyPath: join(derivedRel, 'proxy.mp4'),
          filmstripPath: join(derivedRel, 'filmstrip.jpg'),
        }),
    peaksPath: join(derivedRel, 'peaks.json'),
    probe: a.probe,
    label: a.label,
    meta: { libraryId: a.id, libraryHash: a.hash },
  };
  return { asset };
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test -w @vidcut/server -- import-from-library && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/libraryIngest.ts server/test/import-from-library.test.ts
git commit -m "feat: prepareFromLibrary — import library assets into a project with derived reuse"
```

---

### Task 5: HTTP 路由 + `index.ts` 佈線

**Files:**
- Modify: `server/src/app.ts`（新增素材庫路由；`extras` 加 `library`）
- Modify: `server/src/index.ts`（載入 LibraryStore、傳給 createApp 與 mountMcp——mountMcp 的 deps 欄位本 task 先加型別，工具本體是 Task 6）
- Modify: `server/src/mcp.ts`（只加 `McpDeps.library?: LibraryStore` 一行，讓 index.ts 能傳）
- Test: `server/test/library-api.test.ts`

**Interfaces:**
- Consumes: Task 2–4 全部、既有 `applyCommand`
- Produces:
  - `createApp(store, projectDir, uiDistDir?, extras?)` 的 `extras` 多收 `library?: LibraryStore`
  - 路由：`GET /api/library?query=&tag=`、`POST /api/library?name=&label=&tags=`（串流 body）、`PATCH /api/library/:id`、`DELETE /api/library/:id`、`POST /api/library/:id/import`、`GET /library/files/*`（immutable 強快取）、`GET /library/derived/*`
  - `McpDeps` 多一個 `library?: LibraryStore` 欄位

- [ ] **Step 1: 寫失敗測試**

`server/test/library-api.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { createApp } from '../src/app.js';
import { LibraryStore } from '../src/libraryStore.js';
import { addToLibrary } from '../src/libraryIngest.js';
import { makeAudio, makeVideo } from './fixtures.js';
import { tmpDir } from './tmp.js';

async function startTestServer() {
  const projDir = await tmpDir('vidcut-libapi-proj-');
  const libDir = await tmpDir('vidcut-libapi-lib-');
  const srcDir = await tmpDir('vidcut-libapi-src-');
  const store = await ProjectStore.load(join(projDir, 'project.json'));
  const lib = await LibraryStore.load(libDir);
  const server: Server = createServer(createApp(store, projDir, undefined, { library: lib }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { projDir, libDir, srcDir, store, lib, server, base: `http://127.0.0.1:${port}` };
}

describe('library HTTP api', () => {
  it('GET /api/library：空庫回空清單；query/tag 過濾', async () => {
    const { lib, srcDir, server, base } = await startTestServer();
    expect(await (await fetch(`${base}/api/library`)).json()).toEqual({ assets: [] });
    await makeVideo(srcDir, 'a.mp4', { duration: 2 });
    await addToLibrary(lib, join(srcDir, 'a.mp4'), { label: '片頭', tags: ['intro'], origin: { type: 'source' } });
    const j = (await (await fetch(`${base}/api/library?tag=intro`)).json()) as { assets: unknown[] };
    expect(j.assets).toHaveLength(1);
    const none = (await (await fetch(`${base}/api/library?query=bgm`)).json()) as { assets: unknown[] };
    expect(none.assets).toHaveLength(0);
    server.close();
  }, 60_000);

  it('POST /api/library：串流上傳入庫；重複上傳 existing:true；壞副檔名 400', async () => {
    const { lib, srcDir, server, base } = await startTestServer();
    await makeVideo(srcDir, 'up.mp4', { duration: 2 });
    const body = await readFile(join(srcDir, 'up.mp4'));
    const post = () =>
      fetch(`${base}/api/library?name=up.mp4&label=%E7%89%87%E9%A0%AD&tags=intro,brand`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      });
    const first = (await (await post()).json()) as {
      asset: { id: string; label: string; tags: string[]; file: string };
      existing: boolean;
    };
    expect(first.existing).toBe(false);
    expect(first.asset.label).toBe('片頭');
    expect(first.asset.tags).toEqual(['intro', 'brand']);
    expect(existsSync(join(lib.dir, first.asset.file))).toBe(true);
    const second = (await (await post()).json()) as { existing: boolean };
    expect(second.existing).toBe(true);
    const bad = await fetch(`${base}/api/library?name=x.txt`, { method: 'POST', body: 'x' });
    expect(bad.status).toBe(400);
    server.close();
  }, 60_000);

  it('PATCH 改 label/tags；未知 id 404；DELETE 清索引與檔案', async () => {
    const { lib, srcDir, server, base } = await startTestServer();
    await makeVideo(srcDir, 'a.mp4', { duration: 2 });
    const { asset } = await addToLibrary(lib, join(srcDir, 'a.mp4'), { origin: { type: 'source' } });
    const patched = await fetch(`${base}/api/library/${asset.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '新名字', tags: ['bgm'] }),
    });
    expect(patched.status).toBe(200);
    expect(lib.get(asset.id)?.label).toBe('新名字');
    expect((await fetch(`${base}/api/library/lib-nope`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404);
    const del = await fetch(`${base}/api/library/${asset.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(existsSync(lib.fileAbs(asset))).toBe(false);
    server.close();
  }, 60_000);

  it('POST /:id/import 登記進專案；addToTimeline 上主軌；audio-only 上軌 400 但素材已登記', async () => {
    const { lib, srcDir, store, server, base } = await startTestServer();
    await makeVideo(srcDir, 'v.mp4', { duration: 2 });
    await makeAudio(srcDir, 'a.mp3', { duration: 1 });
    const v = (await addToLibrary(lib, join(srcDir, 'v.mp4'), { origin: { type: 'source' } })).asset;
    const a = (await addToLibrary(lib, join(srcDir, 'a.mp3'), { origin: { type: 'source' } })).asset;
    const r1 = await fetch(`${base}/api/library/${v.id}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addToTimeline: true }),
    });
    expect(r1.status).toBe(200);
    expect(store.doc.media).toHaveLength(1);
    expect(store.doc.tracks.video).toHaveLength(1);
    const r2 = await fetch(`${base}/api/library/${a.id}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addToTimeline: true }),
    });
    expect(r2.status).toBe(400); // addClip 擋 audio-only
    expect(store.doc.media).toHaveLength(2); // 但素材已登記
    expect((await fetch(`${base}/api/library/lib-nope/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404);
    server.close();
  }, 120_000);

  it('/library/files 靜態服務庫檔；traversal 被擋', async () => {
    const { lib, srcDir, server, base } = await startTestServer();
    await makeVideo(srcDir, 'a.mp4', { duration: 2 });
    const { asset } = await addToLibrary(lib, join(srcDir, 'a.mp4'), { origin: { type: 'source' } });
    const ok = await fetch(`${base}/library/files/${asset.hash}.mp4`);
    expect(ok.status).toBe(200);
    const proxy = await fetch(`${base}/library/derived/${asset.hash}/proxy.mp4`);
    expect(proxy.status).toBe(200);
    const evil = await fetch(`${base}/library/files/..%2f..%2flibrary.json`);
    expect(evil.status).toBeGreaterThanOrEqual(400);
    server.close();
  }, 60_000);

  it('沒掛 library 時所有端點 503', async () => {
    const projDir = await tmpDir('vidcut-libapi-nolib-');
    const store = await ProjectStore.load(join(projDir, 'project.json'));
    const server: Server = createServer(createApp(store, projDir));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    expect((await fetch(`${base}/api/library`)).status).toBe(503);
    server.close();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -w @vidcut/server -- library-api`
Expected: FAIL（路由不存在，404）

- [ ] **Step 3: 實作路由**

`server/src/app.ts`：

新增 import：

```ts
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { nanoid } from 'nanoid';
import type { LibraryStore } from './libraryStore.js';
import { addToLibrary, prepareFromLibrary } from './libraryIngest.js';
import { MEDIA_EXTENSIONS } from './sourceFolder.js';
```

`extras` 型別加 `library?: LibraryStore`。在 `POST /assets` 之後、`/api/fonts` 之前插入（`lib` 解構一次）：

```ts
  // ── 跨專案素材庫（spec 2026-08-21）。lib 未載入（索引損毀降級）時一律 503。 ──
  const lib = extras?.library;
  const q = (req: express.Request, k: string): string | undefined =>
    typeof req.query[k] === 'string' && req.query[k] !== '' ? (req.query[k] as string) : undefined;

  app.get('/api/library', (req, res) => {
    if (!lib) {
      res.status(503).json({ error: 'library unavailable' });
      return;
    }
    res.json({ assets: lib.list({ query: q(req, 'query'), tag: q(req, 'tag') }) });
  });

  // 上傳入庫。串流落地暫存檔再 move 入庫——不走 express.raw：300MB 檔 arrayBuffer
  // 路徑會吃 300MB RSS（ROADMAP「上傳路徑串流化」實測），庫素材（片頭/BGM）就是這個量級。
  app.post('/api/library', (req, res, next) => {
    void (async () => {
      if (!lib) {
        res.status(503).json({ error: 'library unavailable' });
        return;
      }
      const clean = basename(q(req, 'name') ?? '');
      const ext = extname(clean).toLowerCase();
      if (!clean || !(MEDIA_EXTENSIONS as readonly string[]).includes(ext)) {
        res.status(400).json({ error: `need ?name= with a supported extension (${MEDIA_EXTENSIONS.join(' ')})` });
        return;
      }
      const tmp = join(lib.dir, `.upload-${nanoid(8)}${ext}`);
      try {
        await pipeline(req, createWriteStream(tmp));
        const r = await addToLibrary(lib, tmp, {
          label: q(req, 'label') ?? clean, // move 路徑暫存檔名不是原檔名，label 一定要在這層給
          tags: q(req, 'tags')?.split(',') ?? [],
          origin: { type: 'upload', note: clean },
          move: true,
        });
        res.json(r);
      } catch (e) {
        await rm(tmp, { force: true });
        res.status(400).json({ error: (e as Error).message });
      }
    })().catch(next);
  });

  // 錯誤字樣 `no library asset` ⇒ 404（LibraryStore 的約定），其餘 400
  const libErr = (res: express.Response, e: unknown) => {
    const msg = (e as Error).message;
    res.status(msg.startsWith('no library asset') ? 404 : 400).json({ error: msg });
  };

  app.patch('/api/library/:id', (req, res, next) => {
    void (async () => {
      if (!lib) {
        res.status(503).json({ error: 'library unavailable' });
        return;
      }
      const { label, tags } = (req.body ?? {}) as { label?: unknown; tags?: unknown };
      if (label !== undefined && typeof label !== 'string') {
        res.status(400).json({ error: 'label must be a string' });
        return;
      }
      if (tags !== undefined && (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string'))) {
        res.status(400).json({ error: 'tags must be an array of strings' });
        return;
      }
      try {
        // 驗證過了才收窄型別——上面兩個 if 就是 narrowing 的證據
        res.json({
          asset: await lib.updateAsset(req.params.id, {
            label: label as string | undefined,
            tags: tags as string[] | undefined,
          }),
        });
      } catch (e) {
        libErr(res, e);
      }
    })().catch(next);
  });

  app.delete('/api/library/:id', (req, res, next) => {
    void (async () => {
      if (!lib) {
        res.status(503).json({ error: 'library unavailable' });
        return;
      }
      try {
        await lib.removeAsset(req.params.id);
        res.json({ ok: true });
      } catch (e) {
        libErr(res, e);
      }
    })().catch(next);
  });

  app.post('/api/library/:id/import', (req, res, next) => {
    void (async () => {
      if (!lib) {
        res.status(503).json({ error: 'library unavailable' });
        return;
      }
      const { addToTimeline } = (req.body ?? {}) as { addToTimeline?: boolean };
      try {
        const prepared = await prepareFromLibrary(store, projectDir, lib, req.params.id);
        let mediaId: string;
        if ('existingId' in prepared) {
          mediaId = prepared.existingId;
        } else {
          const r = applyCommand(store, 'human', { name: 'registerMedia', asset: prepared.asset });
          if (!r.ok) throw new Error(r.error);
          mediaId = prepared.asset.id;
        }
        if (addToTimeline) {
          const media = store.doc.media.find((m) => m.id === mediaId)!;
          const r = applyCommand(store, 'human', {
            name: 'addClip',
            mediaId,
            in: 0,
            duration: media.probe.duration,
            label: media.label,
          });
          if (!r.ok) {
            // 素材已登記、只有上軌失敗（audio-only 走到這）——mediaId 一起回，別讓呼叫端誤以為全失敗
            res.status(400).json({ error: r.error, mediaId });
            return;
          }
        }
        res.json({ mediaId });
      } catch (e) {
        libErr(res, e);
      }
    })().catch(next);
  });

  if (lib) {
    // files/ 內容定址：URL 變 = 內容變 ⇒ 強快取；derived/ 會被 lazy 重建（同 URL 換內容），不能 immutable
    app.use('/library/files', express.static(join(lib.dir, 'files'), { fallthrough: false, immutable: true, maxAge: '365d' }));
    app.use('/library/derived', express.static(join(lib.dir, 'derived'), { fallthrough: false }));
  }
```

- [ ] **Step 4: 佈線**

`server/src/mcp.ts` 的 `McpDeps` 加欄位（工具本體 Task 6 才做）：

```ts
  /** 跨專案素材庫（spec 2026-08-21）。索引損毀降級時為 undefined，素材庫工具回錯誤。 */
  library?: LibraryStore;
```

（記得 `import type { LibraryStore } from './libraryStore.js';`）

`server/src/index.ts`：import `homedir` from `node:os`、`LibraryStore`；在 `createApp` 之前載入，降級模式照字型表先例：

```ts
  // 跨專案素材庫（spec 2026-08-21）。索引損毀時降級成「無素材庫」——素材庫端點回 503、
  // MCP 工具回錯誤，其餘功能（時間軸、播放、渲染）完全正常。不修不清：索引是使用者資料。
  const libraryDir = process.env.VIDCUT_LIBRARY_DIR ?? join(homedir(), '.vidcut', 'library');
  let library: LibraryStore | undefined;
  try {
    library = await LibraryStore.load(libraryDir);
  } catch (e) {
    console.warn(`⚠ Asset library unavailable (${libraryDir}): ${(e as Error).message}`);
    console.warn('  Fix or move the corrupt library.json and restart to re-enable it.');
  }
```

`createApp(store, projectDir, uiDist, { fonts, textCards, library })`；`mountMcp` 的 deps 物件加 `library`。

- [ ] **Step 5: 跑測試確認通過**

Run: `npm test -w @vidcut/server -- library-api && npm run typecheck && npm test -w @vidcut/server -- index-boot`
Expected: 全 PASS（index-boot 守佈線沒弄壞啟動）

- [ ] **Step 6: Commit**

```bash
git add server/src/app.ts server/src/index.ts server/src/mcp.ts server/test/library-api.test.ts
git commit -m "feat: asset library HTTP routes + server wiring (VIDCUT_LIBRARY_DIR)"
```

---

### Task 6: 四支 MCP 工具 + instructions + snapshot

**Files:**
- Modify: `server/src/mcp.ts`
- Test: `server/test/library-mcp.test.ts`、更新 `server/test/mcp-surface-snapshot.test.ts` 的 snapshot

**Interfaces:**
- Consumes: Task 2–5 全部、mcp.ts 既有 `result`／`err`／`writeResultText`／`aiWrite`
- Produces: MCP 工具 `list_library`、`add_to_library`、`import_from_library`、`update_library_asset`

- [ ] **Step 1: 寫失敗測試**

`server/test/library-mcp.test.ts`（harness 照抄 `mcp-tools.test.ts` 的 InMemoryTransport 模式）：

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProjectStore } from '../src/store.js';
import { ChatStore } from '../src/chatStore.js';
import { EditorContext } from '../src/editorContext.js';
import { ReviewManager } from '../src/reviews.js';
import { createMcpServer, type McpDeps } from '../src/mcp.js';
import { TextCardService } from '../src/textCards.js';
import { PillowRasterizer } from '../src/rasterizer.js';
import { LibraryStore } from '../src/libraryStore.js';
import { addToLibrary } from '../src/libraryIngest.js';
import { makeVideo } from './fixtures.js';
import { tmpDir } from './tmp.js';

interface Structured {
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

let dir: string;
let srcDir: string;
let store: ProjectStore;
let lib: LibraryStore;
let client: Client;

const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<Structured>;

beforeAll(async () => {
  dir = await tmpDir('vidcut-libmcp-proj-');
  srcDir = await tmpDir('vidcut-libmcp-src-');
  await makeVideo(srcDir, 'a.mp4', { duration: 2 });
  store = await ProjectStore.load(join(dir, 'project.json'));
  lib = await LibraryStore.load(await tmpDir('vidcut-libmcp-lib-'));
  const deps: McpDeps = {
    store,
    projectDir: dir,
    editorContext: new EditorContext(),
    reviews: new ReviewManager(store, 900_000),
    baseUrl: 'http://127.0.0.1:3845',
    textCards: new TextCardService(dir, new PillowRasterizer(() => undefined)),
    chat: await ChatStore.load(join(dir, 'chat.json')),
    library: lib,
  };
  const server = createMcpServer(deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(ct);
}, 120_000);

describe('library MCP tools', () => {
  it('add_to_library(path) → list_library 查得到 → update_library_asset 改標籤', async () => {
    const added = await call('add_to_library', {
      path: join(srcDir, 'a.mp4'),
      label: '片頭 v2',
      tags: ['intro'],
    });
    expect(added.isError).toBeFalsy();
    const assetId = (added.structuredContent as { assetId: string }).assetId;
    expect(assetId).toMatch(/^lib-/);

    const listed = await call('list_library', { query: '片頭' });
    const assets = (listed.structuredContent as { assets: Array<{ id: string }> }).assets;
    expect(assets.map((a) => a.id)).toContain(assetId);

    const upd = await call('update_library_asset', { assetId, tags: ['intro', 'v2'] });
    expect(upd.isError).toBeFalsy();
    expect(lib.get(assetId)?.tags).toEqual(['intro', 'v2']);
  }, 120_000);

  it('import_from_library 登記進專案（帶溯源）；addToTimeline 上主軌', async () => {
    const assetId = lib.list()[0]!.id;
    const r = await call('import_from_library', { assetId, addToTimeline: true });
    expect(r.isError).toBeFalsy();
    const mediaId = (r.structuredContent as { mediaId: string }).mediaId;
    const m = store.doc.media.find((x) => x.id === mediaId)!;
    expect(m.meta).toMatchObject({ libraryId: assetId });
    expect(store.doc.tracks.video.some((c) => c.mediaId === mediaId)).toBe(true);
  }, 120_000);

  it('add_to_library(mediaId) 把專案素材沉澱回庫（冪等：同內容回 existing）', async () => {
    const mediaId = store.doc.media[0]!.id;
    const r = await call('add_to_library', { mediaId });
    expect(r.isError).toBeFalsy();
    // 專案裡這支就是從庫匯入的（同內容），所以必然冪等命中
    expect((r.structuredContent as { existing: boolean }).existing).toBe(true);
  }, 120_000);

  it('參數互斥與錯誤路徑：path+mediaId 同給、都不給、未知 assetId', async () => {
    expect((await call('add_to_library', {})).isError).toBe(true);
    expect(
      (await call('add_to_library', { path: '/tmp/x.mp4', mediaId: 'abc' })).isError,
    ).toBe(true);
    expect((await call('import_from_library', { assetId: 'lib-nope' })).isError).toBe(true);
    expect((await call('update_library_asset', { assetId: 'lib-nope', label: 'x' })).isError).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -w @vidcut/server -- library-mcp`
Expected: FAIL（工具不存在）

- [ ] **Step 3: 實作四支工具**

`server/src/mcp.ts`：`createMcpServer` 的解構加 `library`；新增 import `addToLibrary, prepareFromLibrary` from `./libraryIngest.js`、`resolveMediaPath` from `./paths.js`、`basename` from `node:path`。四支工具緊接在 `import_media` 之後註冊：

```ts
  /** 素材庫工具共用的前置：庫沒載入（索引損毀降級）時給出可行動的錯誤。 */
  const needLibrary = () =>
    library ? null : err('error: the asset library is unavailable on this server (corrupt library.json?)');

  server.registerTool(
    'list_library',
    {
      description:
        "Search the user's cross-project asset library (reusable logos, intros, BGM…). query matches label+tags " +
        '(case-insensitive substring), tag matches exactly. Look before you take: check here first, then ' +
        'import_from_library. broken=true means the file is missing on disk and cannot be imported.',
      outputSchema: {
        assets: z.array(
          z.object({
            id: z.string(),
            kind: z.string(),
            label: z.string(),
            tags: z.array(z.string()),
            origin: z.object({ type: z.string(), note: z.string().optional() }),
            duration: z.number(),
            hasVideo: z.boolean(),
            hasAudio: z.boolean(),
            broken: z.boolean(),
          }),
        ),
        total: z.number().describe('total matches (may exceed the length of assets)'),
        truncated: z.boolean().optional(),
      },
      inputSchema: {
        query: z.string().optional(),
        tag: z.string().optional(),
        kind: z.enum(['media']).optional(),
        limit: z.number().int().min(1).max(50).optional().describe('default 20'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, tag, kind, limit }) => {
      const gate = needLibrary();
      if (gate) return gate;
      const all = library!.list({ query, tag, kind });
      const n = limit ?? 20;
      const assets = all.slice(0, n).map((a) => ({
        id: a.id,
        kind: a.kind,
        label: a.label,
        tags: a.tags,
        origin: a.origin,
        duration: a.probe.duration,
        hasVideo: a.probe.hasVideo ?? true,
        hasAudio: a.probe.hasAudio,
        broken: a.broken,
      }));
      return result(
        { assets, total: all.length, ...(all.length > n ? { truncated: true } : {}) },
        `${all.length} asset(s)` + (all.length > n ? `, first ${n} embedded` : ''),
      );
    },
  );

  server.registerTool(
    'add_to_library',
    {
      description:
        "Save media into the user's cross-project library for reuse in future projects. Give exactly one of " +
        'path (absolute path on this machine) or mediaId (media already in this project). The file is **copied** ' +
        'into the library (content-addressed; adding the same content twice is a no-op returning the existing ' +
        'asset). Give a descriptive label and tags so the library stays findable — that is how list_library and ' +
        'the user will recognise it later. This is a library write, not a project edit: no undo, no review lock.',
      outputSchema: {
        assetId: z.string(),
        existing: z.boolean().describe('true = same content was already in the library; that asset is returned'),
        label: z.string(),
      },
      inputSchema: {
        path: z.string().optional().describe('absolute path of a local media file'),
        mediaId: z.string().optional().describe('id of a media already imported into this project'),
        label: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ path, mediaId, label, tags }) => {
      const gate = needLibrary();
      if (gate) return gate;
      if ((path === undefined) === (mediaId === undefined)) {
        return err('error: give exactly one of path or mediaId');
      }
      try {
        let abs: string;
        let origin: { type: 'project' | 'source'; note?: string };
        let fallbackLabel: string | undefined;
        if (mediaId !== undefined) {
          const m = store.doc.media.find((x) => x.id === mediaId);
          if (!m) return err(`error: no media ${mediaId} in this project`);
          abs = resolveMediaPath(projectDir, m.path);
          origin = { type: 'project', note: store.doc.name };
          fallbackLabel = m.label ?? basename(m.path);
        } else {
          if (!isAbsolute(path!)) return err('error: path must be absolute');
          abs = path!;
          origin = { type: 'source', note: path! };
        }
        const r = await addToLibrary(library!, abs, {
          label: label ?? fallbackLabel,
          tags,
          origin,
        });
        return result(
          { assetId: r.asset.id, existing: r.existing, label: r.asset.label },
          r.existing
            ? `already in the library as ${r.asset.id} ("${r.asset.label}")`
            : `saved to the library as ${r.asset.id} ("${r.asset.label}")`,
        );
      } catch (e) {
        return err(`add_to_library failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'import_from_library',
    {
      description:
        'Import a library asset into this project: its derivatives are copied in (no re-processing) and the file ' +
        'is referenced in place from the library (content-addressed, so the reference never breaks). Check with ' +
        'list_library first — look and take are two steps. Returns a mediaId. addToTimeline appends it to the end ' +
        'of the main track (audio-only assets are refused there — use set_audio instead, the import itself still ' +
        'succeeds). This writes the project: review locks and ifVersion apply.',
      outputSchema: {
        mediaId: z.string(),
        alreadyImported: z.boolean().optional(),
        addedToTimeline: z.boolean().optional(),
        version: z.number().optional(),
      },
      inputSchema: {
        assetId: z.string(),
        addToTimeline: z.boolean().optional(),
        ifVersion: z.number().optional(),
      },
    },
    async ({ assetId, addToTimeline, ifVersion }) => {
      const gate = needLibrary();
      if (gate) return gate;
      // 早期守衛同 import_media：derived 複製前就擋，不做白工
      if (store.doc.review !== null) return err('error: a review is in progress');
      if (ifVersion !== undefined && ifVersion !== store.version)
        return err(`error: stale (ifVersion=${ifVersion}, current=${store.version})`);
      try {
        const prepared = await prepareFromLibrary(store, projectDir, library!, assetId);
        let mediaId: string;
        let version: number | undefined;
        let already = false;
        if ('existingId' in prepared) {
          mediaId = prepared.existingId;
          already = true;
        } else {
          const w = aiWrite(store, { name: 'registerMedia', asset: prepared.asset }, ifVersion);
          if (!w.ok) return err(writeResultText(w));
          mediaId = prepared.asset.id;
          version = w.version;
        }
        let addedToTimeline = false;
        let note = '';
        if (addToTimeline) {
          const m = store.doc.media.find((x) => x.id === mediaId)!;
          const w = aiWrite(store, {
            name: 'addClip',
            mediaId,
            in: 0,
            duration: m.probe.duration,
            label: m.label,
          });
          if (w.ok) {
            addedToTimeline = true;
            version = w.version;
          } else {
            note = ` (not added to the timeline: ${w.error})`;
          }
        }
        return result(
          {
            mediaId,
            ...(already ? { alreadyImported: true } : {}),
            ...(addToTimeline ? { addedToTimeline } : {}),
            ...(version !== undefined ? { version } : {}),
          },
          (already ? `${assetId} was already in this project as ${mediaId}` : `imported ${assetId} as ${mediaId}`) +
            note,
        );
      } catch (e) {
        return err(`import_from_library failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'update_library_asset',
    {
      description:
        'Rename or retag a library asset (label/tags are what list_library searches). Library write: no undo, ' +
        'no review lock. Give at least one of label, tags.',
      outputSchema: { assetId: z.string(), label: z.string(), tags: z.array(z.string()) },
      inputSchema: {
        assetId: z.string(),
        label: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ assetId, label, tags }) => {
      const gate = needLibrary();
      if (gate) return gate;
      if (label === undefined && tags === undefined) return err('error: give label and/or tags');
      try {
        const a = await library!.updateAsset(assetId, { label, tags });
        return result(
          { assetId: a.id, label: a.label, tags: a.tags },
          `updated ${a.id}: "${a.label}" [${a.tags.join(', ')}]`,
        );
      } catch (e) {
        return err(`update_library_asset failed: ${(e as Error).message}`);
      }
    },
  );
```

（`isAbsolute` 記得從 `node:path` import。）

instructions 同步：在 `import_media one file at a time (…) → ` 之後、`set_timeline` 之前**插入**這句：

```
"There is also a cross-project asset library holding the user's reusable media (logos, intros, BGM): " +
'list_library searches it, import_from_library brings an asset into this project (look first, then take), ' +
'add_to_library saves a local file (path) or an already-imported media (mediaId) there for future projects — ' +
'give a descriptive label and tags. Library writes bypass review locks and are not undoable; ' +
'import_from_library itself is a project write and obeys both. → ' +
```

- [ ] **Step 4: 跑行為測試**

Run: `npm test -w @vidcut/server -- library-mcp`
Expected: PASS

- [ ] **Step 5: snapshot 閘門**

Run: `npm test -w @vidcut/server -- mcp-surface-snapshot`
Expected: FAIL（工具面變了——這是預期的）
**讀 diff**：確認只多了四支工具與 instructions 那句、既有工具描述一字未變。屬實再：
Run: `npm test -w @vidcut/server -- mcp-surface-snapshot -u && npm test -w @vidcut/server -- mcp-surface-snapshot`
Expected: PASS

- [ ] **Step 6: 全綠 + Commit**

Run: `npm test -w @vidcut/server && npm run typecheck && npm run lint`
Expected: 全 PASS

```bash
git add server/src/mcp.ts server/test/library-mcp.test.ts server/test/__snapshots__
git commit -m "feat: MCP tools list_library / add_to_library / import_from_library / update_library_asset"
```

---

### Task 7: 文件同步 + 全套驗證

**Files:**
- Modify: `HANDOFF.md`（素材庫段：檔案職責 `libraryStore.ts`／`libraryIngest.ts`、MCP 工具數更新、`VIDCUT_LIBRARY_DIR`）
- Modify: `docs/ROADMAP.md`（「素材匯入：零複製引用 + 素材庫」項：素材庫後端已落地、連到 spec；階段 2 UI 改指向第二期計畫）
- Modify: `CLAUDE.md`（若架構要點段需要提及 `~/.vidcut/library`——由 docs-sync-review 判斷）

**Interfaces:** 無（純文件）

- [ ] **Step 1: 跑 docs-sync-review**

用 `docs-sync-review` skill（repo 內建）：按變更類型對照文件矩陣逐份審查，每份給「已更新/查過無需改」的帶證據結論。本 task 的 Files 清單是起點，不是上限——skill 說要看的都要看（README.zh-TW.md 的「素材匯入目前只走 AI」段大概率要補素材庫一句）。

- [ ] **Step 2: 全套驗證**

Run: `bash scripts/gauntlet.sh`
Expected: `GAUNTLET: 全數通過`。**跑的期間不要 commit**（突變層會故意改壞工作樹）。

- [ ] **Step 3: Commit**

```bash
git add HANDOFF.md docs/ROADMAP.md CLAUDE.md README.zh-TW.md
git commit -m "docs: asset library phase 1 — HANDOFF/ROADMAP/README sync"
```

（實際 add 的清單以 docs-sync-review 動到的檔案為準，仍然只 stage 自己動過的路徑。）

---

## Self-Review 紀錄（計畫作者填）

- Spec 覆蓋：儲存佈局/內容定址（T2、T3）、零複製接軌與溯源（T4）、derived 複用與 lazy 重建（T4）、全有全無與原子寫（T2、T3）、啟動自癒（T2 load＋T4 stat 擋 broken＋T5 降級 503）、路徑安全（T2 removeAsset 形狀驗證、T5 static fallthrough、上傳 basename）、串流上傳（T5）、四支 MCP 工具與描述紀律（T6）、instructions 同步（T6）、snapshot 閘門（T6）、測試矩陣（T2–T6 各自）、文件（T7）。**UI 三區面板＝第二期獨立計畫**；`remove_from_library` 刻意無 MCP（spec 決策，僅 HTTP DELETE 給 UI 用）。
- 型別一致性：`PreparedMedia`／`LibraryListing`／`no library asset` 錯誤字樣／`files/<hash><ext>` 佈局在 T2–T6 間交叉核對過。
- 已知留白（刻意）：`origin.type` 的 `'stock' | 'generated'`、`kind` 的其他值——Pro 接點，本期不實作（spec「只留縫」）。
