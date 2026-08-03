import { isAbsolute, join } from 'node:path';

/**
 * 素材檔的實際位置。
 * 相對路徑＝專案資料夾內（既有行為）；絕對路徑＝外部引用（零複製匯入）。
 * 放在 server 而非 shared：shared 會被瀏覽器打包，引入 node:path 會讓 UI build 失敗。
 */
export function resolveMediaPath(projectDir: string, mediaPath: string): string {
  return isAbsolute(mediaPath) ? mediaPath : join(projectDir, mediaPath);
}
