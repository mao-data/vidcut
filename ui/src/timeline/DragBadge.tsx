import type { CSSProperties } from 'react';
import { tickLabel } from './scale.js';

/** trim=時長(增減)；move=起點時間。單一元件全軌道共用，見 Plan 11 範圍裁決 2。 */
export type DragBadgeContent =
  { kind: 'trim'; duration: number; delta: number } | { kind: 'move'; start: number };

export interface DragBadgeState {
  /** 內容層座標（px），跟著把手/指標 1:1（不吃 CSS transition，見既有紀律） */
  leftPx: number;
  topPx: number;
  content: DragBadgeContent;
}

/**
 * 秒數格式化：<60s 用一位小數的 `Ns`，>=60s 借 `tickLabel` 的 `m:ss`
 * （四捨五入到整秒——badge 是拖曳中的粗略回饋，長時間場景不需要子秒精度）。
 */
function formatSeconds(seconds: number): string {
  return seconds < 60 ? `${seconds.toFixed(1)}s` : tickLabel(Math.round(seconds));
}

/** 帶號增減：正值/零都用 `+`，負值用 `−`（en dash，非 ASCII 連字號，跟裁決 2 範例一致）。 */
function formatDelta(delta: number): string {
  const sign = delta < 0 ? '−' : '+';
  return `${sign}${Math.abs(delta).toFixed(1)}s`;
}

/** badge 內容格式化（純函數，DragBadge 呈現層與測試共用）。 */
export function formatDragBadge(content: DragBadgeContent): string {
  if (content.kind === 'trim') {
    return `${formatSeconds(content.duration)} (${formatDelta(content.delta)})`;
  }
  return formatSeconds(content.start);
}

/**
 * 拖曳中的浮動時長/起點標籤。畫在 Timeline 頂層（不進 chip 內——chip 色彩定案不動），
 * 沒有 drag 時完全不畫。座標由呼叫端算好（把手/指標附近），這裡只負責呈現。
 */
export function DragBadge({ drag }: { drag: DragBadgeState | null }) {
  if (!drag) return null;
  const style: CSSProperties = {
    position: 'absolute',
    left: drag.leftPx,
    top: drag.topPx,
    // 拖曳中 1:1 跟手：不吃 transition（既有紀律，見 Timeline.tsx 其餘拖曳層）
    transform: 'translate(-50%, -100%)',
    padding: '2px 6px',
    borderRadius: 4,
    background: 'var(--card)',
    border: '1px solid var(--line-strong)',
    color: 'var(--text-1)',
    fontSize: 11,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    zIndex: 20,
  };
  return <div style={style}>{formatDragBadge(drag.content)}</div>;
}
