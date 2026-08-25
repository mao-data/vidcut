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
    await addToLibrary(lib, join(srcDir, 'a.mp4'), {
      label: '片頭',
      tags: ['intro'],
      origin: { type: 'source' },
    });
    const j = (await (await fetch(`${base}/api/library?tag=intro`)).json()) as {
      assets: unknown[];
    };
    expect(j.assets).toHaveLength(1);
    const none = (await (await fetch(`${base}/api/library?query=bgm`)).json()) as {
      assets: unknown[];
    };
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
    const { asset } = await addToLibrary(lib, join(srcDir, 'a.mp4'), {
      origin: { type: 'source' },
    });
    const patched = await fetch(`${base}/api/library/${asset.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '新名字', tags: ['bgm'] }),
    });
    expect(patched.status).toBe(200);
    expect(lib.get(asset.id)?.label).toBe('新名字');
    expect(
      (
        await fetch(`${base}/api/library/lib-nope`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404);
    const del = await fetch(`${base}/api/library/${asset.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(existsSync(lib.fileAbs(asset))).toBe(false);
    server.close();
  }, 60_000);

  it('POST /:id/import 登記進專案；addToTimeline 上主軌；audio-only 上軌 400 但素材已登記', async () => {
    const { lib, srcDir, store, server, base } = await startTestServer();
    await makeVideo(srcDir, 'v.mp4', { duration: 2 });
    await makeAudio(srcDir, 'a.mp3', { duration: 1 });
    const v = (await addToLibrary(lib, join(srcDir, 'v.mp4'), { origin: { type: 'source' } }))
      .asset;
    const a = (await addToLibrary(lib, join(srcDir, 'a.mp3'), { origin: { type: 'source' } }))
      .asset;
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
    expect(
      (
        await fetch(`${base}/api/library/lib-nope/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404);
    server.close();
  }, 120_000);

  it('/library/files 靜態服務庫檔；traversal 被擋', async () => {
    const { lib, srcDir, server, base } = await startTestServer();
    await makeVideo(srcDir, 'a.mp4', { duration: 2 });
    const { asset } = await addToLibrary(lib, join(srcDir, 'a.mp4'), {
      origin: { type: 'source' },
    });
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
