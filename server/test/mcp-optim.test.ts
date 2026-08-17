import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProjectStore } from '../src/store.js';
import { ChatStore } from '../src/chatStore.js';
import { EditorContext } from '../src/editorContext.js';
import { ReviewManager } from '../src/reviews.js';
import { createMcpServer, type McpDeps } from '../src/mcp.js';
import type { ProjectTracks } from '@vidcut/shared';
import { makeAudio, makeVideo } from './fixtures.js';
import { transcribe as transcribeMock } from '../src/asr.js';
import { TextCardService } from '../src/textCards.js';
import { PillowRasterizer } from '../src/rasterizer.js';
import { tmpDir } from './tmp.js';

// whisper 是外部程序（mock 邊界）；B6 截斷邏輯在 mcp.ts，不在被 mock 的模組裡
vi.mock('../src/asr.js', () => ({ transcribe: vi.fn() }));

/**
 * MCP 層優化的驗收（spec 2026-08-02-mcp-optimizations）：
 * B1/B2 影像回傳、B3 isError、B4 細粒度工具、B5 readOnlyHint、B6 逐字稿截斷。
 */

interface Structured {
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

let dir: string;
let store: ProjectStore;
let client: Client;
let reviews: ReviewManager;
let mediaId: string;
let baseline: ProjectTracks;
let rasterizer: PillowRasterizer;

const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<Structured>;
const text = (r: Structured) => r.content.map((c) => c.text ?? '').join('');

beforeAll(async () => {
  dir = await tmpDir('vidcut-mcpoptim-');
  await makeVideo(dir, 'a.mp4', { duration: 6 });
  store = await ProjectStore.load(join(dir, 'project.json'));
  reviews = new ReviewManager(store, 900_000);
  rasterizer = new PillowRasterizer(() => undefined);
  const deps: McpDeps = {
    store,
    projectDir: dir,
    editorContext: new EditorContext(),
    reviews,
    baseUrl: 'http://127.0.0.1:3845',
    textCards: new TextCardService(dir, rasterizer),
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
  await call('set_captions', {
    captions: [
      {
        id: 'k1',
        text: 'hello',
        start: 0,
        duration: 2,
        style: { fontFamily: 'sans-serif', fontSize: 48, fill: '#fff', y: 0.8 },
        tokens: [{ text: 'hello', start: 0, end: 0.5 }],
      },
      {
        id: 'k2',
        text: 'world',
        start: 2,
        duration: 2,
        style: { fontFamily: 'sans-serif', fontSize: 48, fill: '#fff', y: 0.8 },
      },
    ],
  });
  await call('set_overlays', {
    overlays: [
      {
        id: 'o1',
        imagePath: 'a.png',
        start: 0,
        duration: 2,
        position: { x: 0.5, y: 0.2, scale: 1 },
      },
    ],
  });
  baseline = structuredClone(store.doc.tracks);
}, 180_000);

beforeEach(() => {
  store.mutate('human', 'reset fixture', (d) => {
    d.tracks = structuredClone(baseline);
    d.render = { status: 'idle' };
  });
});

afterAll(async () => {
  rasterizer.dispose();
  await rm(dir, { recursive: true, force: true });
});

// ---- B3 應用層錯誤標 isError ----
describe('B3 isError on application-level failures', () => {
  it('stale ifVersion via aiWrite is flagged isError', async () => {
    const r = await call('update_clip', {
      clipId: store.doc.tracks.video[0]!.id,
      patch: { label: 'x' },
      ifVersion: store.version + 999,
    });
    expect(text(r)).toContain('stale');
    expect(r.isError).toBe(true);
  });

  it('unknown id via the command layer is flagged isError', async () => {
    const r = await call('remove_clip', { clipId: 'nope' });
    expect(text(r)).toContain('not found');
    expect(r.isError).toBe(true);
  });

  it('set_timeline with an unknown mediaId is flagged isError', async () => {
    const r = await call('set_timeline', {
      clips: [{ mediaId: 'ghost', in: 0, duration: 1 }],
    });
    expect(text(r)).toContain('unknown mediaId');
    expect(r.isError).toBe(true);
  });

  it('audio-only media imports fine but is rejected as a video clip', async () => {
    await makeAudio(dir, 'vo.wav', { duration: 1 });
    const imp = await call('import_media', { relPath: 'vo.wav', label: 'VO' });
    expect(imp.isError).toBeFalsy();
    const audioId = (imp.structuredContent as { mediaId: string }).mediaId;

    const r = await call('set_timeline', {
      clips: [{ mediaId: audioId, in: 0, duration: 0.5 }],
    });
    expect(text(r)).toContain('audio-only');
    expect(r.isError).toBe(true);
  }, 60_000);

  it('set_timeline during a review is flagged isError', async () => {
    const pending = reviews.request('checking');
    const r = await call('set_timeline', {
      clips: [{ mediaId, in: 0, duration: 1 }],
    });
    reviews.resolve(reviews.activeId!, 'approved');
    await pending;
    expect(text(r)).toContain('review');
    expect(r.isError).toBe(true);
  });

  it('import_media failure is flagged isError', async () => {
    const r = await call('import_media', { relPath: 'does-not-exist.mp4' });
    expect(text(r)).toContain('import failed');
    expect(r.isError).toBe(true);
  });

  it('get_frame with no active clip is flagged isError', async () => {
    store.mutate('human', 'empty timeline', (d) => {
      d.tracks.video = [];
    });
    const r = await call('get_frame', { time: 1 });
    expect(text(r)).toContain('no active clip');
    expect(r.isError).toBe(true);
  });

  it('a successful write is not flagged isError', async () => {
    const r = await call('update_clip', {
      clipId: store.doc.tracks.video[0]!.id,
      patch: { label: 'renamed' },
    });
    expect(text(r)).toContain('ok');
    expect(r.isError ?? false).toBe(false);
  });
});

// ---- B1/B2 影像 content block（Claude Desktop 抓不到 127.0.0.1 的 URL）----
const jpegBlock = (r: Structured) => r.content.find((c) => c.type === 'image');
const isJpeg = (b64: string) => {
  const buf = Buffer.from(b64, 'base64');
  return buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8;
};

describe('B1/B2 image content blocks', () => {
  it('get_frame returns an inline JPEG image block plus the URL', async () => {
    const r = await call('get_frame', { time: 0.5 });
    const img = jpegBlock(r);
    expect(img?.mimeType).toBe('image/jpeg');
    expect(isJpeg(img?.data ?? '')).toBe(true);
    expect(JSON.stringify(r.structuredContent)).toContain('http://127.0.0.1:3845/media/');
  });

  it('set_cover returns an inline JPEG image block and records coverPath', async () => {
    const r = await call('set_cover', { time: 0.5 });
    const img = jpegBlock(r);
    expect(img?.mimeType).toBe('image/jpeg');
    expect(isJpeg(img?.data ?? '')).toBe(true);
    expect(store.doc.render.coverPath).toBeTruthy();
  }, 60_000);
});

// ---- B4 細粒度編輯工具（曝光既有命令層命令）----
describe('B4 fine-grained edit tools', () => {
  it('update_caption edits one caption and leaves the rest alone', async () => {
    const r = await call('update_caption', { id: 'k2', patch: { text: 'world!' } });
    expect(r.isError ?? false).toBe(false);
    expect(store.doc.tracks.captions.find((c) => c.id === 'k2')!.text).toBe('world!');
    expect(store.doc.tracks.captions.find((c) => c.id === 'k1')!.text).toBe('hello');
  });

  it('update_caption with tokens: [] clears word timestamps', async () => {
    expect(store.doc.tracks.captions.find((c) => c.id === 'k1')!.tokens).toBeTruthy();
    await call('update_caption', { id: 'k1', patch: { tokens: [] } });
    expect(store.doc.tracks.captions.find((c) => c.id === 'k1')!.tokens).toBeUndefined();
  });

  it('update_caption with an unknown id is flagged isError', async () => {
    const r = await call('update_caption', { id: 'ghost', patch: { text: 'x' } });
    expect(text(r)).toContain('not found');
    expect(r.isError).toBe(true);
  });

  it('update_caption honours ifVersion (stale write blocked)', async () => {
    const r = await call('update_caption', {
      id: 'k2',
      patch: { text: 'nope' },
      ifVersion: store.version + 999,
    });
    expect(r.isError).toBe(true);
    expect(store.doc.tracks.captions.find((c) => c.id === 'k2')!.text).toBe('world');
  });

  it('update_overlay moves an overlay', async () => {
    await call('update_overlay', { id: 'o1', patch: { start: 1.5 } });
    expect(store.doc.tracks.overlays.find((o) => o.id === 'o1')!.start).toBe(1.5);
  });

  // update_overlay 的 text 欄位描述宣告「只對本來就是文字 overlay 的項目有效」——
  // 這條測試釘住描述與行為一致（CLAUDE.md 鐵則）：對純圖 overlay 送 text 必須被拒，
  // 而不是靜默把使用者的 imagePath 換成產出來的文字卡。
  it('update_overlay refuses to turn a plain image overlay into a text card', async () => {
    const r = await call('update_overlay', {
      id: 'o1', // fixture 的 o1 是純圖 overlay（imagePath: a.png，沒有 text）
      patch: { text: { text: '偷換', fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' } },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('not a text overlay');
    const ov = store.doc.tracks.overlays.find((o) => o.id === 'o1')!;
    expect(ov.imagePath).toBe('a.png');
    expect(ov.text).toBeUndefined();
  }, 60_000);

  // update_caption 描述宣告「改 start 會連同 tokens 一起平移」——同上，釘住描述=行為。
  it('update_caption shifts word timestamps with the caption start', async () => {
    const r = await call('update_caption', { id: 'k1', patch: { start: 1.5 } });
    expect(r.isError).toBeFalsy();
    const c = store.doc.tracks.captions.find((x) => x.id === 'k1')!;
    expect(c.start).toBe(1.5);
    // 原本 0→0.5；往後平移 1.5 應為 1.5→2.0（方向寫反會是 -1.5→-1.0）
    expect(c.tokens).toEqual([{ text: 'hello', start: 1.5, end: 2 }]);
  });

  it('add_overlay appends and remove_overlay deletes', async () => {
    await call('add_overlay', {
      overlay: {
        id: 'o2',
        imagePath: 'b.png',
        start: 2,
        duration: 1,
        position: { x: 0.5, y: 0.5, scale: 1 },
      },
    });
    expect(store.doc.tracks.overlays.map((o) => o.id)).toContain('o2');
    await call('remove_overlay', { id: 'o2' });
    expect(store.doc.tracks.overlays.map((o) => o.id)).not.toContain('o2');
  });

  it('add_overlay with text creates an editable text overlay (server-made card)', async () => {
    const r = await call('add_overlay', {
      overlay: {
        id: 'txt1',
        text: { text: 'MCP 文字', fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' },
        start: 0,
        duration: 2,
        position: { x: 0.5, y: 0.3, scale: 1 },
      },
    });
    expect(r.isError).toBeFalsy();
    const ov = store.doc.tracks.overlays.find((o) => o.id === 'txt1')!;
    expect(ov.text?.text).toBe('MCP 文字');
    expect(ov.imagePath).toMatch(/derived\/text\//);

    const upd = await call('update_overlay', {
      id: 'txt1',
      patch: { text: { text: '改過', fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' } },
    });
    expect(upd.isError).toBeFalsy();
    expect(store.doc.tracks.overlays.find((o) => o.id === 'txt1')!.text?.text).toBe('改過');
  }, 60_000);

  it('set_overlays with a text-carrying overlay generates its card too (not just add/update_overlay)', async () => {
    const r = await call('set_overlays', {
      overlays: [
        {
          id: 'txt2',
          text: {
            text: 'set_overlays 文字',
            fontFamily: 'Heiti TC',
            fontSize: 64,
            fill: '#ffffff',
          },
          start: 0,
          duration: 2,
          position: { x: 0.5, y: 0.3, scale: 1 },
        },
      ],
    });
    expect(r.isError).toBeFalsy();
    const ov = store.doc.tracks.overlays.find((o) => o.id === 'txt2')!;
    expect(ov.imagePath).toMatch(/derived\/text\//);
    expect((await stat(join(dir, ov.imagePath))).size).toBeGreaterThan(0);
  }, 60_000);

  // text 與 imagePath 互斥。以前 imagePath 必填、文字 overlay 得傳空字串佔位，而那個空字串
  // 正是 commands.ts 視為「產卡前置沒跑」的毒藥哨兵；同時呼叫端給的真實路徑會被靜默丟棄。
  // 現在兩種誤用都要變成明確的 schema 錯誤（而不是靜默接受）。
  it('add_overlay rejects text together with imagePath instead of silently discarding the path', async () => {
    const r = await call('add_overlay', {
      overlay: {
        id: 'txt_both',
        imagePath: 'assets/hand_made.png',
        text: { text: '兩個都給', fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' },
        start: 0,
        duration: 2,
        position: { x: 0.5, y: 0.3, scale: 1 },
      },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/imagePath/);
    expect(store.doc.tracks.overlays.map((o) => o.id)).not.toContain('txt_both');
  });

  it('add_overlay rejects an overlay with neither text nor imagePath', async () => {
    const r = await call('add_overlay', {
      overlay: { id: 'txt_none', start: 0, duration: 2, position: { x: 0.5, y: 0.3, scale: 1 } },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/imagePath/);
    expect(store.doc.tracks.overlays.map((o) => o.id)).not.toContain('txt_none');
  });

  // 空字串是舊介面教人傳的值，也是 render 時會變成「把專案目錄餵給 ffmpeg」的那個值。
  // 純圖 overlay 給空字串必須擋在 schema，不能靠下游。
  it('add_overlay rejects an empty imagePath on a pure-image overlay', async () => {
    const r = await call('add_overlay', {
      overlay: {
        id: 'img_empty',
        imagePath: '',
        start: 0,
        duration: 2,
        position: { x: 0.5, y: 0.3, scale: 1 },
      },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/imagePath/);
    expect(store.doc.tracks.overlays.map((o) => o.id)).not.toContain('img_empty');
  });

  it('set_overlays applies the same exclusivity rule (shared schema, both entry points)', async () => {
    const before = store.doc.tracks.overlays.map((o) => o.id);
    const r = await call('set_overlays', {
      overlays: [
        {
          id: 'txt_both2',
          imagePath: 'assets/hand_made.png',
          text: { text: '兩個都給', fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' },
          start: 0,
          duration: 2,
          position: { x: 0.5, y: 0.3, scale: 1 },
        },
      ],
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/imagePath/);
    // 整組替換被擋下時不可以留下半套狀態（原本的軌必須原封不動）
    expect(store.doc.tracks.overlays.map((o) => o.id)).toEqual(before);
  });

  it('remove_audio deletes one audio item', async () => {
    await call('set_audio', {
      audio: [{ id: 'a1', mediaId, start: 0, in: 0, duration: 1, volume: 1 }],
    });
    const r = await call('remove_audio', { id: 'a1' });
    expect(r.isError ?? false).toBe(false);
    expect(store.doc.tracks.audio).toEqual([]);
  });
});

// ---- B5 讀取類工具標 readOnlyHint ----
describe('B5 readOnlyHint annotations', () => {
  it('read tools advertise readOnlyHint: true', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of [
      'get_project',
      'get_history',
      'get_feedback',
      'get_editor_context',
      'get_frame',
      'list_source',
    ]) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
    }
  });

  /**
   * transcribe 曾經在上面那份清單裡，2026-08-05 移出來。
   *
   * 它確實「不改專案狀態」——但 readOnlyHint 不是拿來描述這件事的：host 會用它來
   * **免權限提示**，語意是「便宜、可重複、沒有副作用」。而 transcribe 會跑一次全時間軸
   * 混音（ffmpeg）再跑 whisper（分鐘級），並寫 derived/asr.wav 與 derived/asr.json
   * ——後者的路徑還當成 jsonPath 回傳，等於自己承認寫了檔。
   *
   * 反向釘住：這是一個決定，不是漏標。哪天有人「順手補齊」把它加回去，這條會擋下來。
   */
  it('transcribe 刻意不標 readOnlyHint（它是分鐘級的、而且寫檔）', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'transcribe');
    expect(t, 'transcribe 應該存在').toBeDefined();
    expect(t?.annotations?.readOnlyHint ?? false).toBe(false);
  });

  it('write tools do not claim to be read-only', async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      if (
        ['update_clip', 'set_captions', 'update_caption', 'render', 'set_cover'].includes(t.name)
      ) {
        expect(t.annotations?.readOnlyHint ?? false, t.name).toBe(false);
      }
    }
  });
});

// ---- B6 transcribe 長逐字稿截斷（whisper 已 mock）----
const mkWords = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ text: `w${i}`, start: i * 0.1, end: i * 0.1 + 0.05 }));

describe('B6 transcribe word truncation', () => {
  it('over 1000 words: structured words capped at 1000, wordsTruncated true, wordCount total', async () => {
    vi.mocked(transcribeMock).mockResolvedValue({
      language: 'en',
      words: mkWords(1500),
      text: 'long transcript',
      audioPath: 'derived/mix.wav',
      jsonPath: 'derived/transcript.json',
      model: 'test',
    });
    const r = await call('transcribe', {});
    const s = r.structuredContent as {
      words: unknown[];
      wordCount: number;
      wordsTruncated?: boolean;
      jsonPath: string;
    };
    expect(s.words).toHaveLength(1000);
    expect(s.wordsTruncated).toBe(true);
    expect(s.wordCount).toBe(1500);
    expect(s.jsonPath).toBe('derived/transcript.json');
  });

  it('at or under 1000 words: full list, no truncation flag', async () => {
    vi.mocked(transcribeMock).mockResolvedValue({
      language: 'en',
      words: mkWords(5),
      text: 'short',
      audioPath: 'derived/mix.wav',
      jsonPath: 'derived/transcript.json',
      model: 'test',
    });
    const r = await call('transcribe', {});
    const s = r.structuredContent as { words: unknown[]; wordsTruncated?: boolean };
    expect(s.words).toHaveLength(5);
    expect(s.wordsTruncated ?? false).toBe(false);
  });
});

/**
 * 回歸：auto_caption 不帶參數時分頁上限必須生效。
 *
 * 這條守的是「工具 handler → buildCaptionPages」那道縫。handler 把四個 zod optional
 * 直接組成物件（`{ karaoke, maxGapMs, maxDurationMs, maxUnits }`），沒給的時候值是
 * undefined 但 key 存在；分頁函式從前用物件展開套預設值，undefined 會把預設值蓋掉，
 * 三個上限全成 `> undefined`＝恆 false，只剩句末標點在斷頁。實測 25 個詞、7.3 秒被
 * 塞成單頁。captions.test.ts 有對稱的一條守分頁函式本身——**兩條都要有**：那個 bug
 * 之所以能同時通過兩邊的測試，就是因為函式的測試都傳明確值、工具的測試只跑錯誤路徑。
 */
describe('auto_caption 預設參數', () => {
  it('不帶參數時仍會依 maxDurationMs 預設分頁，不會塞成一頁', async () => {
    // 25 個無標點的詞、每詞 0.3 秒 → 總長 7.4 秒，遠超單頁 2500ms 預設
    vi.mocked(transcribeMock).mockResolvedValue({
      language: 'en',
      words: Array.from({ length: 25 }, (_, i) => ({
        text: `word${i}`,
        start: i * 0.3,
        end: i * 0.3 + 0.28,
      })),
      text: 'no punctuation at all',
      audioPath: 'derived/mix.wav',
      jsonPath: 'derived/transcript.json',
      model: 'test',
    });
    const r = await call('auto_caption', {});
    const s = r.structuredContent as {
      captionCount: number;
      captions: Array<{ duration: number }>;
    };
    expect(s.captionCount).toBeGreaterThan(1);
    for (const c of s.captions) expect(c.duration).toBeLessThanOrEqual(2.5 + 0.3);
  });
});
