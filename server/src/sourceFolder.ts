import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

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
