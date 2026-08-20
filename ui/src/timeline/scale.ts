export const DEFAULT_PX_PER_SECOND = 60;
export const MIN_PX_PER_SECOND = 5;
/**
 * 最小刻度=1 秒（使用者明示需求，Plan 9 範圍裁決 #2）。
 * 舊值 400 只是「原本能縮多細」，沒有語意約束；120 恰好停在 tickStepFor 的
 * 1s 檔門檻頂（pps>=40 才進 1s 檔，120 遠在門檻之上，不是巧合卡在邊界）。
 */
export const MAX_PX_PER_SECOND = 120;
/** 吸附的像素容忍度（CapCut 慣例約 8px） */
export const SNAP_THRESHOLD_PX = 8;

export const timeToPx = (t: number, pps: number): number => t * pps;
export const pxToTime = (px: number, pps: number): number => px / pps;

export interface ZoomBounds {
  min: number;
  max: number;
}

const DEFAULT_BOUNDS: ZoomBounds = { min: MIN_PX_PER_SECOND, max: MAX_PX_PER_SECOND };

/**
 * `bounds` 可選，缺省吃全域 MIN/MAX——保留向後相容,呼叫端不必全部改寫成
 * 動態界限(Plan 9 Task 1 範圍裁決 #b:clampPps 參數化,但不強制所有呼叫端改)。
 */
export const clampPps = (v: number, bounds: ZoomBounds = DEFAULT_BOUNDS): number =>
  Math.min(bounds.max, Math.max(bounds.min, v));

/**
 * 把時間吸附到最近的候選點（片段邊緣、playhead、整秒、beat…）。
 * 只在像素距離小於閾值時吸附，否則原值回傳。
 */
export function snapTime(
  time: number,
  candidates: number[],
  pps: number,
  thresholdPx = SNAP_THRESHOLD_PX,
): number {
  const thresholdSec = thresholdPx / pps;
  let best = time;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c - time);
    if (d < thresholdSec && d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

/** 讓整條時間軸剛好塞進容器寬度（Shift+Z）。 */
export function fitPps(totalSeconds: number, containerWidth: number, padding = 40): number {
  if (totalSeconds <= 0) return DEFAULT_PX_PER_SECOND;
  return clampPps((containerWidth - padding) / totalSeconds);
}

/**
 * 縮放的動態上下限（Plan 9 範圍裁決 #1）。
 *
 * - `max` 恆為 `MAX_PX_PER_SECOND`（120，最小刻度=1 秒的使用者需求，與專案長度無關）。
 * - `min`：長專案下探到「整個專案剛好入鏡」的 fit 值（可能遠低於舊下限 5，
 *   例如 1687 秒的專案在 1200px 視窗只有 ≈0.69px/s）；短專案的 fit 值本來就會
 *   遠大於 5（例如 10 秒片塞滿 640px 視窗要 60px/s），此時仍要保留「縮小看留白」
 *   的空間，所以下限維持 5。定案式：`min = min(fitPps(total, viewport), 5)`——
 *   注意這裡的 fitPps 只是「(viewport-padding)/total」的原始比例,不能借用
 *   `fitPps()` 本身(它內部呼叫 clampPps 會把長專案的极小值拉回舊 MIN=5,
 *   讓「下探到 fit」失效),所以下面直接算原始比例。
 * - `totalSeconds<=0`（空專案）与極端窄視窗都會被防呆,回退 `{min:5, max:120}`
 *   或至少保證 min 落在 `(0, max]` 之間、不會是 NaN/Infinity。
 */
export function zoomBoundsFor(
  totalSeconds: number,
  viewportWidth: number,
  padding = 40,
): ZoomBounds {
  const max = MAX_PX_PER_SECOND;
  if (totalSeconds <= 0) return { min: MIN_PX_PER_SECOND, max };

  const usableWidth = Math.max(0, viewportWidth - padding);
  const rawFit = usableWidth / totalSeconds;
  if (!Number.isFinite(rawFit) || rawFit <= 0) return { min: MIN_PX_PER_SECOND, max };

  const min = Math.min(rawFit, MIN_PX_PER_SECOND);
  // 防呆:min 理論上不可能超過 max(rawFit 再大也被 Math.min(_, 5) 蓋住、
  // 5 < 120),但視窗極端值時保底不讓 min > max。
  return { min: Math.min(min, max), max };
}

/**
 * 尺規刻度密度隨縮放調整（Plan 9 範圍裁決 #3：往下延伸到 300s 檔）。
 * 門檻由粗到細:pps>=40→1s、>=15→5s、>=5→10s、>=1.5→30s、>=0.5→60s、其餘→300s。
 * 舊表的 0.5s 檔（pps>=120）在新上限 MAX_PX_PER_SECOND=120 下不可達，故刪除。
 */
export function tickStepFor(pps: number): number {
  if (pps >= 40) return 1;
  if (pps >= 15) return 5;
  if (pps >= 5) return 10;
  if (pps >= 1.5) return 30;
  if (pps >= 0.5) return 60;
  return 300;
}

/**
 * 刻度標籤格式化：60 秒以下顯示 `Ns`，60 秒以上改 `m:ss`（分不補零、秒補到兩位）。
 * 刻度表往 300s 檔延伸後，純秒數標籤（如「1200s」）會比 `m:ss` 難讀。
 */
export function tickLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
