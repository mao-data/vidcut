import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { applyCommand } from '../src/commands.js';

async function storeWithClips() {
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-cmd-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
  store.mutate('ai', 'seed', (d) => {
    d.media = [
      {
        id: 'm1',
        path: 'a.mp4',
        probe: { duration: 20, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
      },
      {
        id: 'm2',
        path: 'b.mp4',
        probe: { duration: 20, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
      },
    ];
    d.tracks.video = [
      { id: 'c1', mediaId: 'm1', in: 2, duration: 5, volume: 1, label: 'No.1' },
      { id: 'c2', mediaId: 'm2', in: 0, duration: 4, volume: 1, label: 'No.2' },
    ];
    d.tracks.captions = [
      {
        id: 'cap1',
        text: 'hi',
        start: 0,
        duration: 3,
        style: { fontFamily: 'sans-serif', fontSize: 48, fill: '#fff', y: 0.8 },
      },
    ];
  });
  return store;
}

describe('applyCommand', () => {
  it('updateClip trims within source bounds', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'c1',
      patch: { duration: 6 },
    });
    expect(r.ok).toBe(true);
    expect(store.doc.tracks.video[0]!.duration).toBe(6);
  });

  it('updateClip rejects trim beyond source duration', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'c1',
      patch: { in: 18, duration: 5 }, // 18+5=23 > 20
    });
    expect(r).toMatchObject({ ok: false });
    expect(store.doc.tracks.video[0]!.in).toBe(2); // 未變
  });

  it('updateClip rejects negative in and tiny duration', async () => {
    const store = await storeWithClips();
    expect(
      applyCommand(store, 'human', { name: 'updateClip', clipId: 'c1', patch: { in: -1 } }).ok,
    ).toBe(false);
    expect(
      applyCommand(store, 'human', { name: 'updateClip', clipId: 'c1', patch: { duration: 0.01 } })
        .ok,
    ).toBe(false);
  });

  it('reorderClips requires a permutation', async () => {
    const store = await storeWithClips();
    expect(applyCommand(store, 'human', { name: 'reorderClips', order: ['c2', 'c1'] }).ok).toBe(
      true,
    );
    expect(store.doc.tracks.video.map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(applyCommand(store, 'human', { name: 'reorderClips', order: ['c1'] }).ok).toBe(false);
    expect(applyCommand(store, 'human', { name: 'reorderClips', order: ['c1', 'c1'] }).ok).toBe(
      false,
    );
  });

  it('removeClip removes existing and rejects missing', async () => {
    const store = await storeWithClips();
    expect(applyCommand(store, 'human', { name: 'removeClip', clipId: 'c2' }).ok).toBe(true);
    expect(store.doc.tracks.video).toHaveLength(1);
    expect(applyCommand(store, 'human', { name: 'removeClip', clipId: 'nope' }).ok).toBe(false);
  });

  it('updateCaption edits text; undo reverts', async () => {
    const store = await storeWithClips();
    const before = store.version;
    applyCommand(store, 'human', {
      name: 'updateCaption',
      id: 'cap1',
      patch: { text: 'changed' },
    });
    expect(store.doc.tracks.captions[0]!.text).toBe('changed');
    const u = applyCommand(store, 'human', { name: 'undo' });
    expect(u.ok).toBe(true);
    expect(store.doc.tracks.captions[0]!.text).toBe('hi');
    expect(store.version).toBeGreaterThan(before);
  });

  it('undo on empty history fails gracefully', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-cmd-'));
    const store = await ProjectStore.load(join(dir, 'project.json'));
    expect(applyCommand(store, 'human', { name: 'undo' })).toMatchObject({ ok: false });
  });
});
