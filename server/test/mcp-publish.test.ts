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
