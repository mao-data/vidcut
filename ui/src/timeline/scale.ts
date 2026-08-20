export const DEFAULT_PX_PER_SECOND = 60;
export const MIN_PX_PER_SECOND = 5;
/**
 * 最小刻度=1 秒（使用者明示需求，Plan 9 範圍裁決 #2）。
 * 舊值 400 只是「原本能縮多細」，沒有語意約束；120 恰好讓 `tickPlanFor` 在
 * 最大縮放時解出 labelStepSec=1（120px >= MIN_LABEL_SPACING_PX=80），
 * 不是巧合卡在邊界。
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

/** `zoomBoundsFor`/`fitPps` 共用的尺規留白（左右各扣一點，避免整條頂到容器邊緣）。 */
export const FIT_PADDING_PX = 40;

/** 讓整條時間軸剛好塞進容器寬度（Shift+Z）。 */
export function fitPps(
  totalSeconds: number,
  containerWidth: number,
  padding = FIT_PADDING_PX,
): number {
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
  padding = FIT_PADDING_PX,
): ZoomBounds {
  const max = MAX_PX_PER_SECOND;
  if (totalSeconds <= 0) return { min: MIN_PX_PER_SECOND, max };

  const usableWidth = Math.max(0, viewportWidth - padding);
  const rawFit = usableWidth / totalSeconds;
  if (!Number.isFinite(rawFit) || rawFit <= 0) return { min: MIN_PX_PER_SECOND, max };

  // rawFit 再大也被 Math.min(_, 5) 蓋住、5 < MAX_PX_PER_SECOND(120),
  // min 不可能超過 max,不需要再夾一次。
  return { min: Math.min(rawFit, MIN_PX_PER_SECOND), max };
}

/**
 * 標籤最小像素間距（CapCut 式：任何縮放下標籤密度視覺恆定，不像舊制那樣在
 * 40px～120px 之間隨 pps 位置擺動）。門檻式尺規（`tickStepFor`）已退休，
 * 換成從「候選 nice step」裡挑最小滿足門檻的那個。
 */
export const MIN_LABEL_SPACING_PX = 80;
/** 細分點的最小像素間距，低於這個門檻寧可不畫點，也不要點密到糊成一片。 */
export const MIN_DOT_SPACING_PX = 10;

/** 候選刻度秒數：由細到粗，涵蓋 1 秒（使用者明示的最細需求）到 1 小時。 */
const NICE_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

export interface TickPlan {
  labelStepSec: number;
  dotStepSec?: number;
}

/**
 * 尺規刻度計畫（CapCut 式像素密度自適應，取代門檻式 `tickStepFor`）。
 * 標籤永遠挑「像素間距 >= MIN_LABEL_SPACING_PX」的最小 nice step——縮小時
 * 步距自動變粗，但視覺密度（標籤間距）在任何 pps 下都收斂在同一個下限附近，
 * 不會像舊制那樣在門檻邊界兩側從 ~40px 跳到 ~120px。
 * 標籤之間再視空間插入細分點（無文字，純刻度）：優先 /5 等分，太窄就退而
 * 求其次 /2，兩者都不滿足像素門檻就不畫點（寧缺勿密）。
 */
export function tickPlanFor(pps: number): TickPlan {
  const labelStepSec =
    NICE_STEPS.find((step) => step * pps >= MIN_LABEL_SPACING_PX) ??
    NICE_STEPS[NICE_STEPS.length - 1]!;

  const fifth = labelStepSec / 5;
  const half = labelStepSec / 2;
  let dotStepSec: number | undefined;
  if (fifth * pps >= MIN_DOT_SPACING_PX) {
    dotStepSec = fifth;
  } else if (half * pps >= MIN_DOT_SPACING_PX) {
    dotStepSec = half;
  }

  return dotStepSec === undefined ? { labelStepSec } : { labelStepSec, dotStepSec };
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
