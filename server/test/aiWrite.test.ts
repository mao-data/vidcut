import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { aiWrite } from '../src/aiWrite.js';
import { EditorContext } from '../src/editorContext.js';

async function seeded() {
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-aiw-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
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
  return store;
}

describe('aiWrite guards', () => {
  it('passes through to applyCommand when clear', async () => {
    const store = await seeded();
    const r = aiWrite(store, { name: 'updateClip', clipId: 'c1', patch: { duration: 6 } });
    expect(r.ok).toBe(true);
    expect(store.doc.tracks.video[0]!.duration).toBe(6);
  });

  it('blocks writes while a review is in progress', async () => {
    const store = await seeded();
    store.mutate('ai', 'open review', (d) => {
      d.review = { id: 'r1', summary: 's', sinceVersion: 1, requestedAt: 'now' };
    });
    const r = aiWrite(store, { name: 'updateClip', clipId: 'c1', patch: { duration: 7 } });
    expect(r).toMatchObject({ ok: false });
    expect(store.doc.tracks.video[0]!.duration).toBe(5);
  });

  it('rejects stale writes when ifVersion mismatches', async () => {
    const store = await seeded();
    const r = aiWrite(store, { name: 'updateClip', clipId: 'c1', patch: { duration: 8 } }, 999);
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && /stale/.test(r.error)).toBe(true);
  });

  it('accepts write when ifVersion matches current', async () => {
    const store = await seeded();
    const r = aiWrite(
      store,
      { name: 'updateClip', clipId: 'c1', patch: { duration: 9 } },
      store.version,
    );
    expect(r.ok).toBe(true);
  });
});

describe('EditorContext', () => {
  it('stores and returns context data', () => {
    const ctx = new EditorContext();
    expect(ctx.get().playhead).toBe(0);
    ctx.set({ selection: { kind: 'clip', id: 'c1' }, playhead: 3.5, range: { start: 1, end: 2 } });
    expect(ctx.get()).toMatchObject({ playhead: 3.5, selection: { id: 'c1' } });
  });
});
