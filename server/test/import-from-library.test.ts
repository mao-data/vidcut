import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { applyCommand } from '../src/commands.js';
import { LibraryStore } from '../src/libraryStore.js';
import { addToLibrary, prepareFromLibrary, discardPrepared } from '../src/libraryIngest.js';
import { makeVideo } from './fixtures.js';
import { tmpDir } from './tmp.js';

async function setup() {
  const libDir = await tmpDir('vidcut-ifl-lib-');
  const srcDir = await tmpDir('vidcut-ifl-src-');
  const projDir = await tmpDir('vidcut-ifl-proj-');
  const lib = await LibraryStore.load(libDir);
  const store = await ProjectStore.load(join(projDir, 'project.json'));
  await makeVideo(srcDir, 'a.mp4', { duration: 2 });
  const { asset } = await addToLibrary(lib, join(srcDir, 'a.mp4'), {
    label: '片頭 v2',
    origin: { type: 'source' },
  });
  return { lib, store, projDir, asset };
}

describe('prepareFromLibrary', () => {
  it('登記為指向庫檔的絕對路徑引用，帶 libraryId/libraryHash 溯源', async () => {
    const { lib, store, projDir, asset } = await setup();
    const prepared = await prepareFromLibrary(store, projDir, lib, asset.id);
    expect('asset' in prepared).toBe(true);
    if (!('asset' in prepared)) return;
    const r = applyCommand(store, 'human', { name: 'registerMedia', asset: prepared.asset });
    expect(r.ok).toBe(true);
    const m = store.doc.media[0]!;
    expect(m.path).toBe(lib.fileAbs(asset)); // 絕對路徑 = 零複製引用庫檔
    expect(m.meta).toMatchObject({ libraryId: asset.id, libraryHash: asset.hash });
    expect(m.label).toBe('片頭 v2');
    // derived 已複製進專案（UI 預覽/波形都在專案內，與一般匯入無異）
    expect(existsSync(join(projDir, m.proxyPath!))).toBe(true);
    expect(existsSync(join(projDir, m.peaksPath!))).toBe(true);
    // filmstripTiles 由 filmstripPlan 重算
    expect(typeof m.filmstripTiles).toBe('number');
    expect(m.filmstripTiles!).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('derived 是複製不是重算（庫的 proxy mtime 不變）', async () => {
    const { lib, store, projDir, asset } = await setup();
    const libProxy = join(lib.derivedAbs(asset), 'proxy.mp4');
    const before = (await stat(libProxy)).mtimeMs;
    await prepareFromLibrary(store, projDir, lib, asset.id);
    expect((await stat(libProxy)).mtimeMs).toBe(before);
  }, 60_000);

  it('庫的 derived 被清掉時 lazy 重建（衍生檔是可拋棄快取）', async () => {
    const { lib, store, projDir, asset } = await setup();
    await rm(lib.derivedAbs(asset), { recursive: true, force: true });
    const prepared = await prepareFromLibrary(store, projDir, lib, asset.id);
    expect('asset' in prepared).toBe(true);
    expect(existsSync(join(lib.derivedAbs(asset), 'peaks.json'))).toBe(true); // 庫也補回
  }, 60_000);

  it('同 asset 再匯入同專案：冪等回既有 id', async () => {
    const { lib, store, projDir, asset } = await setup();
    const first = await prepareFromLibrary(store, projDir, lib, asset.id);
    if ('asset' in first)
      applyCommand(store, 'human', { name: 'registerMedia', asset: first.asset });
    const second = await prepareFromLibrary(store, projDir, lib, asset.id);
    expect('existingId' in second && second.existingId === store.doc.media[0]!.id).toBe(true);
  }, 60_000);

  it('broken（files/ 缺檔）拒絕匯入；不存在的 assetId 丟 no library asset', async () => {
    const { lib, store, projDir, asset } = await setup();
    await rm(lib.fileAbs(asset), { force: true });
    await expect(prepareFromLibrary(store, projDir, lib, asset.id)).rejects.toThrow('is broken');
    await expect(prepareFromLibrary(store, projDir, lib, 'lib-nope')).rejects.toThrow(
      'no library asset',
    );
  }, 60_000);

  it('discardPrepared 清掉登記失敗時遺留的 derived/<id>/ 孤兒目錄（F3）', async () => {
    const { lib, store, projDir, asset } = await setup();
    const prepared = await prepareFromLibrary(store, projDir, lib, asset.id);
    expect('asset' in prepared).toBe(true);
    if (!('asset' in prepared)) return;
    const derivedDir = join(projDir, 'derived', prepared.asset.id);
    expect(existsSync(derivedDir)).toBe(true); // 模擬呼叫端登記失敗前的狀態：已 cp 進專案
    await discardPrepared(projDir, prepared.asset);
    expect(existsSync(derivedDir)).toBe(false);
  }, 60_000);
});
