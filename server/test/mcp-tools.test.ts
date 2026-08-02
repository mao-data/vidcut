import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProjectStore } from '../src/store.js';
import { EditorContext } from '../src/editorContext.js';
import { ReviewManager } from '../src/reviews.js';
import { createMcpServer, type McpDeps } from '../src/mcp.js';
import { makeVideo } from './fixtures.js';

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
}, 180_000);

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
    await call('reorder_clips', { order: ids }); // 還原給後續測試
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
    const a = store.doc.tracks.audio[0]!;
    await call('update_audio', { id: a.id, patch: { volume: 0.4, ducking: true } });
    const after = store.doc.tracks.audio.find((x) => x.id === a.id)!;
    expect(after.volume).toBe(0.4);
    expect(after.ducking).toBe(true);
  });

  it('set_audio replaces the whole audio track', async () => {
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
