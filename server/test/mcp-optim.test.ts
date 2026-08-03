import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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

const call = (name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<Structured>;
const text = (r: Structured) => r.content.map((c) => c.text ?? '').join('');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vidcut-mcpoptim-'));
  await makeVideo(dir, 'a.mp4', { duration: 6 });
  store = await ProjectStore.load(join(dir, 'project.json'));
  reviews = new ReviewManager(store, 900_000);
  const deps: McpDeps = {
    store,
    projectDir: dir,
    editorContext: new EditorContext(),
    reviews,
    baseUrl: 'http://127.0.0.1:3845',
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
      { id: 'o1', imagePath: 'a.png', start: 0, duration: 2, position: { x: 0.5, y: 0.2, scale: 1 } },
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
