# 發佈包（Publish Package）P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** render 完成後一個 MCP 呼叫把成品打成「手動上傳包」（video＋cover＋srt＋各平台文案＋manifest 含上傳連結與警告），UI 顯示包內容與上傳頁連結；零平台 API。

**Architecture:** 新模組 `server/src/publish.ts` 做純函數（平台限制警告、文案轉文字）與檔案打包；doc 只記結果——走 registerMedia/setCover 同款「async 前置在外、命令層同步登記」模式（`Command: setPublish` → `render.publish`）。AI 經新 MCP 工具 `export_publish_package` 觸發（吃審核鎖），人只在 ExportMenu 看結果。

**Tech Stack:** Node+TS（三 workspace：shared/server/ui）、vitest、zod（MCP schema）、React。

**Spec:** `docs/superpowers/specs/2026-08-21-publish-package-p0.md`（本計劃一切設計依它；調研背景見對話中的社群 API 調研報告）

## Global Constraints

- 一切指令在 `ai-video-cut/` 內執行（workspace 規則：不在根目錄跑任何東西）。
- 分支：從 `main` 開 `publish-p0`。**不 push**（若之後要 push，分支名須加進 `.githooks/pre-push` 的 `ALLOWED`）。
- 本 feature 全屬**開源線**；不得引入 CLAUDE.md「只在 Pro」表裡的任何能力。
- 若在 worktree 執行：第一件事 `npm install`，並自檢 `ls -l node_modules/@vidcut/shared` 指向 worktree 內的 `shared`（CLAUDE.md 陷阱）。
- **不要 `git add -A`**；每次只 stage 本計劃列出的檔案。
- 改 `server/src/mcp.ts`（工具或 instructions）後 `mcp-surface-snapshot.test.ts` 必紅：先讀 diff 確認新描述屬實，再 `-u` 更新——不准盲更。
- 改 UI 原始碼後必 `npm run build -w @vidcut/ui`（否則 :3845 跑舊版）。
- `bash scripts/gauntlet.sh` 執行期間不要 commit。
- 測試指令一律 `npm test -- <檔名過濾>`（vitest 檔名過濾）；全量驗證用 `npm test`。

---

### Task 1: shared 型別與 `setPublish` 命令

**Files:**

- Modify: `shared/src/types.ts`（RenderState 附近，約 174–207 行）
- Modify: `server/src/commands.ts`（`case 'setCover'` 之後，約 447 行起）
- Test: `server/test/publish.test.ts`（新檔，本 task 先放命令層測試）

**Interfaces:**

- Consumes: 既有 `ProjectStore`、`applyCommand`、`store.mutate`。
- Produces（後續 task 依賴的名字，一字不差）：
  - `type PublishPlatform = 'tiktok' | 'youtube' | 'instagram' | 'facebook'`
  - `type PublishKind = 'short' | 'video'`
  - `interface PublishMeta { title?: string; body: string; hashtags?: string[]; kind?: PublishKind }`
  - `interface PublishInfo { dir: string; stamp: string; platforms: PublishPlatform[]; files: string[]; warnings: string[]; createdAt: string }`
  - `RenderState.publish?: PublishInfo`
  - `Command` variant `{ name: 'setPublish'; info: PublishInfo }`

- [ ] **Step 1: 寫失敗測試**

`server/test/publish.test.ts`：

```ts
// 發佈包：命令層（Task 1）＋純函數（Task 2）＋檔案打包（Task 3）的測試都收在這裡。
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { applyCommand } from '../src/commands.js';
import { tmpDir } from './tmp.js';
import type { PublishInfo } from '@vidcut/shared';

function info(over: Partial<PublishInfo> = {}): PublishInfo {
  return {
    dir: 'output/publish/r1',
    stamp: 'r1',
    platforms: ['tiktok'],
    files: ['output/publish/r1/video.mp4', 'output/publish/r1/manifest.json'],
    warnings: [],
    createdAt: '2026-08-21T00:00:00.000Z',
    ...over,
  };
}

describe('setPublish command', () => {
  let store: ProjectStore;
  beforeEach(async () => {
    store = await ProjectStore.load(join(await tmpDir('vidcut-publish-cmd-'), 'project.json'));
  });

  it('records publish info under render.publish', () => {
    const r = applyCommand(store, 'ai', { name: 'setPublish', info: info() });
    expect(r.ok).toBe(true);
    expect(store.doc.render.publish).toEqual(info());
  });

  it('rejects empty dir', () => {
    const r = applyCommand(store, 'ai', { name: 'setPublish', info: info({ dir: '' }) });
    expect(r).toEqual({ ok: false, error: 'publish dir must not be empty' });
  });

  it('rejects empty platforms', () => {
    const r = applyCommand(store, 'ai', { name: 'setPublish', info: info({ platforms: [] }) });
    expect(r).toEqual({ ok: false, error: 'publish platforms must not be empty' });
  });

  it('does not enter the undo stack (render path is not undoable)', () => {
    applyCommand(store, 'ai', { name: 'setPublish', info: info() });
    const r = applyCommand(store, 'human', { name: 'undo' });
    expect(r).toEqual({ ok: false, error: 'nothing to undo' });
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -- publish.test`
Expected: FAIL —— `setPublish` 不在 `Command` union（tsc/型別錯）或落到 `default: unknown command`。

- [ ] **Step 3: 實作型別**

`shared/src/types.ts`——在 `RenderState` 介面上方加：

```ts
// ---- 發佈包（手動上傳；P0 不接任何平台 API，見 specs/2026-08-21-publish-package-p0.md）----
export type PublishPlatform = 'tiktok' | 'youtube' | 'instagram' | 'facebook';
/** 目標形式：短片（Shorts/Reels）或一般影片（長片）。只影響警告門檻與 manifest 標記。 */
export type PublishKind = 'short' | 'video';
export interface PublishMeta {
  /** YouTube/Facebook 標題；TikTok/Instagram 忽略 */
  title?: string;
  /** caption / description 內文 */
  body: string;
  /** 不帶 # 的 hashtag 清單 */
  hashtags?: string[];
  /**
   * 省略時的預設：youtube→short（vidcut 主產出是直式短片）、facebook→video、
   * tiktok/instagram 只有 short（帶 video 也當 short）——解析在 publish.ts 的 resolveKind。
   */
  kind?: PublishKind;
}
export interface PublishInfo {
  /** 相對專案資料夾的發佈包目錄（output/publish/<stamp>） */
  dir: string;
  stamp: string;
  platforms: PublishPlatform[];
  /** 相對專案資料夾的檔案清單 */
  files: string[];
  /** "tiktok: …" 格式；只警告不擋（傳長片到 YouTube 一般影片是合法用法） */
  warnings: string[];
  /** ISO 8601 */
  createdAt: string;
}
```

`RenderState` 加欄位（`coverPath` 之後）：

```ts
  /** 最近一次發佈包（與 lastOutput 同性質：登記結果，不進 undo） */
  publish?: PublishInfo;
```

`Command` union 的 `setCover` variant 之後加：

```ts
  /** 登記打包完成的發佈包。檔案工作在 publish.ts 的 buildPublishPackage；模式同 registerMedia/setCover。 */
  | { name: 'setPublish'; info: PublishInfo }
```

- [ ] **Step 4: 實作命令 case**

`server/src/commands.ts`——`case 'setCover'` 區塊之後加：

```ts
    case 'setPublish': {
      if (!cmd.info.dir) return { ok: false, error: 'publish dir must not be empty' };
      if (cmd.info.platforms.length === 0)
        return { ok: false, error: 'publish platforms must not be empty' };
      return ok(
        store.mutate(source, 'publish package', (d) => {
          d.render.publish = cmd.info;
        }),
      );
    }
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npm test -- publish.test` → PASS；再 `npm run typecheck` → 乾淨。

- [ ] **Step 6: Commit**

```bash
git add shared/src/types.ts server/src/commands.ts server/test/publish.test.ts
git commit -m "feat(publish): setPublish command + PublishInfo types (P0 publish package)"
```

---

### Task 2: `publish.ts` 純函數（平台警告、文案轉文字、上傳連結表）

**Files:**

- Create: `server/src/publish.ts`
- Test: `server/test/publish.test.ts`（追加）

**Interfaces:**

- Consumes: Task 1 的 `PublishPlatform`、`PublishKind`、`PublishMeta`。
- Produces:
  - `UPLOAD_URLS: Record<PublishPlatform, string>`
  - `PLATFORM_LIMITS: Record<PublishPlatform, Partial<Record<PublishKind, { maxSeconds: number; maxBytes: number }>>>`
  - `resolveKind(p: PublishPlatform, kind?: PublishKind): PublishKind`
  - `platformWarnings(p: PublishPlatform, kind: PublishKind, seconds: number, bytes: number): string[]`
  - `metaToText(meta: PublishMeta): string`

- [ ] **Step 1: 寫失敗測試**（追加到 `server/test/publish.test.ts`）

```ts
import { metaToText, platformWarnings, resolveKind, UPLOAD_URLS } from '../src/publish.js';

describe('resolveKind', () => {
  it('defaults: youtube→short, facebook→video', () => {
    expect(resolveKind('youtube')).toBe('short');
    expect(resolveKind('facebook')).toBe('video');
  });
  it('honours an explicit kind the platform supports', () => {
    expect(resolveKind('youtube', 'video')).toBe('video');
    expect(resolveKind('facebook', 'short')).toBe('short');
  });
  it('tiktok/instagram only have short (video falls back)', () => {
    expect(resolveKind('tiktok', 'video')).toBe('short');
    expect(resolveKind('instagram', 'video')).toBe('short');
  });
});

describe('platformWarnings', () => {
  it('is empty within limits', () => {
    expect(platformWarnings('tiktok', 'short', 60, 10_000_000)).toEqual([]);
  });
  it('warns when a YouTube short exceeds 180s', () => {
    const w = platformWarnings('youtube', 'short', 181, 10_000_000);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('180');
  });
  it('a long YouTube video is clean (kind video lifts the Shorts limit)', () => {
    expect(platformWarnings('youtube', 'video', 3600, 10_000_000)).toEqual([]);
  });
  it('facebook video allows 240min but warns beyond', () => {
    expect(platformWarnings('facebook', 'video', 14_000, 10_000_000)).toEqual([]);
    expect(platformWarnings('facebook', 'video', 15_000, 10_000_000)).toHaveLength(1);
  });
  it('facebook reels (short) warns over 90s', () => {
    expect(platformWarnings('facebook', 'short', 91, 10_000_000)).toHaveLength(1);
  });
  it('warns on oversize file for instagram (1 GiB)', () => {
    const w = platformWarnings('instagram', 'short', 60, 2 * 2 ** 30);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('GiB');
  });
});

describe('metaToText', () => {
  it('joins title, body and hashtags with blank lines', () => {
    expect(metaToText({ title: 'T', body: 'B', hashtags: ['a', 'b'] })).toBe('T\n\nB\n\n#a #b');
  });
  it('omits missing title and hashtags', () => {
    expect(metaToText({ body: 'only body' })).toBe('only body');
  });
});

describe('UPLOAD_URLS', () => {
  it('covers every platform', () => {
    expect(Object.keys(UPLOAD_URLS).sort()).toEqual(['facebook', 'instagram', 'tiktok', 'youtube']);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -- publish.test`
Expected: FAIL —— `../src/publish.js` 不存在。

- [ ] **Step 3: 實作**

`server/src/publish.ts`：

```ts
// 發佈包：把 render 成品打成「手動上傳包」。P0 刻意不接任何平台 API——
// 設計取捨與平台限制數字的出處見 docs/superpowers/specs/2026-08-21-publish-package-p0.md。
// 一支 1080×1920 H.264+AAC master 四平台通吃，所以這裡只做複製與 stat，沒有轉檔。
import type { PublishKind, PublishMeta, PublishPlatform } from '@vidcut/shared';

export const UPLOAD_URLS: Record<PublishPlatform, string> = {
  tiktok: 'https://www.tiktok.com/tiktokstudio/upload',
  youtube: 'https://studio.youtube.com/',
  instagram: 'https://www.instagram.com/',
  facebook: 'https://www.facebook.com/',
};

/**
 * 門檻按（platform, kind）查表；kind 是目標形式（short=Shorts/Reels、video=一般長片）。
 * 超限只產生警告、不擋打包：長片本來就是 YouTube/Facebook 的合法目標。
 * 數字取保守值（帳號等級不同上限不同，寧可多提醒）。
 */
export const PLATFORM_LIMITS: Record<
  PublishPlatform,
  Partial<Record<PublishKind, { maxSeconds: number; maxBytes: number }>>
> = {
  tiktok: { short: { maxSeconds: 600, maxBytes: 4 * 2 ** 30 } },
  instagram: { short: { maxSeconds: 180, maxBytes: 1 * 2 ** 30 } },
  youtube: {
    short: { maxSeconds: 180, maxBytes: 256 * 2 ** 30 },
    video: { maxSeconds: 43_200, maxBytes: 256 * 2 ** 30 },
  },
  facebook: {
    short: { maxSeconds: 90, maxBytes: 4 * 2 ** 30 },
    video: { maxSeconds: 14_400, maxBytes: 10 * 2 ** 30 },
  },
};

/**
 * 解析目標形式：明確指定且平台支援就用它；否則平台預設
 * （youtube→short：vidcut 主產出是直式短片；facebook→video；tiktok/instagram 只有 short）。
 */
export function resolveKind(p: PublishPlatform, kind?: PublishKind): PublishKind {
  if (kind && PLATFORM_LIMITS[p][kind]) return kind;
  return p === 'facebook' ? 'video' : 'short';
}

export function platformWarnings(
  p: PublishPlatform,
  kind: PublishKind,
  seconds: number,
  bytes: number,
): string[] {
  const lim = PLATFORM_LIMITS[p][kind] ?? PLATFORM_LIMITS[p][resolveKind(p)]!;
  const out: string[] = [];
  if (seconds > lim.maxSeconds) {
    out.push(
      p === 'youtube' && kind === 'short'
        ? `video is ${Math.round(seconds)}s — over 180s it uploads as a regular video, not a Short`
        : `video is ${Math.round(seconds)}s, over the ${lim.maxSeconds}s ${kind} guideline`,
    );
  }
  if (bytes > lim.maxBytes) {
    out.push(
      `file is ${(bytes / 2 ** 30).toFixed(1)} GiB, over the ${lim.maxBytes / 2 ** 30} GiB limit`,
    );
  }
  return out;
}

/** 文案檔內容：title、空行、body、空行、#tag 列——缺的段落連同空行一起省略。 */
export function metaToText(meta: PublishMeta): string {
  const parts: string[] = [];
  if (meta.title) parts.push(meta.title);
  parts.push(meta.body);
  if (meta.hashtags && meta.hashtags.length > 0)
    parts.push(meta.hashtags.map((h) => `#${h}`).join(' '));
  return parts.join('\n\n');
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test -- publish.test` → PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/publish.ts server/test/publish.test.ts
git commit -m "feat(publish): platform limit warnings + metadata text (pure helpers)"
```

---

### Task 3: `buildPublishPackage`（檔案打包）

**Files:**

- Modify: `server/src/publish.ts`
- Test: `server/test/publish.test.ts`（追加）

**Interfaces:**

- Consumes: Task 2 全部；`serializeSrt`（`@vidcut/shared`，`shared/src/subtitles.ts:29`）、`totalDuration`（`@vidcut/shared`）、`resolveMediaPath` 不需要（成品在專案內）。
- Produces: `buildPublishPackage(projectDir: string, doc: Project, meta: Partial<Record<PublishPlatform, PublishMeta>>): Promise<PublishInfo>`
  - 前置不滿足時 throw：無平台 → `'give at least one platform'`；`doc.render.status !== 'done'` 或無 `lastOutput` 或檔案不在 → `'render first: no finished output to package'`。
  - **重打包 = 整個目錄先刪再建**（上一輪的平台 txt 不殘留）。

- [ ] **Step 1: 寫失敗測試**（追加到 `server/test/publish.test.ts`）

```ts
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { buildPublishPackage } from '../src/publish.js';
import { createEmptyProject } from '@vidcut/shared';
import type { Project } from '@vidcut/shared';

/** 假成品：不跑真 render——打包只做複製與 stat，手寫檔案即可。 */
async function doneProject(dir: string): Promise<Project> {
  const doc = createEmptyProject('p', 'p');
  doc.tracks.video = [{ id: 'c1', mediaId: 'm1', in: 0, duration: 200, volume: 1 }];
  doc.tracks.captions = [
    {
      id: 'cap1',
      text: 'hello',
      start: 0,
      duration: 2,
      style: { fontFamily: 'sans-serif', fontSize: 48, fill: '#fff', y: 0.8 },
    },
  ];
  await mkdir(join(dir, 'output'), { recursive: true });
  await writeFile(join(dir, 'output', 'r1.mp4'), Buffer.alloc(1024, 1));
  doc.render = { status: 'done', lastOutput: join('output', 'r1.mp4') };
  return doc;
}

describe('buildPublishPackage', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tmpDir('vidcut-publish-pkg-');
  });

  it('copies video, writes srt + per-platform txt + manifest, aggregates warnings by kind', async () => {
    const doc = await doneProject(dir);
    const info = await buildPublishPackage(dir, doc, {
      tiktok: { body: 'hi', hashtags: ['fyp'] },
      youtube: { title: 'T', body: 'D' },
      facebook: { title: 'F', body: 'long form' },
    });
    expect(info.dir).toBe(join('output', 'publish', 'r1'));
    expect(info.platforms).toEqual(['tiktok', 'youtube', 'facebook']);
    for (const f of info.files) expect(existsSync(join(dir, f))).toBe(true);
    const names = info.files.map((f) => f.split('/').pop());
    expect(names).toContain('video.mp4');
    expect(names).toContain('subtitles.srt');
    expect(names).toContain('tiktok.txt');
    expect(names).toContain('youtube.txt');
    expect(names).toContain('facebook.txt');
    expect(names).toContain('manifest.json');
    expect(names).not.toContain('cover.jpg'); // 沒設封面就不該有
    // timeline 200s：youtube 預設 short 超 180s 要警告；tiktok（600s 內）與
    // facebook（預設 video，240min 內）不該有
    expect(info.warnings.some((w) => w.startsWith('youtube:'))).toBe(true);
    expect(info.warnings.some((w) => w.startsWith('tiktok:'))).toBe(false);
    expect(info.warnings.some((w) => w.startsWith('facebook:'))).toBe(false);
    const manifest = JSON.parse(await readFile(join(dir, info.dir, 'manifest.json'), 'utf8')) as {
      platforms: Record<string, { uploadUrl: string; kind: string }>;
    };
    expect(manifest.platforms.tiktok!.uploadUrl).toBe(UPLOAD_URLS.tiktok);
    expect(manifest.platforms.facebook!.kind).toBe('video');
    expect(manifest.platforms.youtube!.kind).toBe('short');
  });

  it('kind: video lifts the YouTube Shorts warning for long videos', async () => {
    const doc = await doneProject(dir); // timeline 200s
    const info = await buildPublishPackage(dir, doc, {
      youtube: { title: 'T', body: 'D', kind: 'video' },
    });
    expect(info.warnings).toEqual([]);
  });

  it('repackaging drops files from platforms no longer requested', async () => {
    const doc = await doneProject(dir);
    await buildPublishPackage(dir, doc, { tiktok: { body: 'a' } });
    const info = await buildPublishPackage(dir, doc, { youtube: { title: 'T', body: 'b' } });
    expect(existsSync(join(dir, info.dir, 'tiktok.txt'))).toBe(false);
    expect(existsSync(join(dir, info.dir, 'youtube.txt'))).toBe(true);
  });

  it('throws before a finished render', async () => {
    const doc = createEmptyProject('p', 'p');
    await expect(buildPublishPackage(dir, doc, { tiktok: { body: 'x' } })).rejects.toThrow(
      /render first/,
    );
  });

  it('throws with no platform', async () => {
    const doc = await doneProject(dir);
    await expect(buildPublishPackage(dir, doc, {})).rejects.toThrow(/at least one platform/);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -- publish.test`
Expected: FAIL —— `buildPublishPackage` is not exported。

- [ ] **Step 3: 實作**（追加到 `server/src/publish.ts`）

```ts
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Project, PublishInfo } from '@vidcut/shared';
import { serializeSrt, totalDuration } from '@vidcut/shared';

const ALL_PLATFORMS: readonly PublishPlatform[] = ['tiktok', 'youtube', 'instagram', 'facebook'];

/**
 * 把最近一次 render 成品打成 output/publish/<stamp>/。只複製與 stat，不轉檔。
 * **不碰 doc**——結果由呼叫端走 setPublish 命令登記（模式同 registerMedia/setCover）。
 * 重打包整個目錄先刪再建，上一輪的平台 txt 不殘留。
 */
export async function buildPublishPackage(
  projectDir: string,
  doc: Project,
  meta: Partial<Record<PublishPlatform, PublishMeta>>,
): Promise<PublishInfo> {
  const platforms = ALL_PLATFORMS.filter((p) => meta[p] !== undefined);
  if (platforms.length === 0)
    throw new Error('give at least one platform (tiktok / youtube / instagram / facebook)');
  const out = doc.render.status === 'done' ? doc.render.lastOutput : undefined;
  const srcVideo = out ? join(projectDir, out) : '';
  if (!out || !existsSync(srcVideo)) throw new Error('render first: no finished output to package');

  const stamp = basename(out, '.mp4');
  const dirRel = join('output', 'publish', stamp);
  const dirAbs = join(projectDir, dirRel);
  await rm(dirAbs, { recursive: true, force: true });
  await mkdir(dirAbs, { recursive: true });

  const files: string[] = [];
  const put = (name: string) => {
    files.push(join(dirRel, name));
    return join(dirAbs, name);
  };

  await copyFile(srcVideo, put('video.mp4'));
  const coverAbs = doc.render.coverPath ? join(projectDir, doc.render.coverPath) : '';
  if (coverAbs && existsSync(coverAbs)) await copyFile(coverAbs, put('cover.jpg'));
  const srt = serializeSrt(doc.tracks.captions);
  if (srt !== '') await writeFile(put('subtitles.srt'), srt, 'utf8');
  for (const p of platforms) await writeFile(put(`${p}.txt`), metaToText(meta[p]!), 'utf8');

  const seconds = totalDuration(doc);
  const bytes = (await stat(srcVideo)).size;
  const kinds = Object.fromEntries(
    platforms.map((p) => [p, resolveKind(p, meta[p]!.kind)]),
  ) as Record<PublishPlatform, PublishKind>;
  const perPlatform = Object.fromEntries(
    platforms.map((p) => [
      p,
      {
        uploadUrl: UPLOAD_URLS[p],
        textFile: `${p}.txt`,
        kind: kinds[p],
        warnings: platformWarnings(p, kinds[p], seconds, bytes),
      },
    ]),
  );
  const createdAt = new Date().toISOString();
  await writeFile(
    put('manifest.json'),
    JSON.stringify(
      { stamp, createdAt, video: { file: 'video.mp4', seconds, bytes }, platforms: perPlatform },
      null,
      2,
    ),
    'utf8',
  );

  return {
    dir: dirRel,
    stamp,
    platforms: [...platforms],
    files,
    warnings: platforms.flatMap((p) =>
      platformWarnings(p, kinds[p], seconds, bytes).map((w) => `${p}: ${w}`),
    ),
    createdAt,
  };
}
```

（已核實：`totalDuration(p: Project)` 在 `shared/src/timeline.ts:11`，吃整個 Project，上面的呼叫方式正確；單一 clip duration 200 → 回 200。）

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test -- publish.test` → PASS；`npm run typecheck` → 乾淨。

- [ ] **Step 5: Commit**

```bash
git add server/src/publish.ts server/test/publish.test.ts
git commit -m "feat(publish): buildPublishPackage — copy render output + srt + per-platform text + manifest"
```

---

### Task 4: MCP 工具 `export_publish_package`（鐵則三步的第三步）

**Files:**

- Modify: `server/src/mcp.ts`（`render` 工具附近註冊新工具；`instructions` 字串追加一句）
- Modify: `server/test/__snapshots__/`（mcp-surface-snapshot，讀 diff 後 `-u`）
- Test: `server/test/mcp-publish.test.ts`（新檔）

**Interfaces:**

- Consumes: Task 3 的 `buildPublishPackage`、`UPLOAD_URLS`；mcp.ts 既有 helpers `err` / `result` / `errResult` / `writeResultText`、`aiWrite`。
- Produces: MCP 工具 `export_publish_package`，input `{ tiktok?, youtube?, instagram?, facebook?: {title?, body, hashtags?, kind?}, ifVersion? }`，structured output `{ version, dir, files, warnings }`。

- [ ] **Step 1: 寫失敗測試**

`server/test/mcp-publish.test.ts`（setup 比照 `mcp-tools.test.ts`）：

```ts
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
import { makeVideo } from './fixtures.js';
import { tmpDir } from './tmp.js';

interface Structured {
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

let dir: string;
let store: ProjectStore;
let client: Client;

const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<Structured>;
const text = (r: Structured) => r.content.map((c) => c.text ?? '').join('');

beforeAll(async () => {
  dir = await tmpDir('vidcut-mcp-publish-');
  await makeVideo(dir, 'a.mp4', { duration: 4 });
  store = await ProjectStore.load(join(dir, 'project.json'));
  const deps: McpDeps = {
    store,
    projectDir: dir,
    editorContext: new EditorContext(),
    reviews: new ReviewManager(store, 900_000),
    baseUrl: 'http://127.0.0.1:3845',
    textCards: new TextCardService(dir, new PillowRasterizer(() => undefined)),
    chat: await ChatStore.load(join(dir, 'chat.json')),
  };
  const server = createMcpServer(deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  client = new Client({ name: 'test', version: '0' });
  await client.connect(ct);

  const imp = await call('import_media', { relPath: 'a.mp4', label: 'A' });
  const mediaId = (imp.structuredContent as { mediaId: string }).mediaId;
  await call('set_timeline', { clips: [{ mediaId, in: 0, duration: 3 }] });
  // 假成品：打包只複製檔案，不驗編碼
  await mkdir(join(dir, 'output'), { recursive: true });
  await writeFile(join(dir, 'output', 'pkg.mp4'), Buffer.alloc(2048, 1));
}, 180_000);

beforeEach(() => {
  store.mutate('human', 'reset render', (d) => {
    d.review = null;
    d.render = { status: 'done', lastOutput: join('output', 'pkg.mp4') };
  });
});

describe('export_publish_package', () => {
  it('packages files, records doc.render.publish, replies with upload urls', async () => {
    const r = await call('export_publish_package', {
      tiktok: { body: 'hi from vidcut', hashtags: ['fyp'] },
    });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { dir: string; files: string[]; warnings: string[] };
    expect(s.dir).toBe(join('output', 'publish', 'pkg'));
    for (const f of s.files) expect(existsSync(join(dir, f))).toBe(true);
    expect(store.doc.render.publish?.platforms).toEqual(['tiktok']);
    expect(text(r)).toContain('tiktokstudio/upload');
    const txt = await readFile(join(dir, s.dir, 'tiktok.txt'), 'utf8');
    expect(txt).toContain('#fyp');
  });

  it('rejects with no platform', async () => {
    const r = await call('export_publish_package', {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('at least one platform');
  });

  it('rejects before a finished render', async () => {
    store.mutate('human', 'reset', (d) => {
      d.render = { status: 'idle' };
    });
    const r = await call('export_publish_package', { tiktok: { body: 'x' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('render first');
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -- mcp-publish`
Expected: FAIL —— unknown tool `export_publish_package`。

- [ ] **Step 3: 註冊工具**

`server/src/mcp.ts`——檔頭 import 加：

```ts
import { buildPublishPackage, UPLOAD_URLS } from './publish.js';
import type { PublishInfo, PublishMeta, PublishPlatform } from '@vidcut/shared';
```

在 `render` 工具註冊之後加（zod schema 放同檔既有 schema 區也可）：

```ts
const publishMetaInput = z.object({
  title: z.string().optional().describe('YouTube/Facebook title; TikTok/Instagram ignore it'),
  body: z.string().describe('caption / description text'),
  hashtags: z.array(z.string()).optional().describe('without the leading #'),
  kind: z
    .enum(['short', 'video'])
    .optional()
    .describe(
      'target form — affects the duration/size warnings only. Defaults: youtube→short, facebook→video; ' +
        'tiktok/instagram are always short. Pass video for a long-form YouTube/Facebook upload.',
    ),
});

server.registerTool(
  'export_publish_package',
  {
    description:
      'Package the finished render for manual upload: copies the output video plus cover and .srt into ' +
      'output/publish/<stamp>/, writes one text file per platform from the metadata you provide, and records ' +
      'per-platform duration/size warnings in manifest.json. No social platform API is called — the user ' +
      'uploads by hand (per-platform upload URLs are in the reply). Requires a completed render, and at least ' +
      'one platform. Re-running replaces the package for that render.',
    outputSchema: {
      version: z.number(),
      dir: z.string().describe('package directory, relative to the project folder'),
      files: z.array(z.string()),
      warnings: z
        .array(z.string())
        .describe('per-platform duration/size warnings; empty when clean'),
    },
    inputSchema: {
      tiktok: publishMetaInput.optional(),
      youtube: publishMetaInput.optional(),
      instagram: publishMetaInput.optional(),
      facebook: publishMetaInput.optional(),
      ifVersion: z.number().optional(),
    },
  },
  async ({ tiktok, youtube, instagram, facebook, ifVersion }) => {
    // 比照 auto_caption：真正的守衛在 aiWrite，這裡先擋掉注定失敗的呼叫，免得白做檔案工作。
    if (store.doc.review !== null) return err('error: a review is in progress');
    const meta: Partial<Record<PublishPlatform, PublishMeta>> = {
      ...(tiktok ? { tiktok } : {}),
      ...(youtube ? { youtube } : {}),
      ...(instagram ? { instagram } : {}),
      ...(facebook ? { facebook } : {}),
    };
    let info: PublishInfo;
    try {
      info = await buildPublishPackage(projectDir, store.doc, meta);
    } catch (e) {
      return err(`error: ${(e as Error).message}`);
    }
    const w = aiWrite(store, { name: 'setPublish', info }, ifVersion);
    if (!w.ok) return err(writeResultText(w));
    const urls = info.platforms.map((p) => `${p}: ${UPLOAD_URLS[p]}`).join(' | ');
    return result(
      { version: w.version, dir: info.dir, files: info.files, warnings: info.warnings },
      `${writeResultText(w)} | packaged ${info.files.length} file(s) into ${info.dir} — upload at ${urls}` +
        (info.warnings.length > 0 ? `\n⚠️ ${info.warnings.join('; ')}` : ''),
    );
  },
);
```

（已核實：`McpDeps.projectDir` 是必填 `string`（`server/src/mcp.ts:31`），不需 guard。）

- [ ] **Step 4: instructions 同步**（鐵則：MCP 描述是 AI 唯一的文件）

`createMcpServer` 的 `instructions` 字串，在 render/subtitles 那句之後插入：

```
'After render, export_publish_package turns the finished video into a manual-upload package ' +
'(output/publish/<stamp>/: video + cover + .srt + one metadata text file per platform + manifest with ' +
'upload URLs and duration/size warnings) — write the platform captions/hashtags yourself and pass them in. ' +
'Platforms: tiktok / youtube / instagram / facebook; per-platform kind (short|video) picks the warning ' +
'thresholds — pass video for long-form YouTube/Facebook uploads. ' +
'No social platform API is involved, the user uploads by hand.' +
```

- [ ] **Step 5: 跑新測試與 snapshot**

Run: `npm test -- mcp-publish` → PASS。
Run: `npm test -- mcp-surface-snapshot` → **預期 FAIL**（工具面變了）。讀 diff：只該多出 `export_publish_package` 的描述/schema 與 instructions 那一句，且內容屬實。確認後：
`npm test -- mcp-surface-snapshot -u` → PASS。
再跑 `npm test -- mcp-docs-sync` 確認沒有文件同步斷言紅掉（紅了就照它的訊息補）。

- [ ] **Step 6: Commit**

```bash
git add server/src/mcp.ts server/test/mcp-publish.test.ts server/test/__snapshots__
git commit -m "feat(publish): export_publish_package MCP tool + instructions"
```

---

### Task 5: UI — ExportMenu 顯示上傳連結與發佈包

**Files:**

- Modify: `ui/src/panels/ExportMenu.tsx`
- Test: `ui/src/panels/ExportMenu.test.tsx`（新檔）

**Interfaces:**

- Consumes: `useProject((s) => s.doc?.render)` 既有；Task 1 的 `render.publish`。
- Produces: 純顯示，無新 API。UI 不提供「建立發佈包」按鈕（文案來自 AI；人要打包就在 Chat 請 AI 做——這是 spec 的刻意取捨）。

- [ ] **Step 1: 寫失敗測試**

`ui/src/panels/ExportMenu.test.tsx`：

```tsx
// 發佈包區塊：render done 之後顯示上傳頁連結；有 publish 時列出包內檔案與警告。
import { describe, it, expect, beforeEach } from 'vitest';
import { render as rtlRender, fireEvent, act } from '@testing-library/react';
import type { Project } from '@vidcut/shared';
import { ExportMenu } from './ExportMenu.js';
import { demoProject, resetStores, seedProject } from '../test/fixtures.js';

function seedWithRender(render: Project['render']) {
  const doc = demoProject();
  doc.render = render;
  seedProject(doc);
}

function openMenu(container: HTMLElement) {
  const chevron = container.querySelector('button[title="Export settings"]');
  if (!chevron) throw new Error('chevron not found');
  act(() => {
    fireEvent.click(chevron);
  });
}

beforeEach(() => {
  resetStores();
});

describe('ExportMenu — publish section', () => {
  it('shows upload links once render is done, even without a package', () => {
    seedWithRender({ status: 'done', lastOutput: 'output/r1.mp4' });
    const { container } = rtlRender(<ExportMenu />);
    openMenu(container);
    expect(
      container.querySelector('a[href="https://www.tiktok.com/tiktokstudio/upload"]'),
    ).not.toBeNull();
    expect(container.querySelector('a[href="https://studio.youtube.com/"]')).not.toBeNull();
    expect(container.querySelector('a[href="https://www.facebook.com/"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Publish package');
  });

  it('lists package files and warnings when publish exists', () => {
    seedWithRender({
      status: 'done',
      lastOutput: 'output/r1.mp4',
      publish: {
        dir: 'output/publish/r1',
        stamp: 'r1',
        platforms: ['tiktok'],
        files: ['output/publish/r1/video.mp4', 'output/publish/r1/tiktok.txt'],
        warnings: ['tiktok: video is 700s, over the 600s guideline'],
        createdAt: '2026-08-21T00:00:00.000Z',
      },
    });
    const { container } = rtlRender(<ExportMenu />);
    openMenu(container);
    expect(container.querySelector('a[href="/media/output/publish/r1/video.mp4"]')).not.toBeNull();
    expect(container.textContent).toContain('over the 600s guideline');
  });

  it('hides upload links before any render', () => {
    seedWithRender({ status: 'idle' });
    const { container } = rtlRender(<ExportMenu />);
    openMenu(container);
    expect(container.querySelector('a[href="https://studio.youtube.com/"]')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm test -- ExportMenu`
Expected: FAIL —— 找不到上傳連結。
（若 mount 就爆錯，多半是 jsdom 缺 polyfill——先看 `ui/src/test/setup.ts` 是否已涵蓋，比照 `panels.test.tsx` 的 mount 方式修 setup，不要在測試裡繞。）

- [ ] **Step 3: 實作**

`ui/src/panels/ExportMenu.tsx`——popover 內、既有 `render?.status === 'done' && render.lastOutput` 連結區塊之後加：

```tsx
{
  render?.status === 'done' && (
    <>
      <span className="panel-head">Upload</span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <a
          className="tag"
          href="https://www.tiktok.com/tiktokstudio/upload"
          target="_blank"
          rel="noreferrer"
        >
          TikTok
        </a>
        <a className="tag" href="https://studio.youtube.com/" target="_blank" rel="noreferrer">
          YouTube
        </a>
        <a className="tag" href="https://www.instagram.com/" target="_blank" rel="noreferrer">
          Instagram
        </a>
        <a className="tag" href="https://www.facebook.com/" target="_blank" rel="noreferrer">
          Facebook
        </a>
      </div>
      {render.publish && (
        <>
          <span className="panel-head">Publish package</span>
          {render.publish.files.map((f) => (
            <a
              key={f}
              href={`/media/${f}`}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 12 }}
            >
              {f.split('/').pop()}
            </a>
          ))}
          {render.publish.warnings.map((w) => (
            <span key={w} style={{ fontSize: 12, opacity: 0.85 }}>
              ⚠ {w}
            </span>
          ))}
        </>
      )}
    </>
  );
}
```

（上傳連結刻意寫死在 UI，不從 server 拿——它們與 `publish.ts` 的 `UPLOAD_URLS` 同值；改連結時兩處一起改，manifest 內以 server 版為準。）

- [ ] **Step 4: 跑測試確認通過並 build**

Run: `npm test -- ExportMenu` → PASS。
Run: `npm test -- panels` → 既有 panels 測試不受影響。
Run: `npm run build -w @vidcut/ui`（鐵則：不 build 的話 :3845 跑舊 UI）。

- [ ] **Step 5: Commit**

```bash
git add ui/src/panels/ExportMenu.tsx ui/src/panels/ExportMenu.test.tsx
git commit -m "feat(publish): upload links + publish package listing in ExportMenu"
```

---

### Task 6: 文件（PUBLISH.md、HANDOFF、交叉參考）與全量驗證

**Files:**

- Create: `docs/PUBLISH.md`
- Modify: `HANDOFF.md`（檔案職責清單加 `publish.ts` 一行）
- Modify: `CLAUDE.md`（交叉參考段加 PUBLISH.md 一行）

**Interfaces:** 無程式碼；文件內容如下。

- [ ] **Step 1: 寫 `docs/PUBLISH.md`**

```markdown
# 發佈：從 render 到各平台

vidcut P0 **不接任何社群平台 API**（利弊與成本調研見
`docs/superpowers/specs/2026-08-21-publish-package-p0.md` 的背景段）。
發佈走兩條路：發佈包手動上傳（本機與雲端都可），或使用者自己的 Buffer connector（僅雲端）。

## 發佈包（export_publish_package）

render 完成後，AI 呼叫 `export_publish_package` 並附各平台文案：

- 產出 `output/publish/<stamp>/`：`video.mp4`（成品複本；1080×1920 H.264 四平台通吃，
  不重轉檔）、`cover.jpg`（有設封面才有）、`subtitles.srt`（有字幕才有）、
  每平台一個 `<platform>.txt`（標題／內文／hashtags）、`manifest.json`。
- 每平台可帶 `kind: 'short' | 'video'` 指定目標形式（只影響警告門檻）：
  短片＝Shorts/Reels，`video`＝一般長片。預設 youtube→short、facebook→video；
  tiktok/instagram 只有 short。**長影片**（如 10 分鐘以上）發 YouTube/Facebook
  帶 `kind: 'video'` 即可，不會出現 Shorts 警告。
- 平台超限只**警告不擋**（見下表）；警告同時出現在工具回覆、manifest 與 ExportMenu。
- 重跑會整個目錄重建，舊平台檔不殘留。
- 建議搭配 `render` 的 `subtitles: 'sidecar'`——畫面乾淨、字幕交給平台（會自動翻譯）。

| 平台      | 上傳頁                                     | 警告門檻                                                     |
| --------- | ------------------------------------------ | ------------------------------------------------------------ |
| TikTok    | https://www.tiktok.com/tiktokstudio/upload | >600s、>4 GiB                                                |
| YouTube   | https://studio.youtube.com/                | short：>180s（超過就不算 Shorts）；video：>12 小時；>256 GiB |
| Instagram | https://www.instagram.com/                 | >180s（Reels 一般帳號）、>1 GiB                              |
| Facebook  | https://www.facebook.com/                  | short（Reels）：>90s、>4 GiB；video：>240 分鐘、>10 GiB      |

UI：Export 下拉在 render 完成後顯示四個上傳頁連結；打包後列出包內檔案與警告。

## Buffer connector 工作流（僅雲端部署）

使用者在自己的 AI client 連了 Buffer connector 時，agent 可以：
render（`subtitles: 'sidecar'`）→ `export_publish_package` 產文案 → 用 Buffer 的
create_post 建立貼文／排程，影片 URL 用部署站的 `/media/output/publish/<stamp>/video.mp4`。

⚠️ **本機（127.0.0.1:3845）不可行**：Buffer 抓不到本機 URL。本機一律走發佈包手動上傳。
發佈是不可逆動作——排程／發佈前先 `request_review` 取得使用者確認。

## Phase 1 之後（尚未實作）

聚合商一鍵發佈（upload-post／Ayrshare）屬 pro/cloud 線；`PublishProvider` 抽象與
OAuth 皆走雲端，不進開源 repo。見調研報告的分階段建議。
```

- [ ] **Step 2: HANDOFF.md 與 CLAUDE.md 各加一行**

- `HANDOFF.md`：檔案職責清單的 server 區塊（與 `render.ts` 同一列表）加：
  `- server/src/publish.ts —— 發佈包：平台限制警告、文案轉文字、buildPublishPackage（複製成品＋srt＋平台 txt＋manifest；不碰 doc，登記走 setPublish 命令）`
- `CLAUDE.md`：「交叉參考」段加：
  `- docs/PUBLISH.md —— 發佈路徑（發佈包／Buffer 工作流；P0 不接平台 API）`

- [ ] **Step 3: 全量驗證**

```bash
npm run typecheck && npm run lint && npm run format:check
npm test
```

Expected: 全綠。（要跑 `bash scripts/gauntlet.sh` 也可以，但**跑的時候不要 commit**。）

- [ ] **Step 4: commit 前文件審查**

用 `docs-sync-review` skill 過一輪（repo 自帶，commit 前的文件矩陣審查），特別確認：
mcp.ts 工具描述與 instructions、`mcp-docs-sync` 測試、README 是否需要提發佈包（依 skill 判定給出「已更新／查過無需改」結論）。

- [ ] **Step 5: Commit**

```bash
git add docs/PUBLISH.md HANDOFF.md CLAUDE.md
git commit -m "docs(publish): PUBLISH.md + file responsibilities + cross-refs"
```

---

## Self-Review（已跑）

1. **Spec 覆蓋**：資料模型（含 facebook 與 PublishKind）→Task 1；打包內容/平台×kind 檢查→Task 2–3；MCP 工具＋instructions＋snapshot→Task 4；UI（四平台連結）→Task 5；Buffer 文件、長影片 kind 說明與誠實註記→Task 6。無缺口。
2. **Placeholder 掃描**：無 TBD/TODO；先前兩處簽名疑點（`totalDuration`、`McpDeps.projectDir`）已直接核實寫死。
3. **型別一致性**：`PublishInfo`/`PublishMeta`/`PublishKind`/`PublishPlatform`/`setPublish`/`buildPublishPackage`/`UPLOAD_URLS`/`PLATFORM_LIMITS`/`resolveKind`/`platformWarnings`/`metaToText` 名稱在各 task 間一致；`platformWarnings` 的新簽名 `(p, kind, seconds, bytes)` 在 Task 2 測試、Task 3 實作與 manifest 產生處一致；UI 讀的 `render.publish` 形狀與 Task 1 定義一致；測試斷言的錯誤字串與實作字串逐字對齊。
