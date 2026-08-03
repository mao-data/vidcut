import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { ProjectStore } from '../src/store.js';
import { createApp } from '../src/app.js';

async function startTestServer() {
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-source-api-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
  const server: Server = createServer(createApp(store, dir));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { dir, store, server, base: `http://127.0.0.1:${port}` };
}

interface SourceRes {
  dir: string;
  files: Array<{ name: string; size: number; mtime: number; imported: boolean }>;
}

describe('GET /api/source', () => {
  it('列出素材夾內的可匯入檔案', async () => {
    const { server, base } = await startTestServer();
    const src = await mkdtemp(join(tmpdir(), 'vidcut-api-src-'));
    await writeFile(join(src, 'a.mp4'), 'x');
    await writeFile(join(src, 'readme.txt'), 'x');

    const res = await fetch(`${base}/api/source?dir=${encodeURIComponent(src)}`);
    expect(res.status).toBe(200);
    const j = (await res.json()) as SourceRes;
    expect(j.files.map((f) => f.name)).toEqual(['a.mp4']);
    expect(j.files[0]!.imported).toBe(false);
    server.close();
  });

  it('已匯入的檔案標記 imported', async () => {
    const { store, server, base } = await startTestServer();
    const src = await mkdtemp(join(tmpdir(), 'vidcut-api-src2-'));
    await writeFile(join(src, 'a.mp4'), 'x');
    store.mutate('ai', 'seed', (d) => {
      d.media = [
        {
          id: 'm1',
          path: join(src, 'a.mp4'),
          probe: { duration: 5, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
    });

    const res = await fetch(`${base}/api/source?dir=${encodeURIComponent(src)}`);
    const j = (await res.json()) as SourceRes;
    expect(j.files[0]!.imported).toBe(true);
    server.close();
  });

  it('目錄不存在回 400', async () => {
    const { server, base } = await startTestServer();
    const res = await fetch(`${base}/api/source?dir=/definitely/not/here`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
    server.close();
  });

  it('沒帶 dir 回 400', async () => {
    const { server, base } = await startTestServer();
    const res = await fetch(`${base}/api/source`);
    expect(res.status).toBe(400);
    server.close();
  });

  it('相對路徑媒體被正確標記 imported（驗證 resolveMediaPath）', async () => {
    const { dir, store, server, base } = await startTestServer();
    // 在 projectDir 下寫檔案
    await writeFile(join(dir, 'a.mp4'), 'x');
    // store 存相對路徑
    store.mutate('ai', 'seed', (d) => {
      d.media = [
        {
          id: 'm1',
          path: 'a.mp4',
          probe: { duration: 5, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
    });

    // 掃描 projectDir 本身
    const res = await fetch(`${base}/api/source?dir=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(200);
    const j = (await res.json()) as SourceRes;
    expect(j.files[0]!.imported).toBe(true);
    server.close();
  });
});
