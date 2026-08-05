import { describe, it, expect, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ProjectStore } from '../src/store.js';
import { EditorContext } from '../src/editorContext.js';
import { ReviewManager } from '../src/reviews.js';
import { createMcpServer, type McpDeps } from '../src/mcp.js';
import { makeVideo } from './fixtures.js';
import { TextCardService } from '../src/textCards.js';
import { PillowRasterizer } from '../src/rasterizer.js';

interface Structured {
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
}

async function connect(timeoutMs = 900_000) {
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-mcp-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
  const editorContext = new EditorContext();
  const reviews = new ReviewManager(store, timeoutMs);
  const deps: McpDeps = {
    store,
    projectDir: dir,
    editorContext,
    reviews,
    baseUrl: 'http://127.0.0.1:3845',
    textCards: new TextCardService(dir, new PillowRasterizer(() => undefined)),
  };
  const server = createMcpServer(deps);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  return { dir, store, editorContext, reviews, client };
}

function textOf(r: unknown): string {
  const rr = r as Structured;
  return rr.content.map((c) => c.text ?? '').join('');
}

describe('mcp tools', () => {
  it('lists tools and reads empty project', async () => {
    const { client } = await connect();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('get_project');
    expect(names).toContain('request_review');
    expect(names).toContain('import_media');

    const r = (await client.callTool({ name: 'get_project', arguments: {} })) as Structured;
    expect(r.structuredContent).toMatchObject({ version: 0 });
  });

  it('imports media, sets timeline, and edits a clip via aiWrite', async () => {
    const { dir, store, client } = await connect();
    await makeVideo(dir, 'a.mp4', { duration: 6, withAudio: true });
    const imp = (await client.callTool({
      name: 'import_media',
      arguments: { relPath: 'a.mp4', label: 'N1' },
    })) as Structured;
    const mediaId = (imp.structuredContent as { mediaId: string }).mediaId;
    expect(mediaId).toBeTruthy();

    await client.callTool({
      name: 'set_timeline',
      arguments: { clips: [{ mediaId, in: 1, duration: 3, label: 'No.1' }] },
    });
    expect(store.doc.tracks.video).toHaveLength(1);
    const clipId = store.doc.tracks.video[0]!.id;

    const upd = await client.callTool({
      name: 'update_clip',
      arguments: { clipId, patch: { duration: 4 } },
    });
    expect(textOf(upd)).toMatch(/ok, version=/);
    expect(store.doc.tracks.video[0]!.duration).toBe(4);
  }, 60_000);

  it('reports editor context set via the holder', async () => {
    const { editorContext, client } = await connect();
    editorContext.set({ selection: { kind: 'clip', id: 'c1' }, playhead: 2.5, range: null });
    const r = (await client.callTool({ name: 'get_editor_context', arguments: {} })) as Structured;
    expect(r.structuredContent).toMatchObject({ playhead: 2.5, selection: { id: 'c1' } });
  });

  it('blocks ai writes with stale ifVersion', async () => {
    const { store, client } = await connect();
    store.mutate('ai', 'seed', (d) => {
      d.media = [
        {
          id: 'm1',
          path: 'a.mp4',
          probe: { duration: 20, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
      d.tracks.video = [{ id: 'c1', mediaId: 'm1', in: 0, duration: 5, volume: 1 }];
    });
    const r = await client.callTool({
      name: 'update_clip',
      arguments: { clipId: 'c1', patch: { duration: 6 }, ifVersion: 999 },
    });
    expect(textOf(r)).toMatch(/stale/);
  });

  it('request_review blocks until UI resolves, returns outcome + human changes', async () => {
    const { store, reviews, client } = await connect();
    store.mutate('ai', 'seed', (d) => {
      d.media = [
        {
          id: 'm1',
          path: 'a.mp4',
          probe: { duration: 20, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
      d.tracks.video = [{ id: 'c1', mediaId: 'm1', in: 0, duration: 5, volume: 1 }];
    });

    const callP = client.callTool({
      name: 'request_review',
      arguments: { summary: 'check my cut', focus: ['c1'] },
    });

    // 等 review 開啟後，模擬人在 UI 改東西並核准
    await vi.waitFor(() => expect(reviews.activeId).not.toBeNull());
    // 人的變更（審核期間）
    const { applyCommand } = await import('../src/commands.js');
    applyCommand(store, 'human', { name: 'updateClip', clipId: 'c1', patch: { duration: 3 } });
    reviews.resolve(reviews.activeId!, 'approved_with_notes', '收尾再快一點');

    const r = (await callP) as Structured;
    const sc = r.structuredContent as { outcome: string; humanChanges: unknown[] };
    expect(sc.outcome).toBe('approved_with_notes');
    expect(sc.humanChanges.length).toBeGreaterThanOrEqual(1);
    expect(store.doc.review).toBeNull();
  });
});
