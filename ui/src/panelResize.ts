// 面板拖曳伸縮的決策邏輯（純函式，可測）。互動端在 PanelResizer.tsx。

export type PanelSide = 'left' | 'right';

export const PANEL = {
  left: { min: 200, max: 420, default: 260 },
  right: { min: 240, max: 500, default: 320 },
  /** 拖到比這更窄＝使用者想收合（CapCut/VSCode 慣例） */
  collapseBelow: 140,
} as const;

/**
 * 由游標推得的目標寬 rawPx → 面板該怎麼辦。
 * <collapseBelow：收合（width 不動，之後展開回到原寬）；否則夾進 [min, max]。
 */
export function resolvePanelDrag(
  side: PanelSide,
  rawPx: number,
): { open: boolean; width?: number } {
  if (rawPx < PANEL.collapseBelow) return { open: false };
  const { min, max } = PANEL[side];
  return { open: true, width: Math.round(Math.min(max, Math.max(min, rawPx))) };
}
