import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { aiWrite } from '../src/aiWrite.js';
import { applyCommand } from '../src/commands.js';
import { EditorContext } from '../src/editorContext.js';
import { tmpDir } from './tmp.js';

async function seeded() {
  const dir = await tmpDir('vidcut-aiw-');
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

  // Plan 8 final review F2：background ingest（A1/A2）的 updateMediaDerived 也會推進
  // store.version，但那不是使用者/AI 的編輯意圖（entry 帶 excludeFromRevert）。
  // 舊行為把任何 version 不符都當「使用者剛改過」，導致單純的背景推進也讓 AI 的
  // 下一筆 ifVersion 寫入被誤判 stale。
  it('(a) version bump caused only by updateMediaDerived: aiWrite with older ifVersion still succeeds', async () => {
    const store = await seeded();
    const ifVersion = store.version;
    // 模擬背景 A1 完成，補寫 filmstrip（source='human'，與 ingest.ts 實際呼叫一致）
    const derived = applyCommand(store, 'human', {
      name: 'updateMediaDerived',
      mediaId: 'm1',
      patch: { filmstripPath: 'derived/m1/filmstrip.jpg', filmstripTiles: 4 },
    });
    expect(derived.ok).toBe(true);
    expect(store.version).toBeGreaterThan(ifVersion);

    const r = aiWrite(
      store,
      { name: 'updateClip', clipId: 'c1', patch: { duration: 6 } },
      ifVersion,
    );
    expect(r.ok).toBe(true);
    expect(store.doc.tracks.video[0]!.duration).toBe(6);
  });

  it('(b) version bump caused by a real edit: aiWrite with older ifVersion is still rejected', async () => {
    const store = await seeded();
    const ifVersion = store.version;
    const edit = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'c1',
      patch: { label: 'renamed by human' },
    });
    expect(edit.ok).toBe(true);
    expect(store.version).toBeGreaterThan(ifVersion);

    const r = aiWrite(
      store,
      { name: 'updateClip', clipId: 'c1', patch: { duration: 6 } },
      ifVersion,
    );
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && /stale/.test(r.error)).toBe(true);
  });

  it('(c) mixed bump (background derive + real edit): aiWrite with older ifVersion is rejected', async () => {
    const store = await seeded();
    const ifVersion = store.version;
    const derived = applyCommand(store, 'human', {
      name: 'updateMediaDerived',
      mediaId: 'm1',
      patch: { filmstripPath: 'derived/m1/filmstrip.jpg', filmstripTiles: 4 },
    });
    expect(derived.ok).toBe(true);
    const edit = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'c1',
      patch: { label: 'renamed by human' },
    });
    expect(edit.ok).toBe(true);
    expect(store.version).toBeGreaterThan(ifVersion + 1);

    const r = aiWrite(
      store,
      { name: 'updateClip', clipId: 'c1', patch: { duration: 6 } },
      ifVersion,
    );
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && /stale/.test(r.error)).toBe(true);
  });

  it('still rejects a future ifVersion that has not happened yet', async () => {
    const store = await seeded();
    const r = aiWrite(
      store,
      { name: 'updateClip', clipId: 'c1', patch: { duration: 6 } },
      store.version + 999,
    );
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && /stale/.test(r.error)).toBe(true);
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
