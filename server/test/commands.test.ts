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

describe('updateOverlay anchor/start exclusivity', () => {
  async function storeWithOverlays() {
    const store = await storeWithClips();
    store.mutate('ai', 'seed overlays', (d) => {
      d.tracks.overlays = [
        {
          id: 'ov_abs',
          imagePath: 'a.png',
          start: 2,
          duration: 3,
          position: { x: 0.5, y: 0.1, scale: 1 },
        },
        {
          id: 'ov_anc',
          imagePath: 'b.png',
          anchor: { clipId: 'c2', offset: 1 },
          duration: null,
          position: { x: 0.5, y: 0.2, scale: 1 },
        },
      ];
    });
    return store;
  }

  it('patching anchor validates clipId, sets it, and clears start', async () => {
    const store = await storeWithOverlays();
    const r = applyCommand(store, 'human', {
      name: 'updateOverlay',
      id: 'ov_abs',
      patch: { anchor: { clipId: 'c1', offset: 0.5 } },
    });
    expect(r.ok).toBe(true);
    const o = store.doc.tracks.overlays[0]!;
    expect(o.anchor).toEqual({ clipId: 'c1', offset: 0.5 });
    expect(o.start).toBeUndefined();
  });

  it('rejects anchor with unknown clipId', async () => {
    const store = await storeWithOverlays();
    const r = applyCommand(store, 'human', {
      name: 'updateOverlay',
      id: 'ov_abs',
      patch: { anchor: { clipId: 'nope', offset: 0 } },
    });
    expect(r.ok).toBe(false);
  });

  it('patching start on an anchored overlay converts it to absolute (clears anchor)', async () => {
    const store = await storeWithOverlays();
    const r = applyCommand(store, 'human', {
      name: 'updateOverlay',
      id: 'ov_anc',
      patch: { start: 4 },
    });
    expect(r.ok).toBe(true);
    const o = store.doc.tracks.overlays[1]!;
    expect(o.start).toBe(4);
    // 沒有這條互斥規則時 anchor 會留著且優先生效 → 設 start 看似成功實際無效
    expect(o.anchor).toBeUndefined();
  });
});

describe('addOverlay / removeOverlay', () => {
  it('appends a valid overlay', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'addOverlay',
      overlay: {
        id: 'ov_new',
        imagePath: 'assets/t.png',
        start: 2,
        duration: 3,
        position: { x: 0.5, y: 0.1, scale: 1 },
      },
    });
    expect(r.ok).toBe(true);
    expect(store.doc.tracks.overlays.map((o) => o.id)).toContain('ov_new');
  });

  it('rejects overlay without start or anchor, or with bad duration', async () => {
    const store = await storeWithClips();
    expect(
      applyCommand(store, 'human', {
        name: 'addOverlay',
        overlay: {
          id: 'x1',
          imagePath: 'a.png',
          duration: 3,
          position: { x: 0, y: 0, scale: 1 },
        },
      }).ok,
    ).toBe(false);
    expect(
      applyCommand(store, 'human', {
        name: 'addOverlay',
        overlay: {
          id: 'x2',
          imagePath: 'a.png',
          start: 0,
          duration: 0,
          position: { x: 0, y: 0, scale: 1 },
        },
      }).ok,
    ).toBe(false);
    expect(
      applyCommand(store, 'human', {
        name: 'addOverlay',
        overlay: {
          id: 'x3',
          imagePath: 'a.png',
          anchor: { clipId: 'nope', offset: 0 },
          duration: null,
          position: { x: 0, y: 0, scale: 1 },
        },
      }).ok,
    ).toBe(false);
  });

  it('rejects duplicate overlay id', async () => {
    const store = await storeWithClips();
    const overlay = {
      id: 'dup',
      imagePath: 'a.png',
      start: 0,
      duration: null,
      position: { x: 0, y: 0, scale: 1 },
    };
    expect(applyCommand(store, 'human', { name: 'addOverlay', overlay }).ok).toBe(true);
    expect(applyCommand(store, 'human', { name: 'addOverlay', overlay }).ok).toBe(false);
  });

  it('removeOverlay removes existing and rejects missing', async () => {
    const store = await storeWithClips();
    applyCommand(store, 'human', {
      name: 'addOverlay',
      overlay: {
        id: 'ov_rm',
        imagePath: 'a.png',
        start: 0,
        duration: 2,
        position: { x: 0, y: 0, scale: 1 },
      },
    });
    expect(applyCommand(store, 'human', { name: 'removeOverlay', id: 'ov_rm' }).ok).toBe(true);
    expect(store.doc.tracks.overlays.some((o) => o.id === 'ov_rm')).toBe(false);
    expect(applyCommand(store, 'human', { name: 'removeOverlay', id: 'ov_rm' }).ok).toBe(false);
  });
});

describe('addClip', () => {
  it('append 到主軌尾端', async () => {
    const store = await storeWithClips();
    const before = store.doc.tracks.video.length;
    const r = applyCommand(store, 'human', { name: 'addClip', mediaId: 'm1', in: 0, duration: 3 });
    expect(r.ok).toBe(true);
    const clips = store.doc.tracks.video;
    expect(clips).toHaveLength(before + 1);
    expect(clips[clips.length - 1]).toMatchObject({ mediaId: 'm1', in: 0, duration: 3, volume: 1 });
    expect(clips[clips.length - 1]!.id).toBeTruthy();
  });

  it('未知 mediaId 被拒絕', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', {
      name: 'addClip',
      mediaId: 'nope',
      in: 0,
      duration: 3,
    });
    expect(r.ok).toBe(false);
  });

  it('duration <= 0 被拒絕', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', { name: 'addClip', mediaId: 'm1', in: 0, duration: 0 });
    expect(r.ok).toBe(false);
  });

  it('in + duration 超出素材長度被拒絕', async () => {
    const store = await storeWithClips();
    // m1 全長 20 秒
    const r = applyCommand(store, 'human', { name: 'addClip', mediaId: 'm1', in: 18, duration: 5 });
    expect(r.ok).toBe(false);
  });

  it('剛好用滿素材長度是允許的', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', { name: 'addClip', mediaId: 'm1', in: 0, duration: 20 });
    expect(r.ok).toBe(true);
  });

  it('負的 in 被拒絕（in=-1, duration=1 若無此守衛，-1+1=0 不會超界，會通過並讓 ffmpeg 收到 -ss -1）', async () => {
    const store = await storeWithClips();
    const r = applyCommand(store, 'human', { name: 'addClip', mediaId: 'm1', in: -1, duration: 1 });
    expect(r.ok).toBe(false);
  });

  it('浮點誤差導致的邊界：1e-6 容差保護', async () => {
    const store = await storeWithClips();
    // duration = 20 + 1e-7 = 20.0000001
    // 總和 (in=0) 略大於素材長度（20），但差異 (1e-7) < 1e-6，應被容差允許。
    // 若容差被拿掉（+0），測試會因為 20.0000001 > 20 而變紅。
    const duration = 20 + 1e-7;
    const r = applyCommand(store, 'human', { name: 'addClip', mediaId: 'm1', in: 0, duration });
    expect(r.ok).toBe(true);
  });
});
