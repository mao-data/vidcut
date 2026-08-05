import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProjectStore } from '../src/store.js';
import { EditorContext } from '../src/editorContext.js';
import { ReviewManager } from '../src/reviews.js';
import { createMcpServer, type McpDeps } from '../src/mcp.js';
import type { ProjectTracks } from '@vidcut/shared';
import { makeVideo } from './fixtures.js';
import { TextCardService } from '../src/textCards.js';
import { PillowRasterizer } from '../src/rasterizer.js';

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
  dir = await mkdtemp(join(tmpdir(), 'vidcut-mcptools-'));
  await makeVideo(dir, 'a.mp4', { duration: 6 });
  store = await ProjectStore.load(join(dir, 'project.json'));
  const deps: McpDeps = {
    store,
    projectDir: dir,
    editorContext: new EditorContext(),
    reviews: new ReviewManager(store, 900_000),
    baseUrl: 'http://127.0.0.1:3845',
    textCards: new TextCardService(dir, new PillowRasterizer(() => undefined)),
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
});

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
    // 只斷言 isError 分不出「工具根本不存在」與「工具存在但目錄不存在」；
    // 這個前綴只有 list_source 真正執行、scanSourceFolder 丟錯時才會出現。
    expect(text(r)).toContain('list_source failed:');
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
