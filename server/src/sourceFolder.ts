import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { MediaAsset } from '@vidcut/shared';
import { resolveMediaPath } from './paths.js';

/** 可匯入的副檔名（小寫比對）。影片與音訊都收，音訊可放旁白／BGM。 */
export const MEDIA_EXTENSIONS = [
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
  '.mkv',
  '.mp3',
  '.m4a',
  '.wav',
  '.aac',
] as const;

/**
 * 素材庫可收的圖片副檔名（小寫比對）。與 mograph assets 白名單同一組。
 * 刻意**不**併入 MEDIA_EXTENSIONS：素材夾掃描與 import_media 只認影音——
 * 圖片在專案裡是 overlay 素材不是 clip（「靜圖上主軌」另案）。
 */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.svg'] as const;

export interface SourceFile {
  name: string;
  size: number;
  /** epoch ms */
  mtime: number;
}

/**
 * 列出素材夾內可匯入的檔案。不遞迴、排除隱藏檔、依檔名排序。
 * 目錄不存在或不是目錄時丟錯（由呼叫端轉成 400）。
 *
 * 判斷「是不是檔案」用 stat 而非 Dirent.isFile()：
 * Dirent.isFile() 對 symlink 回 false（已實測），用它過濾會靜默漏掉 symlink 素材，
 * 而使用者用 symlink 組素材夾是常見做法。stat 會追隨 symlink，斷掉的連結則丟錯 → 略過。
 */
export async function scanSourceFolder(dir: string): Promise<SourceFile[]> {
  const info = await stat(dir); // 不存在會丟 ENOENT
  if (!info.isDirectory()) throw new Error(`not a directory: ${dir}`);

  const names = await readdir(dir);
  const out: SourceFile[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    if (
      !MEDIA_EXTENSIONS.includes(extname(name).toLowerCase() as (typeof MEDIA_EXTENSIONS)[number])
    ) {
      continue;
    }
    try {
      const s = await stat(join(dir, name)); // 追隨 symlink
      if (!s.isFile()) continue; // 目錄／裝置檔／斷掉的連結都不收
      out.push({ name, size: s.size, mtime: s.mtimeMs });
    } catch {
      continue; // 斷掉的 symlink 或讀不到權限：略過，不讓整次掃描失敗
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface SourceListing {
  dir: string;
  files: Array<SourceFile & { imported: boolean }>;
}

/**
 * 掃素材夾並標記哪些檔案已匯入本專案。HTTP（GET /api/source）與 MCP（list_source）
 * 共用同一個實作，兩邊回應形狀因此保證一致。
 *
 * `imported` 比對的是**解析後的絕對路徑**：doc.media 裡相對路徑代表專案內、
 * 絕對路徑代表零複製外部引用，直接比字串會漏判。
 */
export async function listSource(
  dir: string,
  media: readonly MediaAsset[],
  projectDir: string,
): Promise<SourceListing> {
  const files = await scanSourceFolder(dir);
  const imported = new Set(media.map((m) => resolveMediaPath(projectDir, m.path)));
  return { dir, files: files.map((f) => ({ ...f, imported: imported.has(join(dir, f.name)) })) };
}
