import { describe, it, expect, vi } from 'vitest';
import { readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as fs from 'node:fs/promises';
import { createEmptyProject, type Project } from '@vidcut/shared';
import { ProjectStore } from '../src/store.js';
import { tmpDir } from './tmp.js';

/**
 * fs 是**邊界**，包起來只為了觀察呼叫（一律呼叫原實作，行為不變）——
 * 沒有這層就無法斷言「先寫暫存檔再 rename」，而那正是原子落盤的全部內容。
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename) };
});

/**
 * Tier 3：持久化的失敗模型。
 * 專案檔是使用者不可重建的資產——渲染可以重跑、剪輯決策不行。
 * 這裡逐一驗證會導致「編輯憑空消失」或「檔案讀不回來」的模式：
 *
 *  1. 半寫入檔（寫到一半當機）→ 讀到殘缺 JSON
 *  2. 連續存檔互相踩踏 → 最後落盤的不是最新狀態
 *  3. undo 回不到正確狀態 → 使用者以為救回來了，其實沒有
 *  4. history 上限裁切 → 裁掉的部分讓 undo 錯亂
 *  5. 檔案損毀 → 整個 server 起不來
 */

async function tempStore(): Promise<{ dir: string; file: string; store: ProjectStore }> {
  const dir = await tmpDir('vidcut-durability-');
  const file = join(dir, 'project.json');
  const store = await ProjectStore.load(file);
  return { dir, file, store };
}

const readDoc = async (file: string): Promise<Project> =>
  JSON.parse(await readFile(file, 'utf8')) as Project;

const addClip = (label: string) => (d: Project) => {
  d.tracks.video.push({ id: label, mediaId: 'm', in: 0, duration: 1, volume: 1, label });
};

describe('ProjectStore durability (Tier 3)', () => {
  it('never leaves a partial file: writes to a temp file then renames onto the target', async () => {
    const { dir, file, store } = await tempStore();
    vi.mocked(fs.writeFile).mockClear();
    vi.mocked(fs.rename).mockClear();

    store.mutate('human', 'add', addClip('a'));
    await store.flush();

    // 內容必須先落在別的路徑，再以 rename 原子換上——直接覆寫目標檔的話，
    // 寫到一半當機就會留下解析不了的半檔（使用者的剪輯決策無法重建）。
    const written = vi.mocked(fs.writeFile).mock.calls.map((c) => String(c[0]));
    expect(written).toHaveLength(1);
    expect(written[0]).not.toBe(file);
    expect(vi.mocked(fs.rename).mock.calls.map((c) => [String(c[0]), String(c[1])])).toEqual([
      [written[0]!, file],
    ]);

    // 且落盤後不留暫存檔
    expect(await readdir(dir)).toEqual(['project.json']);
    expect((await readDoc(file)).tracks.video).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });

  it('the file on disk always parses as valid JSON, mid-burst included', async () => {
    const { dir, file, store } = await tempStore();
    for (let i = 0; i < 25; i++) {
      store.mutate('ai', `add ${i}`, addClip(`c${i}`));
    }
    await store.flush();
    const doc = await readDoc(file); // 解析失敗 = 半檔，這行就會丟例外
    expect(doc.tracks.video).toHaveLength(25);
    await rm(dir, { recursive: true, force: true });
  });

  it('serialises overlapping saves so the last write wins', async () => {
    const { dir, file, store } = await tempStore();
    // 不 await 中間任何一次：模擬 debounce 到期與 flush 疊在一起
    store.mutate('human', 'one', addClip('one'));
    const p1 = store.flush();
    store.mutate('human', 'two', addClip('two'));
    const p2 = store.flush();
    store.mutate('human', 'three', addClip('three'));
    const p3 = store.flush();
    await Promise.all([p1, p2, p3]);

    const doc = await readDoc(file);
    expect(doc.tracks.video.map((c) => c.label)).toEqual(['one', 'two', 'three']);
    await rm(dir, { recursive: true, force: true });
  });

  it('undo restores the exact previous document, N steps back', async () => {
    const { dir, store } = await tempStore();
    store.mutate('human', 'a', addClip('a'));
    const afterA = JSON.stringify(store.doc);
    store.mutate('human', 'b', addClip('b'));
    store.mutate('human', 'c', addClip('c'));

    store.undo('human', 2);
    expect(JSON.stringify(store.doc)).toBe(afterA);
    await rm(dir, { recursive: true, force: true });
  });

  it('undo past the beginning reports failure instead of corrupting state', async () => {
    const { dir, store } = await tempStore();
    expect(store.undo('human', 1)).toBeNull();
    expect(store.doc).toEqual(createEmptyProject(store.doc.id, store.doc.name));

    store.mutate('human', 'a', addClip('a'));
    store.undo('human', 5); // 要求比歷史還多步
    expect(store.doc.tracks.video).toHaveLength(0);
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps undo correct after the history cap trims old entries', async () => {
    const { dir, store } = await tempStore();
    // HISTORY_MAX = 200：塞超過上限，最舊的會被裁掉
    for (let i = 0; i < 260; i++) store.mutate('ai', `add ${i}`, addClip(`c${i}`));
    expect(store.doc.tracks.video).toHaveLength(260);

    store.undo('human', 1);
    expect(store.doc.tracks.video).toHaveLength(259);
    expect(store.doc.tracks.video.at(-1)!.label).toBe('c258');
    await rm(dir, { recursive: true, force: true });
  });

  it('an undo is itself a mutation, so listeners and version keep moving forward', async () => {
    const { dir, store } = await tempStore();
    const seen: number[] = [];
    store.onChange((e) => seen.push(e.version));
    store.mutate('human', 'a', addClip('a'));
    store.undo('human', 1);
    expect(seen).toEqual([1, 2]); // undo 廣播為新版本，不是回退版本號
    expect(store.version).toBe(2);
    await rm(dir, { recursive: true, force: true });
  });

  it('a mutation that changes nothing does not bump the version or emit', async () => {
    const { dir, store } = await tempStore();
    const seen: number[] = [];
    store.onChange((e) => seen.push(e.version));
    const r = store.mutate('human', 'noop', () => {});
    expect(r.patches).toEqual([]);
    expect(store.version).toBe(0);
    expect(seen).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('loads a fresh project when the file is missing', async () => {
    const dir = await tmpDir('vidcut-durability-');
    const store = await ProjectStore.load(join(dir, 'nope', 'project.json'));
    expect(store.doc.tracks.video).toEqual([]);
    expect(store.version).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });

  it('falls back to an empty project instead of crashing on a corrupt file', async () => {
    const dir = await tmpDir('vidcut-durability-');
    const file = join(dir, 'project.json');
    await writeFile(file, '{ this is not json', 'utf8');
    const store = await ProjectStore.load(file); // 不得丟例外——否則 server 起不來
    expect(store.doc.tracks.video).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('the saved file round-trips: reload sees exactly what was saved', async () => {
    const { dir, file, store } = await tempStore();
    store.mutate('human', 'build', (d) => {
      d.tracks.video.push({ id: 'c1', mediaId: 'm', in: 1.5, duration: 2.25, volume: 0.5 });
      d.tracks.captions.push({
        id: 'cap',
        text: '中文字幕',
        start: 0.1,
        duration: 1,
        style: { fontFamily: 'sans', fontSize: 40, fill: '#fff', y: 0.8 },
      });
      d.tracks.overlays.push({
        id: 'ov',
        imagePath: 'a.png',
        duration: null, // JSON 不能存 Infinity——null 是「到片尾」的表示法
        anchor: { clipId: 'c1', offset: 0.5 },
        position: { x: 0.5, y: 0.1, scale: 1 },
      });
    });
    await store.flush();

    const reloaded = await ProjectStore.load(file);
    expect(reloaded.doc).toEqual(store.doc);
    expect(reloaded.doc.tracks.overlays[0]!.duration).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it('frozen documents cannot be mutated outside mutate()', async () => {
    const { dir, store } = await tempStore();
    store.mutate('human', 'a', addClip('a'));
    // immer freeze：直接改 doc 應該無效（嚴格模式會丟例外，非嚴格則靜默無效）
    expect(() => {
      (store.doc.tracks.video as unknown as Array<unknown>).push({});
    }).toThrow();
    expect(store.doc.tracks.video).toHaveLength(1);
    await rm(dir, { recursive: true, force: true });
  });
});
