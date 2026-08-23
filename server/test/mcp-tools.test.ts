import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProjectStore } from '../src/store.js';
import { applyCommand } from '../src/commands.js';
import { ChatStore } from '../src/chatStore.js';
import { EditorContext } from '../src/editorContext.js';
import { ReviewManager } from '../src/reviews.js';
import { createMcpServer, type McpDeps } from '../src/mcp.js';
import type { ProjectTracks } from '@vidcut/shared';
import { makeVideo } from './fixtures.js';
import { TextCardService } from '../src/textCards.js';
import { PillowRasterizer } from '../src/rasterizer.js';
import { extractCover } from '../src/render.js';
import { tmpDir } from './tmp.js';

/**
 * MCP 工具面的覆蓋補齊：既有 mcp.test.ts 只驗了 5 條路徑（列表、import+set_timeline+
 * update_clip、editor context、stale ifVersion、request_review）。這裡逐一打其餘工具，
 * 確認它們真的改到 store，而不只是回一段好看的文字。
 */

interface Structured {
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

let dir: string;
let store: ProjectStore;
let client: Client;
let mediaId: string;
/** import + set_timeline 之後的軌道狀態，每個測試前還原（見 beforeEach）。 */
let baseline: ProjectTracks;

const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<Structured>;
const text = (r: Structured) => r.content.map((c) => c.text ?? '').join('');

beforeAll(async () => {
  dir = await tmpDir('vidcut-mcptools-');
  await makeVideo(dir, 'a.mp4', { duration: 6 });
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
  mediaId = (imp.structuredContent as { mediaId: string }).mediaId;
  await call('set_timeline', {
    clips: [
      { mediaId, in: 0, duration: 3, label: 'one' },
      { mediaId, in: 3, duration: 2, label: 'two' },
    ],
  });
  baseline = structuredClone(store.doc.tracks);
}, 180_000);

/**
 * 每個測試從同一個已知起點開始。素材匯入很貴（要跑 ffmpeg）所以留在 beforeAll，
 * 但軌道狀態每次重置——否則測試會互相依賴執行順序，隨機順序一跑就爆。
 */
beforeEach(() => {
  store.mutate('human', 'reset fixture', (d) => {
    d.tracks = structuredClone(baseline);
    d.render = { status: 'idle' };
    d.review = null;
    delete d.canvas.fit;
  });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('MCP tools that had no coverage', () => {
  it('set_overlays replaces the overlay track', async () => {
    await call('set_overlays', {
      overlays: [
        {
          id: 'o1',
          imagePath: 'title.png',
          start: 0,
          duration: 2,
          position: { x: 0.5, y: 0.1, scale: 1 },
        },
      ],
    });
    expect(store.doc.tracks.overlays).toHaveLength(1);
    expect(store.doc.tracks.overlays[0]!.imagePath).toBe('title.png');
  });

  it('set_captions replaces the caption track', async () => {
    const r = await call('set_captions', {
      captions: [
        {
          id: 'k1',
          text: 'hello',
          start: 0,
          duration: 2,
          style: { fontFamily: 'sans-serif', fontSize: 48, fill: '#fff', y: 0.8 },
        },
      ],
    });
    expect(r.isError ?? false).toBe(false);
    expect(store.doc.tracks.captions.map((c) => c.text)).toEqual(['hello']);
  });

  it('set_captions rejects a caption missing its style, leaving the track alone', async () => {
    const before = store.doc.tracks.captions.map((c) => c.id);
    const r = await call('set_captions', {
      captions: [{ id: 'bad', text: 'no style', start: 0, duration: 1 }],
    });
    expect(r.isError).toBe(true);
    expect(store.doc.tracks.captions.map((c) => c.id)).toEqual(before);
  });

  // 字幕 style 的 fontSize 以前完全沒有驗證：fontSize 20000 會被寫進文件，
  // 之後每一次 cardSync（每次載入專案都會跑）都拿它去產一張幾 GB 的卡，
  // 而 rasterizer 只有一個序列化的 worker——等於把字卡功能永久鎖死。
  it('set_captions 拒絕荒謬的 fontSize（schema 層），字幕軌不動', async () => {
    const before = store.doc.tracks.captions.map((c) => c.id);
    const r = await call('set_captions', {
      captions: [
        {
          id: 'huge',
          text: 'x',
          start: 0,
          duration: 1,
          style: { fontFamily: 'sans-serif', fontSize: 20000, fill: '#fff', y: 0.8 },
        },
      ],
    });
    expect(r.isError).toBe(true);
    // 指名要 schema 層擋下（訊息會帶上限值）：命令層的像素預算雖然也擋得住這個值，
    // 但那要等 zod 放行、走到 applyCommand 才會發生；schema 擋掉的錯誤訊息對模型更好讀。
    expect(text(r)).toMatch(/less than or equal to 512/);
    expect(store.doc.tracks.captions.map((c) => c.id)).toEqual(before);
  });

  it('set_captions 拒絕行數爆量的字幕（schema 過得了，命令層的像素預算擋下）', async () => {
    const before = store.doc.tracks.captions.map((c) => c.id);
    const r = await call('set_captions', {
      captions: [
        {
          id: 'lines',
          text: '\n'.repeat(4000),
          start: 0,
          duration: 1,
          style: { fontFamily: 'sans-serif', fontSize: 48, fill: '#fff', y: 0.8 },
        },
      ],
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/too large/);
    expect(store.doc.tracks.captions.map((c) => c.id)).toEqual(before);
  });

  it('update_caption 拒絕把既有字幕的 fontSize 改成荒謬值', async () => {
    await call('set_captions', {
      captions: [
        {
          id: 'c_ok',
          text: 'hello',
          start: 0,
          duration: 2,
          style: { fontFamily: 'sans-serif', fontSize: 48, fill: '#fff', y: 0.8 },
        },
      ],
    });
    const r = await call('update_caption', {
      id: 'c_ok',
      patch: { style: { fontFamily: 'sans-serif', fontSize: 30000, fill: '#fff', y: 0.8 } },
    });
    expect(r.isError).toBe(true);
    expect(store.doc.tracks.captions[0]!.style.fontSize).toBe(48);
  });

  it('set_canvas_fit switches between letterbox and blur', async () => {
    await call('set_canvas_fit', { fit: 'blur' });
    expect(store.doc.canvas.fit).toBe('blur');
    await call('set_canvas_fit', { fit: 'contain' });
    expect(store.doc.canvas.fit).toBe('contain');
  });

  it('reorder_clips permutes the main track', async () => {
    const ids = store.doc.tracks.video.map((c) => c.id);
    await call('reorder_clips', { order: [ids[1]!, ids[0]!] });
    expect(store.doc.tracks.video.map((c) => c.id)).toEqual([ids[1], ids[0]]);
  });

  it('reorder_clips rejects an order that is not a permutation', async () => {
    const before = store.doc.tracks.video.map((c) => c.id);
    const r = await call('reorder_clips', { order: ['nope'] });
    expect(text(r).toLowerCase()).toContain('permutation');
    expect(store.doc.tracks.video.map((c) => c.id)).toEqual(before);
  });

  it('timeline_op split cuts the clip under the given time', async () => {
    const before = store.doc.tracks.video.length;
    await call('timeline_op', { op: 'split', time: 1 });
    expect(store.doc.tracks.video.length).toBe(before + 1);
  });

  it('timeline_op freeze inserts a frozen clip', async () => {
    expect(store.doc.tracks.video.some((c) => c.frozen)).toBe(false);
    await call('timeline_op', { op: 'freeze', time: 0.5, duration: 1 });
    expect(store.doc.tracks.video.some((c) => c.frozen)).toBe(true);
  });

  it('extract_audio moves the clip sound onto the audio track and mutes the clip', async () => {
    const clip = store.doc.tracks.video.find((c) => !c.frozen)!;
    await call('extract_audio', { clipId: clip.id });
    expect(store.doc.tracks.audio.length).toBeGreaterThan(0);
    expect(store.doc.tracks.video.find((c) => c.id === clip.id)!.volume).toBe(0);
  });

  it('update_audio edits an audio item', async () => {
    await call('extract_audio', { clipId: store.doc.tracks.video[0]!.id });
    const a = store.doc.tracks.audio[0]!;
    await call('update_audio', { id: a.id, patch: { volume: 0.4, ducking: true } });
    const after = store.doc.tracks.audio.find((x) => x.id === a.id)!;
    expect(after.volume).toBe(0.4);
    expect(after.ducking).toBe(true);
  });

  it('set_audio replaces the whole audio track', async () => {
    await call('extract_audio', { clipId: store.doc.tracks.video[0]!.id });
    expect(store.doc.tracks.audio.length).toBeGreaterThan(0);
    await call('set_audio', { audio: [] });
    expect(store.doc.tracks.audio).toEqual([]);
  });

  it('remove_clip drops a clip from the main track', async () => {
    const target = store.doc.tracks.video[0]!;
    await call('remove_clip', { clipId: target.id });
    expect(store.doc.tracks.video.some((c) => c.id === target.id)).toBe(false);
  });

  it('undo restores the previous document', async () => {
    const before = store.doc.tracks.video.length;
    const victim = store.doc.tracks.video[0]!;
    await call('remove_clip', { clipId: victim.id });
    expect(store.doc.tracks.video.length).toBe(before - 1);

    await call('undo', {});
    expect(store.doc.tracks.video.length).toBe(before);
    expect(store.doc.tracks.video.some((c) => c.id === victim.id)).toBe(true);
  });

  it('redo re-applies the last undone edit', async () => {
    const before = store.doc.tracks.video.length;
    const victim = store.doc.tracks.video[0]!;
    await call('remove_clip', { clipId: victim.id });
    await call('undo', {});
    expect(store.doc.tracks.video.length).toBe(before);

    const r = await call('redo', {});
    expect(r.isError ?? false).toBe(false);
    expect(store.doc.tracks.video.length).toBe(before - 1);
    expect(store.doc.tracks.video.some((c) => c.id === victim.id)).toBe(false);
  });

  it('redo with nothing to redo is flagged isError', async () => {
    // redo 堆疊是 store 級狀態（beforeEach 的 fixture 重置含 render 欄位，
    // 不算可撤回編輯所以不會清它）。先做一筆真編輯——依分叉語意這會清空 redo——
    // 測試才不依賴其他測試的執行順序。
    await call('update_clip', { clipId: store.doc.tracks.video[0]!.id, patch: { label: 'x' } });
    const r = await call('redo', {});
    expect(text(r)).toContain('nothing to redo');
    expect(r.isError).toBe(true);
  });

  it('get_history reports the versions that were applied', async () => {
    const r = await call('get_history', {});
    const entries = (r.structuredContent?.history ?? []) as Array<{ label: string }>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => typeof e.label === 'string')).toBe(true);
  });

  it('get_frame returns a URL for a frame at the given time', async () => {
    const r = await call('get_frame', { time: 0.5 });
    expect(text(r) + JSON.stringify(r.structuredContent ?? {})).toMatch(/http|\.jpg|\.png/);
  });

  it('set_cover stores a cover image path', async () => {
    await call('set_cover', { time: 0.5 });
    expect(store.doc.render.coverPath).toBeTruthy();
  }, 60_000);

  it('get_feedback reports human changes since a version', async () => {
    const r = await call('get_feedback', { sinceVersion: 0 });
    expect(r.isError ?? false).toBe(false);
    expect(r.structuredContent).toMatchObject({
      sinceVersion: 0,
      currentVersion: store.version,
    });
  });

  it('get_feedback requires sinceVersion', async () => {
    const r = await call('get_feedback', {});
    expect(r.isError).toBe(true);
  });

  // Plan 8 final review F3：background ingest（A1/A2）補寫的 updateMediaDerived 是
  // source==='human'，但不是使用者的編輯意圖，不該出現在 get_feedback 的 humanChanges。
  it('get_feedback excludes background updateMediaDerived from humanChanges', async () => {
    const since = store.version;
    const derived = applyCommand(store, 'human', {
      name: 'updateMediaDerived',
      mediaId,
      patch: { filmstripPath: 'derived/x/filmstrip.jpg', filmstripTiles: 4 },
    });
    expect(derived.ok).toBe(true);
    const clip = store.doc.tracks.video[0]!;
    const real = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: clip.id,
      patch: { label: 'human renamed' },
    });
    expect(real.ok).toBe(true);

    const r = await call('get_feedback', { sinceVersion: since });
    const sc = r.structuredContent as { humanChanges: Array<{ label: string }> };
    expect(sc.humanChanges.some((h) => h.label.includes('update media derived'))).toBe(false);
    // 真人編輯（updateClip）的歷史 label 是 `edit ${clip.label ?? clip.id}`（見 commands.ts
    // 的 updateClip）——這裡用原本的 label/id 比對，確認它沒被連坐排除。
    expect(sc.humanChanges.some((h) => h.label === `edit ${clip.label ?? clip.id}`)).toBe(true);
  });
});

describe('list_source', () => {
  it('列出素材夾內的白名單檔案並標記已匯入者', async () => {
    const src = await tmpDir('vidcut-mcpsrc-');
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
    // 只斷言 isError 分不出「工具根本不存在」與「工具存在但目錄不存在」；
    // 這個前綴只有 list_source 真正執行、scanSourceFolder 丟錯時才會出現。
    expect(text(r)).toContain('list_source failed:');
  });

  // AI 的 context 有限，一個放了幾千支檔的素材夾不能整包塞回去。
  it('超過 200 筆只內嵌前 200 筆並標 truncated', async () => {
    const big = await tmpDir('vidcut-mcpbig-');
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

  it('帶 leadPad：黑墊落進新 clip，且沒有轉發漏字（曾經只在 schema 加了欄位卻沒接進 cmd）', async () => {
    const r = await call('add_clip', { mediaId, in: 0, duration: 3, leadPad: 1 });
    expect(r.isError ?? false).toBe(false);
    const sc = r.structuredContent as { clipId: string };
    const clip = store.doc.tracks.video.find((c) => c.id === sc.clipId);
    expect(clip?.leadPad).toBe(1);
  });
});

/**
 * Plan 14 Task 5：MCP 工具面曝光 leadPad（前把手黑墊，秒，duration 含墊、
 * 內容長度 = duration − leadPad）。命令層驗證早在 Task 1 落地（commands.ts），
 * 這裡只釘「MCP 這一層真的把欄位轉發進去、真的擋住非法值」。
 */
describe('leadPad（Plan 14 Task 5）', () => {
  it('update_clip 帶 leadPad 成功寫入', async () => {
    const clipId = store.doc.tracks.video[0]!.id;
    const r = await call('update_clip', { clipId, patch: { leadPad: 1.5 } });
    expect(r.isError ?? false).toBe(false);
    expect(store.doc.tracks.video[0]!.leadPad).toBe(1.5);
  });

  it('update_clip 的 leadPad 使內容長度低於下限時被拒（0.1s），文件不變', async () => {
    // beforeAll 的第一個 clip duration=3；leadPad=2.95 → 內容長度僅 0.05s < MIN_CLIP_DURATION
    const clipId = store.doc.tracks.video[0]!.id;
    const before = structuredClone(store.doc.tracks.video[0]!);
    const r = await call('update_clip', { clipId, patch: { leadPad: 2.95 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/content duration/);
    expect(store.doc.tracks.video[0]).toEqual(before);
  });

  it('update_clip 的 leadPad 為負數被拒', async () => {
    const clipId = store.doc.tracks.video[0]!.id;
    const r = await call('update_clip', { clipId, patch: { leadPad: -1 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/leadPad must be >= 0/);
  });

  it('set_timeline 不帶 leadPad 時歸零——既有 clip 的墊會被洗掉（整組替換的既定語意，非沿用）', async () => {
    // 先讓第一個 clip 帶上黑墊
    const clipId = store.doc.tracks.video[0]!.id;
    await call('update_clip', { clipId, patch: { leadPad: 1 } });
    expect(store.doc.tracks.video[0]!.leadPad).toBe(1);

    // 整組重送，spec 裡完全不帶 leadPad
    const spec = store.doc.tracks.video.map((c) => ({
      mediaId: c.mediaId,
      in: c.in,
      duration: c.duration,
    }));
    const r = await call('set_timeline', { clips: spec });
    expect(r.isError ?? false).toBe(false);
    for (const c of store.doc.tracks.video) expect(c.leadPad).toBeUndefined();
  });

  it('set_timeline 帶 leadPad 能設定，且內容長度不足時整批拒絕、文件不變', async () => {
    const before = structuredClone(store.doc.tracks.video);
    const r = await call('set_timeline', {
      clips: [{ mediaId, in: 0, duration: 2, leadPad: 1.95 }],
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/content duration/);
    expect(store.doc.tracks.video).toEqual(before);
  });

  it('get_project 摘要：leadPad>0 才曝光，=0/缺席不帶（與既有可選欄位慣例一致）', async () => {
    const padId = store.doc.tracks.video[0]!.id;
    const plainId = store.doc.tracks.video[1]!.id;
    await call('update_clip', { clipId: padId, patch: { leadPad: 0.5 } });

    const r = await call('get_project', {});
    const clips = (r.structuredContent as { clips: Array<Record<string, unknown>> }).clips;
    const padClip = clips.find((c) => c.id === padId)!;
    const plainClip = clips.find((c) => c.id === plainId)!;
    expect(padClip.leadPad).toBe(0.5);
    expect(plainClip.leadPad).toBeUndefined();
  });
});

/**
 * 批 G：outputSchema。
 *
 * 以前 31 個工具一個都沒宣告，其中十幾個卻回 structuredContent——client 無從驗證，
 * 模型只能從回覆文字裡猜欄位名。
 *
 * ⚠️ 宣告之後的兩個硬約束（都被下面的測試釘住）：
 * - 非 isError 的回覆**必須**帶 structuredContent，否則 SDK 直接丟 InvalidParams。
 * - 送給 client 的 JSON Schema 帶 `additionalProperties: false`，**多一個沒宣告的鍵，
 *   client 就拒收整個回覆**。實測 probeOutput 漏了 rotation → `data/probe must NOT
 *   have additional properties`。所以「只列保證有的欄位」是行不通的。
 */
describe('批 G：outputSchema', () => {
  it('每個工具都宣告了 outputSchema', async () => {
    const { tools } = await client.listTools();
    const missing = tools.filter((t) => !t.outputSchema).map((t) => t.name);
    expect(missing, `這些工具沒有 outputSchema：${missing.join(', ')}`).toEqual([]);
    expect(tools.length).toBeGreaterThanOrEqual(31);
  });

  it('宣告的 schema 一律禁止多餘欄位（所以宣告必須完整）', async () => {
    const { tools } = await client.listTools();
    const get = (n: string) =>
      tools.find((t) => t.name === n)!.outputSchema as Record<string, unknown>;
    // 這條不是在測 SDK，是把「宣告要完整」這個約束寫進測試——有人把某個 schema 改成
    // 只列一半欄位時，下面那些真的呼叫工具的測試會紅，而這條解釋為什麼。
    expect(get('get_frame').additionalProperties).toBe(false);
  });

  /**
   * render 以前只有錯誤路徑被打過（stamp、尺寸邊界），成功路徑的 structuredContent
   * 因此從沒被驗證過——而錯誤路徑**不會**觸發 outputSchema 驗證（SDK 對 isError 直接跳過）。
   * 用最小的輸出尺寸真的跑一次。
   */
  it('render 的成功回覆通過自己的 outputSchema', async () => {
    const r = await call('render', { stamp: 'g_out', subtitles: 'off', width: 64, height: 114 });
    expect(r.isError, text(r)).toBeFalsy();
    const s = r.structuredContent as { output: string; subtitles: string; captionsBurned: boolean };
    expect(s.output).toMatch(/g_out\.mp4$/);
    expect(s.subtitles).toBe('off');
    expect(typeof s.captionsBurned).toBe('boolean');
  }, 180_000);
});

/**
 * 批 D：輸入邊界。這幾條的共同性質是「以前不會噴錯，而是靜靜做了別的事」——
 * 回全部而不是零筆、回 ok 而什麼都沒改、把檔案寫到專案外。錯誤訊息比錯誤行為好。
 */
describe('批 D：輸入邊界', () => {
  it('get_history 的 limit:0 回零筆（以前 slice(-0) ＝ slice(0) ＝ 回全部）', async () => {
    // 先堆出足夠的歷史，否則「回全部」與「回零筆」在空歷史上長得一樣
    for (const fit of ['blur', 'contain', 'blur', 'contain'] as const) {
      await call('set_canvas_fit', { fit });
    }
    const all = (await call('get_history', { limit: 200 })).structuredContent as {
      history: unknown[];
    };
    expect(all.history.length).toBeGreaterThan(2);

    const zero = (await call('get_history', { limit: 0 })).structuredContent as {
      history: unknown[];
    };
    expect(zero.history).toHaveLength(0);

    const two = (await call('get_history', { limit: 2 })).structuredContent as {
      history: unknown[];
    };
    expect(two.history).toHaveLength(2);
  });

  it('get_history 的 limit 不接受負數（以前 -3 是「砍掉最舊的三筆」）', async () => {
    const r = await call('get_history', { limit: -3 });
    expect(r.isError).toBe(true);
  });

  /**
   * zod 預設 strip 未知鍵，所以打錯欄位名 → 空 patch → applyCommand 產生零個 immer
   * patch → 回一句 `ok, version=<沒動>`。呼叫端看到成功、文件卻沒變、也沒有警告。
   * 這正是 update_caption 的描述特別警告過的那種靜默 no-op，只是發生在 schema 層。
   */
  it('update_clip 打錯欄位名會被拒，不再靜默回 ok', async () => {
    const clipId = store.doc.tracks.video[0]!.id;
    const before = store.version;
    // clip 沒有 start 欄位（那是 overlay/caption 才有的）
    const r = await call('update_clip', { clipId, patch: { start: 2 } });
    expect(r.isError).toBe(true);
    expect(store.version).toBe(before);
  });

  it('update_audio 打錯欄位名會被拒（gain 不是 volume）', async () => {
    await call('extract_audio', { clipId: store.doc.tracks.video[0]!.id });
    const audioId = store.doc.tracks.audio[0]!.id;
    const before = store.version;
    const r = await call('update_audio', { id: audioId, patch: { gain: 0.5 } });
    expect(r.isError).toBe(true);
    expect(store.version).toBe(before);
  });

  it('合法欄位照樣通得過（strict 沒有把正常用法一起擋掉）', async () => {
    const clipId = store.doc.tracks.video[0]!.id;
    const r = await call('update_clip', { clipId, patch: { volume: 0.5 } });
    expect(r.isError).toBeFalsy();
    expect(store.doc.tracks.video[0]!.volume).toBe(0.5);
  });

  it('render 的 stamp 不能是路徑（會把成品寫到專案目錄外）', async () => {
    for (const stamp of ['../../escape', 'a/b', '..']) {
      const r = await call('render', { stamp });
      expect(r.isError, stamp).toBe(true);
    }
  });

  it('render 的尺寸有上下界，非整數會被拒', async () => {
    for (const bad of [{ width: 0 }, { width: 99999 }, { width: 100.5 }, { fps: 0 }]) {
      const r = await call('render', bad);
      expect(r.isError, JSON.stringify(bad)).toBe(true);
    }
  });

  /**
   * auto_caption 以前不論成敗都走 result()，寫入失敗時錯誤只藏在摘要文字開頭，
   * isError 是 false——任何靠 isError 判斷的客戶端都會把它當成功。
   * 這兩條走的是「早期守衛」那條路（審核中／版本已過期在呼叫當下就看得出來），
   * 順帶釘住「不要先燒掉一趟分鐘級的 whisper 再說」。
   */
  it('auto_caption 在審核進行中直接回錯，而且不跑辨識', async () => {
    store.mutate('ai', 'request review', (d) => {
      d.review = { id: 'r1', summary: 's', sinceVersion: 0, requestedAt: '' };
    });
    const t0 = Date.now();
    const r = await call('auto_caption', {});
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/review/);
    // 辨識要跑 ffmpeg 混音 + whisper，秒級起跳；早退應該是毫秒級
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('auto_caption 的 ifVersion 已過期時直接回錯，而且不跑辨識', async () => {
    const t0 = Date.now();
    const r = await call('auto_caption', { ifVersion: store.version + 999 });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/stale/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

/**
 * 批 E：寫入守衛與驗證去重。
 *
 * 兩件事：(1) import_media 與 set_cover 以前直接 store.mutate，兩層守衛都沒走，
 * 所以審核進行中照樣寫得進去（實測素材 11 → 12 筆）；現在它們跟其他寫入工具一樣
 * 走 aiWrite。(2) 同一條規則以前在「整組替換」與「改單項」兩處各寫一次然後分岔，
 * 現在只有一份（見 commands.ts 的 audioRuleError / captionRuleError）。
 */
describe('批 E：寫入守衛與驗證去重', () => {
  const CAP_STYLE = { fontFamily: 'sans-serif', fontSize: 48, fill: '#fff', y: 0.8 };

  const startReview = () =>
    store.mutate('ai', 'request review', (d) => {
      d.review = { id: 'rv', summary: 's', sinceVersion: 0, requestedAt: '' };
    });

  // 「已經匯入過」那條路會在守衛之前就短路，所以審核鎖要用一支**新**檔案才驗得準
  beforeAll(async () => {
    await makeVideo(dir, 'b.mp4', { duration: 3 });
  }, 120_000);

  /**
   * 兩件事一起釘：
   * - **素材沒有進來**——這條由 aiWrite 擋（真正的安全邊界）。
   * - **沒有先跑完 ffmpeg**——這條由工具開頭的早期守衛擋。少了它，proxy/filmstrip/peaks
   *   會整套跑完（分鐘級），最後才被 aiWrite 拒絕，而 `derived/<id>/` 已經留在磁碟上
   *   變成沒有任何人參照的孤兒目錄（prepareMedia 只在**自己失敗**時清理）。
   *   用 derived/ 的目錄數判斷，比計時穩。
   */
  it('import_media 在審核進行中被擋下，也不會先跑完 ffmpeg 留下孤兒目錄', async () => {
    startReview();
    const beforeMedia = store.doc.media.length;
    const beforeDerived = (await readdir(join(dir, 'derived'))).length;
    const r = await call('import_media', { relPath: 'b.mp4' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/review/);
    expect(store.doc.media).toHaveLength(beforeMedia);
    expect(await readdir(join(dir, 'derived'))).toHaveLength(beforeDerived);
  });

  it('set_cover 在審核進行中被擋下，coverPath 沒有被改', async () => {
    startReview();
    const r = await call('set_cover', { time: 0 });
    expect(r.isError).toBe(true);
    expect(store.doc.render.coverPath).toBeUndefined();
  });

  /**
   * 反向保險：審核鎖是**給 AI 的**。人在自己的審核期間當然還能動手——擋錯邊的話
   * 使用者會發現 UI 的「設為封面」在審核條出現時整個失效。
   */
  it('人的路徑（extractCover）不受審核鎖影響', async () => {
    startReview();
    const rel = await extractCover(store, dir, 0);
    expect(store.doc.render.coverPath).toBe(rel);
  });

  it('import_media 認得同一支檔的絕對路徑寫法（以前字串比對會多建一筆）', async () => {
    const before = store.doc.media.length;
    const r = await call('import_media', { relPath: join(dir, 'a.mp4') });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { mediaId: string }).mediaId).toBe(mediaId);
    expect(store.doc.media).toHaveLength(before);
  });

  it('set_captions 與 update_caption 對 duration<=0 一致（以前 set 收、update 拒）', async () => {
    const bad = await call('set_captions', {
      captions: [{ id: 'z', text: 'x', start: 0, duration: 0, style: CAP_STYLE }],
    });
    expect(bad.isError).toBe(true);
    expect(store.doc.tracks.captions.some((c) => c.id === 'z')).toBe(false);

    await call('set_captions', {
      captions: [{ id: 'z', text: 'x', start: 0, duration: 1, style: CAP_STYLE }],
    });
    expect((await call('update_caption', { id: 'z', patch: { duration: 0 } })).isError).toBe(true);
  });

  it('set_audio 與 update_audio 對 start<0 與 fade>duration 一致（以前 set 兩個都不驗）', async () => {
    await call('extract_audio', { clipId: store.doc.tracks.video[0]!.id });
    const a = store.doc.tracks.audio[0]!;
    const base = { id: 'x', mediaId: a.mediaId, start: 0, in: 0, duration: 1, volume: 1 };

    expect((await call('set_audio', { audio: [{ ...base, start: -5 }] })).isError).toBe(true);
    expect((await call('set_audio', { audio: [{ ...base, fadeIn: 99 }] })).isError).toBe(true);
    expect((await call('update_audio', { id: a.id, patch: { start: -5 } })).isError).toBe(true);
    // 合法的照樣過（新規則沒有把正常用法一起擋掉）
    expect((await call('set_audio', { audio: [base] })).isError).toBeFalsy();
  });

  /**
   * 「用改完之後的樣子跑規則」才抓得到的交互：只送 duration，但既有的 fadeOut 因此
   * 超出新長度。分開寫的版本只驗 patch 帶到的欄位，這種組合會整個漏掉。
   */
  it('update_audio 縮短 duration 時，連既有的 fadeOut 一起檢查', async () => {
    await call('extract_audio', { clipId: store.doc.tracks.video[0]!.id });
    const a = store.doc.tracks.audio[0]!;
    expect((await call('update_audio', { id: a.id, patch: { fadeOut: 1.5 } })).isError).toBeFalsy();
    const r = await call('update_audio', { id: a.id, patch: { duration: 0.5 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/fadeOut/);
  });

  it('字幕整段落在 t=0 之前會被拒（start<0 但看得到的仍然合法）', async () => {
    // 合法的「出血」：從 t<0 開始，但延伸進時間軸 → 成品的 between(t,-0.5,1.5) 從 0 顯示
    const bleed = await call('set_captions', {
      captions: [{ id: 'bleed', text: 'x', start: -0.5, duration: 2, style: CAP_STYLE }],
    });
    expect(bleed.isError, 'start<0 但看得到的不該被擋——跟 overlay 的出血立場一致').toBeFalsy();

    // 必然是算錯的形狀：end <= 0，成品裡永遠不會出現
    const never = await call('set_captions', {
      captions: [{ id: 'never', text: 'x', start: -99, duration: 1, style: CAP_STYLE }],
    });
    expect(never.isError).toBe(true);
    expect(text(never)).toMatch(/never appear/);
    expect(store.doc.tracks.captions.some((c) => c.id === 'never')).toBe(false);

    // update_caption 走同一份規則
    expect((await call('update_caption', { id: 'bleed', patch: { start: -99 } })).isError).toBe(
      true,
    );
  });

  it('什麼都沒改變時回報 no-op（以前跟真的改到東西一字不差）', async () => {
    const clip = store.doc.tracks.video[0]!;
    const before = store.version;
    const noop = await call('update_clip', { clipId: clip.id, patch: { volume: clip.volume } });
    expect(noop.isError).toBeFalsy();
    expect(text(noop)).toMatch(/no-op/);
    expect(store.version).toBe(before);

    const real = await call('update_clip', { clipId: clip.id, patch: { volume: 0.25 } });
    expect(text(real)).not.toMatch(/no-op/);
    expect(store.version).toBe(before + 1);
  });
});

/**
 * 批 F：set_timeline 不再是唯一繞過命令層的編輯工具，而且它弄斷錨點時會說出來。
 *
 * 舊行為的 clipId 是 `clip_${索引}_${mediaId}`——決定性，於是重排之後**同一個名字
 * 仍然存在、卻已經是另一個片段**。錨在它上面的 overlay 不是變孤兒（那還看得出來），
 * 而是靜靜地跑到別的時間點。實測同素材同順序重送一次：4 個 overlay 斷了 2 個、
 * 第 3 個的 anchor 名字還在但指到了後面一格。
 */
describe('批 F：set_timeline 的錨點與 clipId', () => {
  const anchoredOverlay = (clipId: string) => ({
    id: 'ov1',
    imagePath: 'x.png',
    anchor: { clipId, offset: 0 },
    duration: 1,
    position: { x: 0.5, y: 0.1, scale: 1 },
  });

  it('省略 id 時給的是不可預測的新 id，不會跟舊片段撞名', async () => {
    const spec = store.doc.tracks.video.map((c) => ({
      mediaId: c.mediaId,
      in: c.in,
      duration: c.duration,
    }));
    const oldIds = store.doc.tracks.video.map((c) => c.id);
    await call('set_timeline', { clips: spec });
    const newIds = store.doc.tracks.video.map((c) => c.id);
    expect(newIds).toHaveLength(oldIds.length);
    for (const id of newIds) expect(oldIds).not.toContain(id);
  });

  it('弄斷錨點時回覆會列出是哪幾個 overlay（不擋，但一定要說）', async () => {
    const clipId = store.doc.tracks.video[0]!.id;
    await call('set_overlays', { overlays: [anchoredOverlay(clipId)] });
    const r = await call('set_timeline', {
      clips: store.doc.tracks.video.map((c) => ({
        mediaId: c.mediaId,
        in: c.in,
        duration: c.duration,
      })),
    });
    expect(r.isError, '回報而不是拒絕——整組重排本來就是正當操作').toBeFalsy();
    expect(text(r)).toMatch(/ov1/);
    expect((r.structuredContent as { orphanedOverlays: string[] }).orphanedOverlays).toEqual([
      'ov1',
    ]);
  });

  it('把原本的 id 帶回來就保得住錨點，回覆也不再警告', async () => {
    const clipId = store.doc.tracks.video[0]!.id;
    await call('set_overlays', { overlays: [anchoredOverlay(clipId)] });
    const r = await call('set_timeline', {
      clips: store.doc.tracks.video.map((c) => ({
        id: c.id,
        mediaId: c.mediaId,
        in: c.in,
        duration: c.duration,
      })),
    });
    expect(r.isError).toBeFalsy();
    expect(text(r)).not.toMatch(/anchor|ov1/);
    expect(store.doc.tracks.overlays[0]!.anchor!.clipId).toBe(clipId);
  });

  it('remove_clip 弄斷錨點時同樣會回報', async () => {
    const clipId = store.doc.tracks.video[0]!.id;
    await call('set_overlays', { overlays: [anchoredOverlay(clipId)] });
    const r = await call('remove_clip', { clipId });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/ov1/);
  });

  // 搬進命令層之後邊界檢查仍然有效（這條擋的是 out-of-bounds，不是數值健檢——
  // NaN 才只有 numericError 擋得住，而 zod 讓它到不了這裡，所以那條在 commands.test.ts）。
  it('set_timeline 仍然拒絕超出來源長度的片段', async () => {
    const before = store.doc.tracks.video.length;
    const r = await call('set_timeline', {
      clips: [{ mediaId, in: 0, duration: 9999 }],
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/out of bounds/);
    expect(store.doc.tracks.video).toHaveLength(before);
  });

  it('set_timeline 拒絕重複的 clip id', async () => {
    const r = await call('set_timeline', {
      clips: [
        { id: 'dup', mediaId, in: 0, duration: 1 },
        { id: 'dup', mediaId, in: 1, duration: 1 },
      ],
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/duplicate/);
  });
});
