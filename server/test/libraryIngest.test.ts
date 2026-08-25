import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { LibraryStore } from '../src/libraryStore.js';
import {
  addToLibrary,
  hashFile,
  prepareFromLibrary,
  importImageToProject,
} from '../src/libraryIngest.js';
import { runFfmpeg } from '../src/ffmpeg.js';
import { makeAudio, makeVideo } from './fixtures.js';
import { tmpDir } from './tmp.js';

async function setup() {
  const libDir = await tmpDir('vidcut-libing-lib-');
  const srcDir = await tmpDir('vidcut-libing-src-');
  return { lib: await LibraryStore.load(libDir), libDir, srcDir };
}

describe('addToLibrary', () => {
  it('影片入庫：複製為 files/<hash>.mp4、derived 三件齊、索引一筆', async () => {
    const { lib, srcDir } = await setup();
    await makeVideo(srcDir, 'a.mp4', { duration: 2 });
    const { asset, existing } = await addToLibrary(lib, join(srcDir, 'a.mp4'), {
      label: '片頭 v2',
      tags: ['intro'],
      origin: { type: 'source', note: join(srcDir, 'a.mp4') },
    });
    expect(existing).toBe(false);
    expect(asset.file).toBe(join('files', `${asset.hash}.mp4`));
    expect(asset.hash).toBe(await hashFile(lib.fileAbs(asset)));
    expect(existsSync(lib.fileAbs(asset))).toBe(true);
    expect(existsSync(join(srcDir, 'a.mp4'))).toBe(true); // 預設複製，原檔還在
    for (const f of ['proxy.mp4', 'filmstrip.jpg', 'peaks.json']) {
      expect(existsSync(join(lib.derivedAbs(asset), f))).toBe(true);
    }
    expect(lib.list()).toHaveLength(1);
  }, 60_000);

  it('同內容再入庫（即使檔名不同）冪等回既有 asset', async () => {
    const { lib, srcDir } = await setup();
    await makeVideo(srcDir, 'a.mp4', { duration: 2 });
    const first = await addToLibrary(lib, join(srcDir, 'a.mp4'), {
      origin: { type: 'source' },
    });
    const { copyFile } = await import('node:fs/promises');
    await copyFile(join(srcDir, 'a.mp4'), join(srcDir, 'b.mp4'));
    const second = await addToLibrary(lib, join(srcDir, 'b.mp4'), {
      origin: { type: 'source' },
    });
    expect(second.existing).toBe(true);
    expect(second.asset.id).toBe(first.asset.id);
    expect(lib.list()).toHaveLength(1);
  }, 60_000);

  it('audio-only：只產 peaks，probe.hasVideo === false', async () => {
    const { lib, srcDir } = await setup();
    await makeAudio(srcDir, 'a.mp3', { duration: 1 });
    const { asset } = await addToLibrary(lib, join(srcDir, 'a.mp3'), {
      origin: { type: 'source' },
    });
    expect(asset.probe.hasVideo).toBe(false);
    expect(existsSync(join(lib.derivedAbs(asset), 'peaks.json'))).toBe(true);
    expect(existsSync(join(lib.derivedAbs(asset), 'proxy.mp4'))).toBe(false);
  }, 60_000);

  it('label 預設原檔名；tags 預設空陣列', async () => {
    const { lib, srcDir } = await setup();
    await makeVideo(srcDir, 'a.mp4', { duration: 2 });
    const { asset } = await addToLibrary(lib, join(srcDir, 'a.mp4'), {
      origin: { type: 'source' },
    });
    expect(asset.label).toBe('a.mp4');
    expect(asset.tags).toEqual([]);
  }, 60_000);

  it('白名單外副檔名拒收，什麼都不落地', async () => {
    const { lib, srcDir, libDir } = await setup();
    await writeFile(join(srcDir, 'a.txt'), 'x');
    await expect(
      addToLibrary(lib, join(srcDir, 'a.txt'), { origin: { type: 'source' } }),
    ).rejects.toThrow('unsupported');
    expect(await readdir(join(libDir, 'files'))).toEqual([]);
  });

  it('壞檔（probe 失敗）不留任何落地物', async () => {
    const { lib, srcDir, libDir } = await setup();
    await writeFile(join(srcDir, 'junk.mp4'), 'not a video');
    await expect(
      addToLibrary(lib, join(srcDir, 'junk.mp4'), { origin: { type: 'source' } }),
    ).rejects.toThrow();
    expect(await readdir(join(libDir, 'files'))).toEqual([]);
    expect(await readdir(join(libDir, 'derived'))).toEqual([]);
    expect(lib.list()).toEqual([]);
  });

  it('move:true 入庫後原檔消失（上傳暫存檔路徑用）', async () => {
    const { lib, srcDir } = await setup();
    await makeVideo(srcDir, 'a.mp4', { duration: 2 });
    const { asset } = await addToLibrary(lib, join(srcDir, 'a.mp4'), {
      origin: { type: 'upload' },
      move: true,
    });
    expect(existsSync(join(srcDir, 'a.mp4'))).toBe(false);
    expect(existsSync(lib.fileAbs(asset))).toBe(true);
  }, 60_000);

  it('併發同內容入庫：B 的預檢快照是空的，仍被 mutate 內的權威檢查擋下（F2）', async () => {
    const { libDir, srcDir } = await setup();
    await makeVideo(srcDir, 'a.mp4', { duration: 2 });
    // A、B 兩個獨立實例指同一庫目錄，模擬兩個 session
    const a = await LibraryStore.load(libDir);
    const b = await LibraryStore.load(libDir); // B 在 A 入庫「之前」就 load 完，快照為空
    const { copyFile } = await import('node:fs/promises');
    await copyFile(join(srcDir, 'a.mp4'), join(srcDir, 'b.mp4'));

    const first = await addToLibrary(a, join(srcDir, 'a.mp4'), { origin: { type: 'source' } });
    expect(first.existing).toBe(false);

    // B 的 byHash 預檢用的是 load 時的舊快照（miss），必須靠 mutate 內部的權威檢查擋下
    const second = await addToLibrary(b, join(srcDir, 'b.mp4'), { origin: { type: 'source' } });
    expect(second.existing).toBe(true);
    expect(second.asset.id).toBe(first.asset.id);

    const fresh = await LibraryStore.load(libDir);
    expect(fresh.list()).toHaveLength(1); // 只有一筆，沒有重複 hash 條目
  }, 60_000);
});

describe('addToLibrary: image kind', () => {
  it('png 入庫：kind=image、無 derived、probe 帶尺寸', async () => {
    const { lib, srcDir, libDir } = await setup();
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=320x240:duration=0.1',
      '-frames:v',
      '1',
      join(srcDir, 'logo.png'),
    ]);
    const { asset } = await addToLibrary(lib, join(srcDir, 'logo.png'), {
      label: '品牌 logo',
      tags: ['brand'],
      origin: { type: 'source' },
    });
    expect(asset.kind).toBe('image');
    expect(asset.file).toBe(join('files', `${asset.hash}.png`));
    expect(asset.probe.width).toBe(320);
    expect(asset.probe.height).toBe(240);
    expect(asset.probe.duration).toBe(0);
    expect(existsSync(join(libDir, 'derived', asset.hash))).toBe(false); // 圖片零 derived
    expect(lib.list({ kind: 'image' })).toHaveLength(1);
    expect(lib.list({ kind: 'media' })).toHaveLength(0);
  }, 30_000);

  it('圖片同內容冪等去重；壞圖（副檔名對、內容爛）拒收零殘留', async () => {
    const { lib, srcDir, libDir } = await setup();
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=8x8:duration=0.1',
      '-frames:v',
      '1',
      join(srcDir, 'a.png'),
    ]);
    const first = await addToLibrary(lib, join(srcDir, 'a.png'), { origin: { type: 'source' } });
    const { copyFile } = await import('node:fs/promises');
    await copyFile(join(srcDir, 'a.png'), join(srcDir, 'b.png'));
    const second = await addToLibrary(lib, join(srcDir, 'b.png'), { origin: { type: 'source' } });
    expect(second.existing).toBe(true);
    expect(second.asset.id).toBe(first.asset.id);
    await writeFile(join(srcDir, 'junk.png'), 'not an image');
    await expect(
      addToLibrary(lib, join(srcDir, 'junk.png'), { origin: { type: 'source' } }),
    ).rejects.toThrow();
    expect(await readdir(join(libDir, 'files'))).toHaveLength(1); // 只有 a.png 那筆
  }, 30_000);

  it('svg：內容嗅探擋垃圾偽裝檔，合法 svg（即使量不到尺寸）仍入庫', async () => {
    const { lib, srcDir, libDir } = await setup();
    // 垃圾內容偽裝 .svg：ffprobe 量不到尺寸，但也不是真的 svg——不得因為副檔名
    // 是 .svg 就照單全收，必須嗅探內容找 <svg 標記才放行。
    await writeFile(join(srcDir, 'junk.svg'), 'not an svg at all');
    await expect(
      addToLibrary(lib, join(srcDir, 'junk.svg'), { origin: { type: 'source' } }),
    ).rejects.toThrow();
    expect(await readdir(join(libDir, 'files'))).toEqual([]); // 零殘留

    // 最小合法 svg：ffprobe 可能有／沒有 svg decoder（環境而異），兩種結果都該入庫成功。
    await writeFile(
      join(srcDir, 'ok.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    );
    const { asset } = await addToLibrary(lib, join(srcDir, 'ok.svg'), {
      origin: { type: 'source' },
    });
    expect(asset.kind).toBe('image');
    expect(await readdir(join(libDir, 'files'))).toHaveLength(1);

    // svg 仍可留在庫中（上面已入庫成功），但不得匯入為 overlay（上游裁決 R5）：
    // ffmpeg 匯出時直接 -i 餵它多數 build 沒有 svg decoder，會炸——擋在匯入這一步。
    const projDir = await tmpDir('vidcut-libing-proj-');
    await expect(importImageToProject(projDir, lib, asset)).rejects.toThrow(
      /svg cannot be imported as an overlay/,
    );
  }, 30_000);

  it('prepareFromLibrary 拒絕 image kind', async () => {
    const { lib, srcDir } = await setup();
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=8x8:duration=0.1',
      '-frames:v',
      '1',
      join(srcDir, 'a.png'),
    ]);
    const { asset } = await addToLibrary(lib, join(srcDir, 'a.png'), {
      origin: { type: 'source' },
    });
    // 上游裁決：不碰 store 私有欄位——用 tmpDir 建 projDir，projDir 直接傳給 prepareFromLibrary
    // （與 import-from-library.test.ts 的 setup() 同一套慣例）。
    const projDir = await tmpDir('vidcut-libimg-proj-');
    const store = await ProjectStore.load(join(projDir, 'project.json'));
    await expect(prepareFromLibrary(store, projDir, lib, asset.id)).rejects.toThrow(
      'cannot be imported as media',
    );
  }, 30_000);
});
