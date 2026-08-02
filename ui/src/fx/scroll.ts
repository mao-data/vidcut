/**
 * AI 變更發生在視窗外時的捲動目標。
 * 在可視範圍內 → null（不動）；範圍外 → 讓目標落在視窗約 1/3 處（不小於 0）。
 */
export function scrollTargetFor(
  targetPx: number,
  scrollLeft: number,
  clientWidth: number,
): number | null {
  if (clientWidth <= 0) return null; // 無法量測（如測試環境）→ 不捲
  if (targetPx >= scrollLeft && targetPx <= scrollLeft + clientWidth) return null;
  return Math.max(0, targetPx - clientWidth / 3);
}
