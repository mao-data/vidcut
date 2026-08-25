import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, open, rename, rm, stat, cp } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { nanoid } from 'nanoid';
import type { LibraryAsset, ProbeInfo, MediaAsset } from '@vidcut/shared';
import { filmstripPlan } from '@vidcut/shared';
import { probe, runFfprobe } from './ffmpeg.js';
import { writeFilmstrip, writePeaks, writeProxy, type PreparedMedia } from './ingest.js';
import { resolveMediaPath } from './paths.js';
import { IMAGE_EXTENSIONS, MEDIA_EXTENSIONS } from './sourceFolder.js';
import type { LibraryStore } from './libraryStore.js';
import type { ProjectStore } from './store.js';

/** sha256（hex）。串流計算——庫素材可以是幾百 MB 的片頭檔，不整檔進記憶體。 */
export async function hashFile(abs: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/**
 * 輕量內容嗅探：讀檔案開頭 4KB（UTF-8），大小寫不敏感找 `<svg` 標記。
 * 只用來擋「垃圾內容偽裝 .svg」——不是完整的 svg 驗證（合法 svg 也可能把 `<svg`
 * 標記放在 4KB 之後，例如前面塞了大段 XML 註解/DOCTYPE，那種極端案例這裡量不到，
 * 但比起完全不驗證，先擋住最常見的「隨便一個 .txt 改副檔名」已經是淨改善）。
 */
async function looksLikeSvg(abs: string): Promise<boolean> {
  const fh = await open(abs, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8').toLowerCase().includes('<svg');
  } finally {
    await fh.close();
  }
}

/**
 * 圖片尺寸（資訊性）。svg 等 ffprobe 量不到尺寸的回 0×0——匯入分流看 kind，
 * 不靠這裡的數值；ffprobe 完全失敗（壞圖，非 svg）才視為壞檔丟錯，
 * 在任何落地之前擋下（與 probe() 對影音壞檔的把關同一個位置）。
 *
 * .svg 的 0×0 fallback 前先做內容嗅探（looksLikeSvg）：ffprobe 對合法 svg 也常常
 * 量不到尺寸（環境是否有 svg decoder而異），所以不能只憑「ffprobe 失敗 + 副檔名是
 * .svg」就放行——那樣任何內容是垃圾文字、副檔名硬改成 .svg 的檔案都會被照收，
 * 違反「壞圖在落地前拒收、零殘留」。嗅探到 `<svg` 才視為合法 svg 回 {0,0}，
 * 嗅探不到就是偽裝檔，一律當壞圖丟錯。
 */
async function probeImageSize(abs: string): Promise<{ width: number; height: number }> {
  try {
    const out = await runFfprobe([
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'json',
      abs,
    ]);
    const s = (JSON.parse(out) as { streams?: Array<{ width?: number; height?: number }> })
      .streams?.[0];
    if (!s?.width || !s?.height) throw new Error('no dimensions');
    return { width: s.width, height: s.height };
  } catch {
    if (extname(abs).toLowerCase() === '.svg' && (await looksLikeSvg(abs))) {
      return { width: 0, height: 0 };
    }
    throw new Error(`not a decodable image: ${abs}`);
  }
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
 * 同檔案內共用（prepareFromLibrary 的 lazy 重建呼叫）。
 * 哨兵只防整批刪除：derived/<hash>/ 被部分刪除（peaks.json 還在、proxy 被個別
 * 刪掉）不在保護範圍——prepareFromLibrary 只檢查 peaks.json 是否存在就判定完整。
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
  const isImage = (IMAGE_EXTENSIONS as readonly string[]).includes(ext);
  if (!isImage && !(MEDIA_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new Error(`unsupported extension: ${ext || '(none)'}`);
  }
  const hash = await hashFile(absPath);
  const dup = lib.byHash(hash);
  if (dup) {
    if (opts.move) await rm(absPath, { force: true }); // 上傳暫存檔：內容已在庫中，收掉
    return { asset: dup, existing: true };
  }
  // probe 分流：影音走 ffprobe 全量（既有 probe()），圖片走尺寸探測（probeImageSize）。
  // 兩者都在任何落地之前跑，壞檔（含副檔名對但內容爛的圖）在這裡就被擋下。
  const info: ProbeInfo = isImage
    ? { duration: 0, ...(await probeImageSize(absPath)), fps: 0, hasAudio: false, rotation: 0 }
    : await probe(absPath);
  const fileRel = join('files', `${hash}${ext}`);
  const fileAbs = join(lib.dir, fileRel);
  const derivedAbs = join(lib.dir, 'derived', hash);
  try {
    if (opts.move) await rename(absPath, fileAbs);
    else await copyFile(absPath, fileAbs);
    // derived 一律以庫內那份為來源——它才是之後被引用的檔。
    // 圖片零 derived：檔案本身即縮圖（/library/files/<hash><ext> 直接可用）。
    if (!isImage) await buildLibraryDerivatives(fileAbs, derivedAbs, info);
    const asset: LibraryAsset = {
      id: `lib-${nanoid(8)}`,
      kind: isImage ? 'image' : 'media',
      hash,
      file: fileRel,
      probe: info,
      label: opts.label ?? basename(absPath),
      tags: opts.tags ?? [],
      origin: opts.origin,
      addedAt: new Date().toISOString(),
    };
    // 權威去重：上面的 byHash 預檢只是省 ffmpeg 的快路徑，讀的是入函式時的快照，
    // 併發時可能是空/過期的（兩個 session 同時對同內容 addToLibrary）。mutate 內部
    // 先 #reload() 才套用 fn，所以這裡的 assets 是當下最新——命中就不 push，回既有
    // asset。此時已落地的 fileAbs/derivedAbs 不必清：內容定址、同 hash 同路徑，
    // 覆蓋寫入是冪等的，之後任何一個 session 再讀到的都是同一份內容。
    let winner: LibraryAsset | undefined;
    await lib.mutate((assets) => {
      const dupNow = assets.find((x) => x.hash === hash);
      if (dupNow) {
        winner = dupNow;
        return;
      }
      assets.push(asset);
    });
    if (winner) return { asset: winner, existing: true };
    return { asset, existing: false };
  } catch (e) {
    await rm(fileAbs, { force: true });
    await rm(derivedAbs, { recursive: true, force: true });
    throw e;
  }
}

/**
 * 庫素材匯入專案（spec 2026-08-21）：專案引用**庫內檔案的絕對路徑**（零複製語意
 * 原樣沿用；庫檔內容定址永不搬家，所以這個引用不會斷鏈），derived 從庫複製進
 * 專案（不重跑 ffmpeg）；庫的 derived 被清過就先重建（衍生檔是可拋棄快取）。
 * 與 prepareMedia 同一約定：**不寫文件**，登記交給呼叫端
 * （HTTP 走 applyCommand human、MCP 走 aiWrite 吃審核鎖）。
 * 冪等判斷同 prepareMedia：解析後絕對路徑相同 ⇒ 已匯入。
 * 已知限制：回傳後、呼叫端登記（applyCommand/aiWrite）失敗時，這裡已經 cp 進
 * 專案的 `derived/<id>/` 不會被自動清掉——呼叫端要收到失敗才知道要不要清，
 * prepareFromLibrary 自己並不知道結果。呼叫端應在登記失敗分支呼叫
 * `discardPrepared` 清掉；孤兒目錄本身無害（不會被任何 media 引用），只是佔空間。
 */
export async function prepareFromLibrary(
  store: ProjectStore,
  projectDir: string,
  lib: LibraryStore,
  assetId: string,
): Promise<PreparedMedia> {
  await lib.reload(); // 這個工作區常態多 session 同開：讀入口先 reload 才看得到別的 session 剛入庫的 asset
  const a = lib.get(assetId);
  if (!a) throw new Error(`no library asset ${assetId}`);
  if (a.kind === 'image') {
    // 圖片在專案裡是 overlay 素材，不是 clip：這個函式產出的是 MediaAsset
    // （media track 用），圖片匯入走另一條路（image import path，第二期 UI 待接）。
    throw new Error(
      `image asset ${assetId} cannot be imported as media; use the image import path (it becomes an overlay)`,
    );
  }
  const srcAbs = lib.fileAbs(a);
  try {
    await stat(srcAbs); // broken（files/ 缺檔）：ENOENT 直接擋在任何落地之前
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`library asset ${assetId} is broken (file missing on disk): ${a.file}`);
    }
    throw e;
  }

  const existing = store.doc.media.find((m) => resolveMediaPath(projectDir, m.path) === srcAbs);
  if (existing) return { existingId: existing.id };

  const libDerived = lib.derivedAbs(a);
  // peaks.json 是 buildLibraryDerivatives 的最後一步 ⇒ 它存在就代表整組完整（見該函式註解）
  if (!existsSync(join(libDerived, 'peaks.json'))) {
    await buildLibraryDerivatives(srcAbs, libDerived, a.probe);
  }
  const id = nanoid(8);
  const derivedRel = join('derived', id);
  await cp(libDerived, join(projectDir, derivedRel), { recursive: true });

  const audioOnly = a.probe.hasVideo === false;
  const asset: MediaAsset = {
    id,
    path: srcAbs,
    ...(audioOnly
      ? {}
      : {
          proxyPath: join(derivedRel, 'proxy.mp4'),
          filmstripPath: join(derivedRel, 'filmstrip.jpg'),
          // 與 writeFilmstrip 同參數重算（filmstripPlan 純函數）——不必把 tiles 存進庫
          filmstripTiles: filmstripPlan({
            durationSec: a.probe.duration,
            width: a.probe.width,
            height: a.probe.height,
          }).tiles,
        }),
    peaksPath: join(derivedRel, 'peaks.json'),
    probe: a.probe,
    label: a.label,
    meta: { libraryId: a.id, libraryHash: a.hash },
  };
  return { asset };
}

/**
 * prepareFromLibrary 成功但呼叫端登記（applyCommand/aiWrite）失敗時的清理：把已經
 * cp 進專案的 `derived/<id>/` 刪掉，避免遺留孤兒目錄。只對真正新建的 asset 有意義
 * ——`existingId` 分支沒有落地新目錄，呼叫端不需要也不應該呼叫這個。
 * 用 `dirname(asset.peaksPath)` 取相對目錄：peaksPath 對 media（含 audio-only）必存在，
 * 不必額外傳 id 進來。force:true——目錄本來就可能已經不存在，清理是盡力而為，不是斷言。
 */
export async function discardPrepared(projectDir: string, asset: MediaAsset): Promise<void> {
  // peaksPath 型別上是 optional（MediaAsset 共用型別），但 prepareFromLibrary 產出的
  // asset 一律會設——沒有就代表呼叫端拿到的不是這個函式的產物，沒有孤兒目錄可清。
  if (!asset.peaksPath) return;
  const derivedDir = join(projectDir, dirname(asset.peaksPath));
  await rm(derivedDir, { recursive: true, force: true });
}
