import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { ProjectStore } from '../src/store.js';
import { createApp } from '../src/app.js';

async function startTestServer() {
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-assets-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
  const server: Server = createServer(createApp(store, dir));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { dir, server, base: `http://127.0.0.1:${port}` };
}

describe('POST /assets', () => {
  it('writes the file under assets/ and returns relPath', async () => {
    const { dir, server, base } = await startTestServer();
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const res = await fetch(`${base}/assets?name=title.png`, { method: 'POST', body });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { relPath: string };
    expect(j.relPath).toBe('assets/title.png');
    expect(await readFile(join(dir, j.relPath))).toEqual(body);
    server.close();
  });

  it('sanitizes path traversal in the filename', async () => {
    const { server, base } = await startTestServer();
    const res = await fetch(`${base}/assets?name=../../evil.png`, {
      method: 'POST',
      body: Buffer.from('x'),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { relPath: string };
    // 只留 basename，不得逃出 assets/
    expect(j.relPath).toBe('assets/evil.png');
    server.close();
  });

  it('auto-renames on collision', async () => {
    const { dir, server, base } = await startTestServer();
    await writeFile(join(dir, 'assets', '..', 'placeholder'), '').catch(() => {});
    const up = (name: string) =>
      fetch(`${base}/assets?name=${name}`, { method: 'POST', body: Buffer.from('x') }).then(
        (r) => r.json() as Promise<{ relPath: string }>,
      );
    const a = await up('t.png');
    const b = await up('t.png');
    expect(a.relPath).toBe('assets/t.png');
    expect(b.relPath).toBe('assets/t-1.png');
    server.close();
  });

  it('rejects missing name', async () => {
    const { server, base } = await startTestServer();
    const res = await fetch(`${base}/assets`, { method: 'POST', body: Buffer.from('x') });
    expect(res.status).toBe(400);
    server.close();
  });
});
