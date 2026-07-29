import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';

async function tmpStore() {
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-'));
  const file = join(dir, 'project.json');
  return { store: await ProjectStore.load(file), file };
}

describe('ProjectStore', () => {
  it('load creates empty project when file missing', async () => {
    const { store } = await tmpStore();
    expect(store.version).toBe(0);
    expect(store.doc.schemaVersion).toBe(1);
  });

  it('mutate bumps version, records history, notifies listeners', async () => {
    const { store } = await tmpStore();
    const seen: string[] = [];
    store.onChange((e) => seen.push(`${e.version}:${e.label}:${e.source}`));
    const r = store.mutate('ai', 'add clip', (d) => {
      d.tracks.video.push({ id: 'c1', mediaId: 'm1', in: 0, duration: 5, volume: 1 });
    });
    expect(r.version).toBe(1);
    expect(r.patches.length).toBeGreaterThan(0);
    expect(store.doc.tracks.video).toHaveLength(1);
    expect(seen).toEqual(['1:add clip:ai']);
    expect(store.history()).toHaveLength(1);
  });

  it('no-op mutate does not bump version or notify', async () => {
    const { store } = await tmpStore();
    const cb = vi.fn();
    store.onChange(cb);
    store.mutate('human', 'noop', () => {});
    expect(store.version).toBe(0);
    expect(cb).not.toHaveBeenCalled();
    expect(store.history()).toHaveLength(0);
  });

  it('undo reverts last mutation as a new version', async () => {
    const { store } = await tmpStore();
    store.mutate('ai', 'add', (d) => {
      d.tracks.video.push({ id: 'c1', mediaId: 'm1', in: 0, duration: 5, volume: 1 });
    });
    store.mutate('human', 'trim', (d) => {
      d.tracks.video[0]!.duration = 3;
    });
    const r = store.undo(1);
    expect(r?.version).toBe(3);
    expect(store.doc.tracks.video[0]!.duration).toBe(5);
    expect(store.undo(99)).not.toBeNull(); // 全撤（含撤 undo 自己 = redo 語意，可接受）
  });

  it('flush persists atomically; load round-trips', async () => {
    const { store, file } = await tmpStore();
    store.mutate('ai', 'name', (d) => {
      d.name = 'hello';
    });
    await store.flush();
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    expect(onDisk.name).toBe('hello');
    const again = await ProjectStore.load(file);
    expect(again.doc.name).toBe('hello');
  });

  it('history is capped at 200 entries', async () => {
    const { store } = await tmpStore();
    for (let i = 0; i < 210; i++) {
      store.mutate('ai', `m${i}`, (d) => {
        d.name = `n${i}`;
      });
    }
    expect(store.history()).toHaveLength(200);
    expect(store.history()[0]!.label).toBe('m10');
  });
});
