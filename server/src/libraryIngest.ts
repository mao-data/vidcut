import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, rename, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { nanoid } from 'nanoid';
import type { LibraryAsset, ProbeInfo } from '@vidcut/shared';
import { probe } from './ffmpeg.js';
import { writeFilmstrip, writePeaks, writeProxy } from './ingest.js';
import { MEDIA_EXTENSIONS } from './sourceFolder.js';
import type { LibraryStore } from './libraryStore.js';

/** sha256（hex）。串流計算——庫素材可以是幾百 MB 的片頭檔，不整檔進記憶體。 */
export async function hashFile(abs: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export interface AddToLibraryOpts {
  label?: string;
  tags?: string[];
  origin: LibraryAsset['origin'];
  /** true = absPath 是我們自己的暫存檔（HTTP 上傳），入庫用 rename 而非複製 */
  move?: boolean;
}

/**
 * 素材庫的衍生檔組裝：filmstrip → proxy → peaks，**peaks.json 刻意最後寫** ⇒
 * 它存在代表整組完整（prepareFromLibrary 靠這個哨兵判斷）。
 * proxy 一律 transcode、不走 proxyPlan：庫檔要能直接預覽（/library/derived），
 * 匯入專案後也不依賴「絕對路徑原檔可直接播放」這個未驗證前提；代價是庫入庫
 * 多燒一次轉檔，一次性、可接受（spec：derived 入庫時就生）。
 * 失敗清理由呼叫端（addToLibrary）負責——helper 本身不清目錄。
 */
async function buildLibraryDerivatives(
  abs: string,
  derivedAbs: string,
  info: ProbeInfo,
): Promise<void> {
  const audioOnly = info.hasVideo === false;
  if (audioOnly && !info.hasAudio) throw new Error(`no usable stream in ${abs}`);
  if (!audioOnly) {
    await writeFilmstrip(abs, derivedAbs, info);
    await writeProxy(abs, derivedAbs, info, 'transcode');
  }
  await writePeaks(abs, derivedAbs, info);
}

/**
 * 入庫（spec 2026-08-21）：hash → 去重 → 複製為 files/<hash>.<ext> → 生 derived → 寫索引。
 * **全有全無**：任一步失敗把已落地的 files/derived 清掉再 rethrow——半套狀態
 * （檔在、索引沒有）是延遲引爆的孤兒檔。
 * 冪等：同 hash 已在庫中回既有 asset（existing: true），不重跑任何 ffmpeg。
 * derived 在入庫時就生（而非首次匯入專案時）：ingest 約 7× 實時是整條路的瓶頸，
 * 之後每次匯入專案都只是複製。
 */
export async function addToLibrary(
  lib: LibraryStore,
  absPath: string,
  opts: AddToLibraryOpts,
): Promise<{ asset: LibraryAsset; existing: boolean }> {
  const ext = extname(absPath).toLowerCase();
  if (!(MEDIA_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new Error(`unsupported extension: ${ext || '(none)'}`);
  }
  const hash = await hashFile(absPath);
  const dup = lib.byHash(hash);
  if (dup) {
    if (opts.move) await rm(absPath, { force: true }); // 上傳暫存檔：內容已在庫中，收掉
    return { asset: dup, existing: true };
  }
  const info = await probe(absPath); // 壞檔在任何落地之前就擋下
  const fileRel = join('files', `${hash}${ext}`);
  const fileAbs = join(lib.dir, fileRel);
  const derivedAbs = join(lib.dir, 'derived', hash);
  try {
    if (opts.move) await rename(absPath, fileAbs);
    else await copyFile(absPath, fileAbs);
    // derived 一律以庫內那份為來源——它才是之後被引用的檔
    await buildLibraryDerivatives(fileAbs, derivedAbs, info);
    const asset: LibraryAsset = {
      id: `lib-${nanoid(8)}`,
      kind: 'media',
      hash,
      file: fileRel,
      probe: info,
      label: opts.label ?? basename(absPath),
      tags: opts.tags ?? [],
      origin: opts.origin,
      addedAt: new Date().toISOString(),
    };
    await lib.mutate((assets) => {
      assets.push(asset);
    });
    return { asset, existing: false };
  } catch (e) {
    await rm(fileAbs, { force: true });
    await rm(derivedAbs, { recursive: true, force: true });
    throw e;
  }
}
