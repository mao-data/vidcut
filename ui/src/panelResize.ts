// 面板拖曳伸縮的決策邏輯（純函式，可測）。互動端在 PanelResizer.tsx。

export type PanelSide = 'left' | 'right';

export const PANEL = {
  // left default 325:2026-08-16 使用者定案「AI 欄加寬 25%」(260→325)。
  left: { min: 200, max: 420, default: 325 },
  right: { min: 240, max: 500, default: 320 },
} as const;

/**
 * 由游標推得的目標寬 rawPx → 夾進 [min, max] 的實際寬。
 * 拖到底就停在 min、不自動收合（使用者 2026-07-31 定案：收合只走 ⟨⟩ 鈕）。
 */
export function resolvePanelDrag(side: PanelSide, rawPx: number): number {
  const { min, max } = PANEL[side];
  return Math.round(Math.min(max, Math.max(min, rawPx)));
}
