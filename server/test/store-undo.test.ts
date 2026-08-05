import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import type { VideoClip } from '@vidcut/shared';
import { tmpDir } from './tmp.js';

/**
 * spec 2026-08-03-version-undo-redo B3/B4：
 * 游標式 undo/redo（僅編輯、連按一路退）＋ rev 持久化。
 */

let dir: string;
let store: ProjectStore;

const clip = (id: string): VideoClip => ({ id, mediaId: 'm1', in: 0, duration: 2, volume: 1 });
const pushClip = (id: string) =>
  store.mutate('human', `add ${id}`, (d) => {
    d.tracks.video.push(clip(id));
  });
const ids = () => store.doc.tracks.video.map((c) => c.id);

beforeEach(async () => {
  dir = await tmpDir('vidcut-undo-');
  store = await ProjectStore.load(join(dir, 'project.json'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('游標式 undo/redo（B4）', () => {
  it('連按 undo 一路往回退（不擺盪）', () => {
    pushClip('c1');
    pushClip('c2');
    store.mutate('human', 'canvas fit', (d) => {
      d.canvas.fit = 'blur';
    });

    expect(store.undo('human')).not.toBeNull();
    expect(store.doc.canvas.fit).toBeUndefined();
    expect(store.undo('human')).not.toBeNull();
    expect(ids()).toEqual(['c1']);
    expect(store.undo('human')).not.toBeNull();
    expect(ids()).toEqual([]);
  });

  it('undo 的歷史記錄標明撤了什麼、source 用呼叫者', () => {
    pushClip('c1');
    store.undo('ai');
    const last = store.history().at(-1)!;
    expect(last.label).toBe('undo: add c1');
    expect(last.source).toBe('ai');
  });

  it('redo 對稱往前走', () => {
    pushClip('c1');
    pushClip('c2');
    store.undo('human');
    store.undo('human');
    expect(ids()).toEqual([]);

    expect(store.redo('human')).not.toBeNull();
    expect(ids()).toEqual(['c1']);
    expect(store.redo('human')).not.toBeNull();
    expect(ids()).toEqual(['c1', 'c2']);
    expect(store.history().at(-1)!.label).toBe('redo: add c2');
  });

  it('新的編輯清空 redo（標準分叉語意）', () => {
    pushClip('c1');
    store.undo('human');
    pushClip('c2');
    expect(store.redo('human')).toBeNull();
    expect(ids()).toEqual(['c2']);
  });

  it('非編輯 mutation 不進 undo 範圍、也不清 redo', () => {
    pushClip('c1');
    store.mutate('ai', 'render start', (d) => {
      d.render = { status: 'running', progress: 0 };
    });
    // undo 跳過 render 狀態，直接撤編輯
    store.undo('human');
    expect(ids()).toEqual([]);
    expect(store.doc.render.status).toBe('running');

    // 非編輯也不清 redo：redo 仍可把 c1 拿回來
    store.mutate('ai', 'render done', (d) => {
      d.render = { status: 'done', progress: 1 };
    });
    expect(store.redo('human')).not.toBeNull();
    expect(ids()).toEqual(['c1']);
  });

  it('空堆疊回 null', () => {
    expect(store.undo('human')).toBeNull();
    expect(store.redo('human')).toBeNull();
  });

  it('revertSince 一筆回滾指定版本後的全部變更（review 退回用）', () => {
    pushClip('c1');
    const since = store.version;
    // 同一陣列的多筆連續變更：inverse 必須逆序套用，否則 index 位移會回滾錯項目
    pushClip('c2');
    pushClip('c3');
    store.mutate('ai', 'canvas fit', (d) => {
      d.canvas.fit = 'blur';
    });

    const r = store.revertSince(since);
    expect(r).not.toBeNull();
    expect(ids()).toEqual(['c1']);
    expect(store.doc.canvas.fit).toBeUndefined();
    expect(store.history().at(-1)!.label).toBe('review rollback');
  });
});

describe('修訂號持久化（B3）', () => {
  it('重載後 version 續走、doc 本體不含 rev', async () => {
    pushClip('c1');
    pushClip('c2');
    const v = store.version;
    await store.flush();

    const raw = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')) as {
      rev?: number;
    };
    expect(raw.rev).toBe(v);

    const reloaded = await ProjectStore.load(join(dir, 'project.json'));
    expect(reloaded.version).toBe(v);
    expect('rev' in reloaded.doc).toBe(false);
  });
});
