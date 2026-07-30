export const DEFAULT_PX_PER_SECOND = 60;
export const MIN_PX_PER_SECOND = 5;
export const MAX_PX_PER_SECOND = 400;
/** 吸附的像素容忍度（CapCut 慣例約 8px） */
export const SNAP_THRESHOLD_PX = 8;

export const timeToPx = (t: number, pps: number): number => t * pps;
export const pxToTime = (px: number, pps: number): number => px / pps;

export const clampPps = (v: number): number =>
  Math.min(MAX_PX_PER_SECOND, Math.max(MIN_PX_PER_SECOND, v));

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
