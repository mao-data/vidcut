import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { totalDuration } from '@vidcut/shared';
import { ProjectStore } from '../src/store.js';
import { applyCommand } from '../src/commands.js';

/** 三段各 4 秒（來源各 20 秒）→ 時間軸 0-4 / 4-8 / 8-12。 */
async function seeded() {
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-t1-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
  store.mutate('ai', 'seed', (d) => {
    d.media = [
      {
        id: 'm1',
        path: 'a.mp4',
        probe: { duration: 20, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
      },
      {
        id: 'mute',
        path: 'b.mp4',
        probe: { duration: 20, width: 540, height: 960, fps: 30, hasAudio: false, rotation: 0 },
      },
    ];
    d.tracks.video = [
      { id: 'c1', mediaId: 'm1', in: 0, duration: 4, volume: 1, label: 'A' },
      { id: 'c2', mediaId: 'm1', in: 5, duration: 4, volume: 1, label: 'B' },
      { id: 'c3', mediaId: 'mute', in: 0, duration: 4, volume: 1, label: 'C' },
    ];
  });
  return store;
}

describe('splitAt', () => {
  it('splits the clip containing the playhead into two', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'splitAt', time: 5.5 }).ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v).toHaveLength(4);
    // c2 (時間軸 4-8, in=5) 在 offset 1.5 被切開
    expect(v[1]).toMatchObject({ id: 'c2', in: 5, duration: 1.5 });
    expect(v[2]).toMatchObject({ mediaId: 'm1', in: 6.5, duration: 2.5 });
    expect(totalDuration(store.doc)).toBeCloseTo(12); // 總長不變
  });

  it('rejects split too close to an edge or out of range', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'splitAt', time: 4.02 }).ok).toBe(false);
    expect(applyCommand(store, 'human', { name: 'splitAt', time: 99 }).ok).toBe(false);
    expect(applyCommand(store, 'human', { name: 'splitAt', time: -1 }).ok).toBe(false);
    expect(store.doc.tracks.video).toHaveLength(3);
  });
});

describe('deleteBefore / deleteAfter', () => {
  it('deleteBefore drops earlier clips and trims the straddling one', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'deleteBefore', time: 5 }).ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v).toHaveLength(2);
    // c1 全丟；c2 前 1 秒被切（in 5→6, 4→3s）
    expect(v[0]).toMatchObject({ id: 'c2', in: 6, duration: 3 });
    expect(v[1]!.id).toBe('c3');
    expect(totalDuration(store.doc)).toBeCloseTo(7);
  });

  it('deleteAfter drops later clips and trims the straddling one', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'deleteAfter', time: 6 }).ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ id: 'c1', duration: 4 });
    expect(v[1]).toMatchObject({ id: 'c2', in: 5, duration: 2 });
    expect(totalDuration(store.doc)).toBeCloseTo(6);
  });

  it('refuses to delete everything', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'deleteBefore', time: 0 }).ok).toBe(false);
    expect(applyCommand(store, 'human', { name: 'deleteAfter', time: 0 }).ok).toBe(false);
    expect(applyCommand(store, 'human', { name: 'deleteBefore', time: 12 }).ok).toBe(false);
    expect(store.doc.tracks.video).toHaveLength(3);
  });
});

describe('freezeFrame', () => {
  it('splits and inserts a frozen clip in the middle', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'freezeFrame', time: 2, duration: 1.5 }).ok).toBe(
      true,
    );
    const v = store.doc.tracks.video;
    // c1 被切成兩段 + 中間插一段定格 = 原本 3 段變 5 段
    expect(v).toHaveLength(5);
    expect(v[0]).toMatchObject({ id: 'c1', duration: 2 });
    expect(v[1]).toMatchObject({ frozen: true, in: 2, duration: 1.5, volume: 0 });
    expect(v[2]).toMatchObject({ in: 2, duration: 2 }); // c1 的後半
    expect(v[3]!.id).toBe('c2');
    expect(totalDuration(store.doc)).toBeCloseTo(13.5); // 12 + 1.5
  });

  it('inserts before the clip when the playhead sits on its start', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'freezeFrame', time: 4 }).ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v).toHaveLength(4);
    expect(v[1]).toMatchObject({ frozen: true, in: 5, duration: 3 }); // 預設 3 秒
    expect(v[2]!.id).toBe('c2');
  });

  it('rejects a too-short freeze', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'freezeFrame', time: 2, duration: 0.01 }).ok).toBe(
      false,
    );
  });
});

describe('extractAudio', () => {
  it('creates an absolute-time audio item and mutes the clip', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'extractAudio', clipId: 'c2' }).ok).toBe(true);
    const a = store.doc.tracks.audio;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ mediaId: 'm1', start: 4, in: 5, duration: 4, volume: 1 });
    expect(store.doc.tracks.video[1]!.volume).toBe(0);
  });

  it('rejects clips whose source has no audio', async () => {
    const store = await seeded();
    const r = applyCommand(store, 'human', { name: 'extractAudio', clipId: 'c3' });
    expect(r).toMatchObject({ ok: false });
    expect(store.doc.tracks.audio).toHaveLength(0);
  });
});

describe('audio item editing', () => {
  it('updates volume/fades and validates bounds', async () => {
    const store = await seeded();
    applyCommand(store, 'human', { name: 'extractAudio', clipId: 'c1' });
    const id = store.doc.tracks.audio[0]!.id;

    expect(
      applyCommand(store, 'human', {
        name: 'updateAudio',
        id,
        patch: { volume: 0.4, fadeIn: 0.5, fadeOut: 1 },
      }).ok,
    ).toBe(true);
    expect(store.doc.tracks.audio[0]).toMatchObject({ volume: 0.4, fadeIn: 0.5, fadeOut: 1 });

    // fade 超過長度、in+duration 超出來源、音量越界 → 全部拒絕
    expect(
      applyCommand(store, 'human', { name: 'updateAudio', id, patch: { fadeIn: 99 } }).ok,
    ).toBe(false);
    expect(
      applyCommand(store, 'human', { name: 'updateAudio', id, patch: { in: 19, duration: 5 } }).ok,
    ).toBe(false);
    expect(applyCommand(store, 'human', { name: 'updateAudio', id, patch: { volume: 3 } }).ok).toBe(
      false,
    );
  });

  it('removes an audio item', async () => {
    const store = await seeded();
    applyCommand(store, 'human', { name: 'extractAudio', clipId: 'c1' });
    const id = store.doc.tracks.audio[0]!.id;
    expect(applyCommand(store, 'human', { name: 'removeAudio', id }).ok).toBe(true);
    expect(store.doc.tracks.audio).toHaveLength(0);
    expect(applyCommand(store, 'human', { name: 'removeAudio', id: 'nope' }).ok).toBe(false);
  });
});

describe('setCanvasFit', () => {
  it('switches between contain and blur', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'setCanvasFit', fit: 'blur' }).ok).toBe(true);
    expect(store.doc.canvas.fit).toBe('blur');
    applyCommand(store, 'human', { name: 'setCanvasFit', fit: 'contain' });
    expect(store.doc.canvas.fit).toBe('contain');
  });
});
