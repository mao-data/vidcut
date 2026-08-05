import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { WsServerMsg } from '@vidcut/shared';
import { startServer } from '../src/index.js';
import { tmpDir } from './tmp.js';

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

describe('ws command channel', () => {
  it('applies a command from the client and broadcasts a human patch; bad command errors', async () => {
    const dir = await tmpDir('vidcut-wscmd-');
    const { server, store } = await startServer(dir, 0);
    store.mutate('ai', 'seed', (d) => {
      d.media = [
        {
          id: 'm1',
          path: 'a.mp4',
          probe: { duration: 20, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
      d.tracks.video = [{ id: 'c1', mediaId: 'm1', in: 0, duration: 5, volume: 1, label: 'A' }];
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    close = () => new Promise((r) => server.close(() => r()));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await nextMsg(ws); // full

    const patchP = nextMsg(ws);
    ws.send(
      JSON.stringify({
        type: 'command',
        cmd: { name: 'updateClip', clipId: 'c1', patch: { duration: 6 } },
      }),
    );
    const patch = await patchP;
    expect(patch).toMatchObject({ type: 'patch', source: 'human' });
    expect(store.doc.tracks.video[0]!.duration).toBe(6);

    const errP = nextMsg(ws);
    ws.send(
      JSON.stringify({
        type: 'command',
        reqId: 'r9',
        cmd: { name: 'updateClip', clipId: 'nope', patch: { duration: 1 } },
      }),
    );
    const err = await errP;
    expect(err).toMatchObject({ type: 'commandError', reqId: 'r9' });
    ws.close();
  });
});
