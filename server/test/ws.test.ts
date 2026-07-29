import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { WsServerMsg } from '@vidcut/shared';
import { startServer } from '../src/index.js';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

function nextMsg(ws: WebSocket): Promise<WsServerMsg> {
  return new Promise((resolve, reject) => {
    ws.once('message', (d) => resolve(JSON.parse(d.toString())));
    ws.once('error', reject);
  });
}

describe('ws sync', () => {
  it('sends full on connect, then patches on mutate; media served with Range', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-ws-'));
    await writeFile(join(dir, 'blob.bin'), Buffer.alloc(100, 7));
    const { server, store } = await startServer(dir, 0); // port 0 = 隨機
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    close = () => new Promise((r) => server.close(() => r()));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const full = await nextMsg(ws);
    expect(full.type).toBe('full');
    if (full.type !== 'full') throw new Error('unreachable');
    expect(full.version).toBe(0);

    const patchP = nextMsg(ws);
    store.mutate('ai', 'rename', (d) => {
      d.name = 'x';
    });
    const patch = await patchP;
    expect(patch).toMatchObject({ type: 'patch', version: 1, source: 'ai', label: 'rename' });

    // resync
    const fullP = nextMsg(ws);
    ws.send(JSON.stringify({ type: 'resync' }));
    const full2 = await fullP;
    expect(full2).toMatchObject({ type: 'full', version: 1 });
    ws.close();

    // /media Range
    const res = await fetch(`http://127.0.0.1:${port}/media/blob.bin`, {
      headers: { Range: 'bytes=0-9' },
    });
    expect(res.status).toBe(206);
    expect((await res.arrayBuffer()).byteLength).toBe(10);

    // /api/project
    const api = await fetch(`http://127.0.0.1:${port}/api/project`);
    expect(((await api.json()) as { version: number }).version).toBe(1);
  });
});
