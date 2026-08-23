// filmstrip sprite 的取樣計畫。純函數，server（ingest 組 ffmpeg 參數）與 UI
// （ClipBlock 依格數換算 background-position）共用同一份算式，避免兩邊各算一次、
// 各錯各的。
//
// 背景：filmstrip 是「每秒一幀、單列橫向 tile」的 sprite jpg（ffmpeg
// `fps=1,scale=-2:80,tile=Nx1`）。N 格單純等於 ceil(duration) 在短片沒問題，
// 但長片（例：28:05 的 1080p）N 衝到 1685、單列寬度 1685×142 ≈ 239,270px，
// 超過 JPEG 編碼器 65,500px 的上限，ffmpeg 以 exit 234 整個失敗（見
// 2026-08-20 真實回報）。修法：抓一個「JPEG 上限內塞得下的最大格數」當天花板，
// 超過就降頻取樣（fps < 1），維持均勻分佈；短片不受影響（天花板遠大於實際格數）。

/** JPEG 單邊像素上限是 65500；留一點安全邊距，不頂著邊界踩。 */
const JPEG_MAX_PX = 65000;

export interface FilmstripPlanInput {
  durationSec: number;
  /** 來源視訊寬（ffprobe，未旋轉的像素寬） */
  width: number;
  /** 來源視訊高 */
  height: number;
}

export interface FilmstripPlan {
  /** 單列 sprite 的格數（ffmpeg tile=Nx1 的 N） */
  tiles: number;
  /** 取樣頻率（ffmpeg fps=）。短片固定是 1；長片被 JPEG 上限夾住時 < 1。 */
  fps: number;
}

/**
 * ffmpeg `scale=-2:80` 的寬：先算等比例寬，四捨五入，再向上取到最近偶數
 * （`-2` 要求偶數對齊，實測 ffmpeg 在四捨五入後只會「往上」湊偶數，不會往下）。
 */
function tileWidth(width: number, height: number): number {
  const raw = Math.round((80 * width) / height);
  return raw % 2 === 0 ? raw : raw + 1;
}

/**
 * 算出這支素材的 filmstrip 應該切幾格、用多高的取樣頻率。
 *
 * 規則：單格輸出高固定 80px；`maxTiles = floor(65000 / tileW)` 是 JPEG 編碼器不會
 * 炸掉的格數天花板；`tiles = max(1, min(ceil(durationSec), maxTiles))`——短片
 * （ceil(duration) ≤ maxTiles）跟今天行為一致，逐秒一格；長片被夾到天花板，
 * `fps = tiles / durationSec` 讓 tiles 格仍然均勻覆蓋整支影片（不是只取前段）。
 */
export function filmstripPlan({ durationSec, width, height }: FilmstripPlanInput): FilmstripPlan {
  const tileW = tileWidth(width, height);
  const maxTiles = Math.max(1, Math.floor(JPEG_MAX_PX / tileW));
  const tiles = Math.max(1, Math.min(Math.ceil(durationSec), maxTiles));
  const fps = tiles / durationSec;
  return { tiles, fps };
}
