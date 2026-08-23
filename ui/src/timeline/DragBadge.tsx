import type { CSSProperties } from 'react';
import { tickLabel } from './scale.js';

/** trim=時長(增減)；move=起點時間。單一元件全軌道共用，見 Plan 11 範圍裁決 2。
 * `atMax`（Plan 11 Task 3 裁決 5）：主軌/audio out 把手已經頂到來源長度上限
 * （`probe.duration`）——只有 trim 用得到，move 沒有「來源上限」這回事。
 * `pad`（Plan 14 Task 4）：主軌 in 把手拖曳中 preview 的 leadPad（秒），>0 時顯示
 * 黑墊指示。**取代舊的 `atMin`**——`isAtSourceMin` 的「danger+min 硬停」語意已廢止
 * （現在拉得過去、長出黑墊，不是錯誤狀態），in 把手拖曳過界不再是「拉不動」而是
 * 「進入黑墊」，所以不再與 `atMax` 共用 boolean 語彙，改用數值攜帶黑墊長度。
 * 省略/0/undefined＝一般 trim，不附加任何字樣。 */
export type DragBadgeContent =
  | { kind: 'trim'; duration: number; delta: number; atMax?: boolean; pad?: number }
  | { kind: 'move'; start: number };

export interface DragBadgeState {
  /** 內容層座標（px），跟著把手/指標 1:1（不吃 CSS transition，見既有紀律） */
  leftPx: number;
  topPx: number;
  content: DragBadgeContent;
}

/**
 * fix round 1 I3：badge 尺寸的估計常數，供呼叫端（Timeline.tsx）在算 `leftPx`/`topPx`
 * 時做邊界 clamp。jsdom 沒有版面，量不到真實 DOM rect（見 Task 2 報告「已知限制」），
 * 這裡用固定估計值頂替——寧可估計值稍微保守（clamp 留一點餘裕），也不要完全不 clamp
 * 讓 badge 飄出可捲範圍。字體 11px＋padding 2/6px＋border 1px：單字元寬抓 7px、
 * 最長內容約 13 字元（`"1:05 (−65.0s)"` 這類），高度＝fontSize 行高＋padding+border。
 */
export const BADGE_WIDTH_ESTIMATE = 100;
export const BADGE_HEIGHT_ESTIMATE = 22;

/**
 * 秒數格式化：<60s 用一位小數的 `Ns`，>=60s 借 `tickLabel` 的 `m:ss`
 * （四捨五入到整秒——badge 是拖曳中的粗略回饋，長時間場景不需要子秒精度）。
 *
 * fix round 1 I5：**先捨入到顯示精度（1 位小數）再分支**，不是先用原始值分支。
 * 舊寫法用原始值判斷 `<60`，59.96 這種會捨入成 `60.0s` 的值卻落進 `<60` 分支、
 * 印出 `60.0s`（60 秒邊界可達，語意上該顯示 `1:00`）。改法：先算出捨入後的值，
 * 用它來決定要不要跨過 60 秒門檻——59.96 捨入成 60.0 後改用 `tickLabel(60)` ＝
 * `1:00`；59.94 捨入成 59.9 仍在 60 內，維持 `59.9s`。
 */
function formatSeconds(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10;
  return rounded < 60 ? `${rounded.toFixed(1)}s` : tickLabel(Math.round(rounded));
}

/**
 * 帶號增減：正值/零都用 `+`，負值用 `−`（en dash，非 ASCII 連字號，跟裁決 2 範例一致）。
 *
 * fix round 1 I4：**先捨入到顯示精度再依捨入後的值定號**，不是先用原始值定號。
 * 舊寫法用原始 `delta` 判斷正負，慢速微修時 delta 在 ±0.05 之間會先取到負號、
 * 捨入後卻顯示 `0.0`，變成 `−0.0s`/`+0.0s` 隨每次移動在正負號間閃爍（絕對值視覺
 * 上沒變，符號卻在跳）。改法：先算出捨入後的絕對值，用「捨入後是否為 0」決定
 * 一律顯示 `+0.0s`（與裁決 2「零增量仍帶正號」一致，不特判 0 顯示 `±`）。
 */
function formatDelta(delta: number): string {
  const rounded = Math.round(Math.abs(delta) * 10) / 10;
  const sign = rounded !== 0 && delta < 0 ? '−' : '+';
  return `${sign}${rounded.toFixed(1)}s`;
}

/**
 * badge 內容格式化（純函數，DragBadge 呈現層與測試共用）。
 *
 * 裁決 5：`atMax` 時附加 ` · max`——選這個格式而不是取代整段文字，是因為時長/增減
 * 數字本身仍是有用資訊（使用者想知道「頂到多長」），`max` 只是額外註記「這是上限」，
 * 不是取代掉數字。
 * Plan 14 Task 4：`pad>0` 時附加 ` · black +X.Xs`（英文，一位小數，同 `formatSeconds`
 * 的一位小數慣例但不借它的 `<60s`/`m:ss` 分支切換——黑墊是拖曳中的相對量，不是絕對
 * 時間點，用固定一位小數格式更直接）。`atMax` 與 `pad` 互斥（out 把手才有 atMax、
 * in 把手才有 pad，見呼叫端 Timeline.tsx），不需要處理都為真。
 */
export function formatDragBadge(content: DragBadgeContent): string {
  if (content.kind === 'trim') {
    const base = `${formatSeconds(content.duration)} (${formatDelta(content.delta)})`;
    if (content.atMax) return `${base} · max`;
    if (content.pad && content.pad > 0) return `${base} · black +${content.pad.toFixed(1)}s`;
    return base;
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
