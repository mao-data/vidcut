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
