import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LibraryAsset } from '@vidcut/shared';
import { LibraryStore } from '../src/libraryStore.js';
import { tmpDir } from './tmp.js';

const fakeAsset = (over: Partial<LibraryAsset> = {}): LibraryAsset => ({
  id: `lib-${Math.random().toString(36).slice(2, 10)}`,
  kind: 'media',
  hash: 'a'.repeat(64),
  file: `files/${'a'.repeat(64)}.mp4`,
  probe: { duration: 2, width: 320, height: 568, fps: 30, hasAudio: true, rotation: 0 },
  label: '片頭 v2',
  tags: ['intro'],
  origin: { type: 'upload' },
  addedAt: '2026-08-21T00:00:00.000Z',
  ...over,
});

describe('LibraryStore', () => {
  it('load 建出 files/ 與 derived/，空庫回空清單', async () => {
    const dir = await tmpDir('vidcut-lib-');
    const lib = await LibraryStore.load(dir);
    expect(existsSync(join(dir, 'files'))).toBe(true);
    expect(existsSync(join(dir, 'derived'))).toBe(true);
    expect(lib.list()).toEqual([]);
  });

  it('mutate 原子落盤且可重載', async () => {
    const dir = await tmpDir('vidcut-lib-');
    const lib = await LibraryStore.load(dir);
    const a = fakeAsset();
    await lib.mutate((assets) => assets.push(a));
    expect(existsSync(join(dir, '.library.json.tmp'))).toBe(false); // rename 收尾，不留 tmp
    const again = await LibraryStore.load(dir);
    expect(again.get(a.id)?.label).toBe('片頭 v2');
  });

  it('mutate 前重讀：兩個實例各加一筆，兩筆都在', async () => {
    const dir = await tmpDir('vidcut-lib-');
    const a = await LibraryStore.load(dir);
    const b = await LibraryStore.load(dir);
    const x = fakeAsset({ hash: 'b'.repeat(64), file: `files/${'b'.repeat(64)}.mp4` });
    const y = fakeAsset({ hash: 'c'.repeat(64), file: `files/${'c'.repeat(64)}.mp4` });
    await a.mutate((assets) => assets.push(x));
    await b.mutate((assets) => assets.push(y));
    expect((await LibraryStore.load(dir)).list()).toHaveLength(2);
  });

  it('索引損毀時 load 丟錯（不靜默清空）', async () => {
    const dir = await tmpDir('vidcut-lib-');
    await writeFile(join(dir, 'library.json'), '{not json', 'utf8');
    await expect(LibraryStore.load(dir)).rejects.toThrow();
  });

  it('list：query 對 label+tags、tag 精確、broken 反映 files/ 缺檔', async () => {
    const dir = await tmpDir('vidcut-lib-');
    const lib = await LibraryStore.load(dir);
    const hit = fakeAsset({ label: '常用 BGM-輕快', tags: ['bgm'] });
    const miss = fakeAsset({
      hash: 'd'.repeat(64),
      file: `files/${'d'.repeat(64)}.mp4`,
      label: 'logo',
      tags: ['brand'],
    });
    await lib.mutate((assets) => assets.push(hit, miss));
    await mkdir(join(dir, 'files'), { recursive: true });
    await writeFile(lib.fileAbs(hit), 'x'); // hit 的檔案存在、miss 的不存在
    expect(lib.list({ query: 'bgm' }).map((a) => a.id)).toEqual([hit.id]);
    expect(lib.list({ tag: 'brand' }).map((a) => a.id)).toEqual([miss.id]);
    expect(lib.list().find((a) => a.id === hit.id)?.broken).toBe(false);
    expect(lib.list().find((a) => a.id === miss.id)?.broken).toBe(true);
  });

  it('updateAsset 改 label/tags；不存在丟 no library asset', async () => {
    const dir = await tmpDir('vidcut-lib-');
    const lib = await LibraryStore.load(dir);
    const a = fakeAsset();
    await lib.mutate((assets) => assets.push(a));
    const r = await lib.updateAsset(a.id, { label: '片頭 v3', tags: ['intro', 'v3'] });
    expect(r.label).toBe('片頭 v3');
    expect((await LibraryStore.load(dir)).get(a.id)?.tags).toEqual(['intro', 'v3']);
    await expect(lib.updateAsset('lib-nope', { label: 'x' })).rejects.toThrow('no library asset');
  });

  it('removeAsset 清索引 + files/ + derived/', async () => {
    const dir = await tmpDir('vidcut-lib-');
    const lib = await LibraryStore.load(dir);
    const a = fakeAsset();
    await lib.mutate((assets) => assets.push(a));
    await writeFile(lib.fileAbs(a), 'x');
    await mkdir(lib.derivedAbs(a), { recursive: true });
    await writeFile(join(lib.derivedAbs(a), 'peaks.json'), '{}');
    await lib.removeAsset(a.id);
    expect(lib.get(a.id)).toBeUndefined();
    expect(existsSync(lib.fileAbs(a))).toBe(false);
    expect(existsSync(lib.derivedAbs(a))).toBe(false);
  });

  it('removeAsset 拒刪形狀可疑的 file 路徑', async () => {
    const dir = await tmpDir('vidcut-lib-');
    const lib = await LibraryStore.load(dir);
    const evil = fakeAsset({ file: '../outside.mp4' });
    await lib.mutate((assets) => assets.push(evil));
    await expect(lib.removeAsset(evil.id)).rejects.toThrow('suspicious');
    const raw = JSON.parse(await readFile(join(dir, 'library.json'), 'utf8')) as {
      assets: unknown[];
    };
    expect(raw.assets).toHaveLength(1); // 索引也不動
  });

  it('reload：A 加的 asset，B 的舊快照看不到，reload 後看得到（F1 跨 session 讀路徑）', async () => {
    const dir = await tmpDir('vidcut-lib-');
    const a = await LibraryStore.load(dir);
    const b = await LibraryStore.load(dir);
    const x = fakeAsset();
    await a.mutate((assets) => assets.push(x));
    expect(b.list()).toEqual([]); // B 還沒 reload，記憶體是啟動時的空快照
    await b.reload();
    expect(b.list().map((v) => v.id)).toEqual([x.id]);
  });

  it('removeAsset 對「別的實例剛加的 asset」能刪（先 reload 語意）', async () => {
    const dir = await tmpDir('vidcut-lib-');
    const a = await LibraryStore.load(dir);
    const b = await LibraryStore.load(dir);
    const x = fakeAsset();
    await mkdir(join(dir, 'files'), { recursive: true });
    await writeFile(a.fileAbs(x), 'x');
    await a.mutate((assets) => assets.push(x)); // A 新增，B 的記憶體快照仍是空的
    await b.removeAsset(x.id); // B 從沒手動 reload 過，removeAsset 自己要先 reload 才找得到
    expect(existsSync(a.fileAbs(x))).toBe(false);
    expect((await LibraryStore.load(dir)).list()).toEqual([]);
  });
});
