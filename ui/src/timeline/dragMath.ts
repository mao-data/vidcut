import type { VideoClip } from '@vidcut/shared';

export const MIN_CLIP_DURATION = 0.1;

/**
 * 拖左 handle（in point）：同時改 in 與 duration，保持右邊界（in+duration）不動。
 * clamp：in>=0、duration>=MIN、in 不越過原右邊界。
 */
export function trimIn(
  clip: Pick<VideoClip, 'in' | 'duration'>,
  deltaSec: number,
): { in: number; duration: number } {
  const rightEdge = clip.in + clip.duration; // 來源座標的右界
  let nextIn = clip.in + deltaSec;
  nextIn = Math.max(0, Math.min(nextIn, rightEdge - MIN_CLIP_DURATION));
  return { in: nextIn, duration: rightEdge - nextIn };
}

/**
 * Plan 14 Task 4：拖左 handle（trim-in）的黑墊版——`trimIn` 的替代品，主軌拖曳分支
 * 改用這支。與 `trimIn` 的差異：越過來源起點（`in=0`）不再硬停，而是繼續往左長出
 * `leadPad`（黑墊），`duration` 同步增長以保持時間軸右界不動（黑墊算在 duration 裡，
 * 見 `VideoClip.leadPad` 的裁決）。
 *
 * 式子照 brief 逐字照用：
 *   延伸左座標 x = in − leadPad（pad>0 時為負）
 *   來源右界 R = in + (duration − leadPad)（拖曳中不變）
 *   x' = x + deltaSec，夾制：x' ≤ R − MIN_CLIP_DURATION（內容下限；無下界）
 *   x' ≥ 0 → { in: x', leadPad: 0, duration: R − x' }
 *   x' <  0 → { in: 0, leadPad: −x', duration: R + (−x') }
 *
 * 純函數、不吸附——in=0 邊界的來源座標吸附是 Timeline.tsx 層的事（見其註解），
 * 與 `trimOut`/`maybeSnap` 分工一致。無下界：leadPad 不設上限（與 CapCut 同，
 * 只驗有限性與 ≥0，見裁決；有限性交給呼叫端的浮點輸入本身保證）。
 */
export function trimInPad(
  clip: Pick<VideoClip, 'in' | 'duration' | 'leadPad'>,
  deltaSec: number,
): { in: number; leadPad: number; duration: number } {
  const pad = clip.leadPad ?? 0;
  const x = clip.in - pad; // 延伸左座標（可為負）
  const rightEdge = clip.in + (clip.duration - pad); // 來源右界 R（拖曳中不變）
  const nextX = Math.min(x + deltaSec, rightEdge - MIN_CLIP_DURATION);
  if (nextX >= 0) {
    return { in: nextX, leadPad: 0, duration: rightEdge - nextX };
  }
  return { in: 0, leadPad: -nextX, duration: rightEdge + -nextX };
}

/**
 * 拖右 handle（out point）：只改 duration。
 * clamp：duration>=MIN、in+duration<=mediaDuration。
 */
export function trimOut(
  clip: Pick<VideoClip, 'in' | 'duration'>,
  deltaSec: number,
  mediaDuration: number,
): { duration: number } {
  let nextDur = clip.duration + deltaSec;
  nextDur = Math.max(MIN_CLIP_DURATION, Math.min(nextDur, mediaDuration - clip.in));
  return { duration: nextDur };
}

/**
 * Plan 15 Task 1（統一拖曳模型核心式子）：修剪方向的佔位量（秒）。一次 trim 手勢內，
 * 以起手時的 `orig.duration` 為基準，每幀由 `trimInPad`/`trimOut` 算出 `next.duration`，
 * 兩者差即為「clip 的時間軸足跡該墊多少」——修剪方向（`next < orig`）佔位 > 0，
 * clip 足跡維持 `orig.duration` 不變，其他 clip 不 ripple；擴張方向（`next >= orig`）
 * 佔位恆為 0，行為與現況（Plan 12/14 已驗收的即時 ripple）逐位元組相同。
 * 單獨抽出是讓 Timeline.tsx 的 trim-in／trim-out 兩個把手分支共用同一個式子，
 * 不各自手打 `Math.max(0, ...)`。
 */
export function trimPlaceholder(origDuration: number, nextDuration: number): number {
  return Math.max(0, origDuration - nextDuration);
}

/**
 * Plan 11 Task 3（裁決 5）：主軌 out 把手是否已經頂到來源長度上限（`probe.duration`）
 * ——`trimOut` 的 clamp 讓 duration 增長不了了，這裡只是把「拉不動」這件事變成一個
 * 可查詢的布林，供 Timeline.tsx 決定要不要畫 danger 態把手 + badge `max`。
 * 用 `>=` 而非 `===`：`trimOut` clamp 出來的值理論上恰好等於邊界，但這裡多一層容錯
 * ——上游若因為拖曳中的浮點運算讓 duration 微幅超出，同樣該判定為「到頂了」。
 * `mediaDuration` 為 `Infinity`（無 probe 資料的既有 fallback，見呼叫端）時恆為 false
 * ——沒有已知上限就沒有「到頂」這回事。
 */
export function isAtSourceMax(
  clip: Pick<VideoClip, 'in' | 'duration'>,
  mediaDuration: number,
): boolean {
  if (!Number.isFinite(mediaDuration)) return false;
  return clip.in + clip.duration >= mediaDuration;
}

/**
 * 依指標 X（相對時間軸內容左緣的像素）算出拖曳中 clip 的新排序。
 * clipLayout：各 clip 的 {id, left, width}（像素）。回傳新的 id 順序。
 */
export function reorderByDrag(
  order: string[],
  draggingId: string,
  pointerX: number,
  clipLayout: Array<{ id: string; left: number; width: number }>,
): string[] {
  const others = order.filter((id) => id !== draggingId);
  // 落點 index：指標超過某 clip 中心就排在它之後
  let insertAt = others.length;
  for (let i = 0; i < others.length; i++) {
    const box = clipLayout.find((c) => c.id === others[i]);
    if (!box) continue;
    const center = box.left + box.width / 2;
    if (pointerX < center) {
      insertAt = i;
      break;
    }
  }
  const next = [...others];
  next.splice(insertAt, 0, draggingId);
  return next;
}

/**
 * 依給定順序算出每個片段的水平位置（px）。
 * order 為 null 時用陣列原順序。回傳 id → left 的對映，讓渲染可以「順序固定、只改位置」——
 * 若改成依 key 重排，React 會搬移 DOM 節點、CSS transition 會被中斷（讓位動畫就消失）。
 */
export function layoutByOrder(
  clips: Array<{ id: string; duration: number }>,
  order: string[] | null,
  pxPerSecond: number,
): Map<string, number> {
  const byId = new Map(clips.map((c) => [c.id, c]));
  const ordered = order ? order.map((id) => byId.get(id)).filter((c) => c !== undefined) : clips;
  const out = new Map<string, number>();
  let t = 0;
  for (const c of ordered) {
    out.set(c.id, t * pxPerSecond);
    t += c.duration;
  }
  return out;
}

/**
 * 絕對時間項（caption/audio/overlay）平移後的下限：start 不得小於 0。
 * 位移量由呼叫端先加好（要先過吸附），這裡只負責 clamp——
 * 曾經的 shiftStart(start, delta) 的 delta 在每個呼叫點都是 0，是誤導的簽名。
 */
export function clampStart(start: number): number {
  return Math.max(0, start);
}

/**
 * 拖左緣（caption 等純時間跨度）：右緣（start+duration）不動。
 * clamp：start>=0、duration>=MIN。
 */
export function trimSpanIn(
  item: { start: number; duration: number },
  deltaSec: number,
): { start: number; duration: number } {
  const rightEdge = item.start + item.duration;
  let nextStart = item.start + deltaSec;
  nextStart = Math.max(0, Math.min(nextStart, rightEdge - MIN_CLIP_DURATION));
  return { start: nextStart, duration: rightEdge - nextStart };
}

/** 拖右緣：只改 duration。clamp：>=MIN、<=maxDuration（省略＝無上限）。 */
export function trimSpanOut(
  item: { duration: number },
  deltaSec: number,
  maxDuration?: number,
): { duration: number } {
  let next = item.duration + deltaSec;
  if (maxDuration !== undefined) next = Math.min(next, maxDuration);
  return { duration: Math.max(MIN_CLIP_DURATION, next) };
}

/**
 * 音訊左緣：時間軸右緣不動，start/in/duration 連動（聲音內容不滑動）。
 * clamp：in>=0、start>=0、duration>=MIN——三者取最嚴格的位移。
 */
export function trimAudioIn(
  a: { start: number; in: number; duration: number },
  deltaSec: number,
): { start: number; in: number; duration: number } {
  const minDelta = Math.max(-a.in, -a.start); // 往左最多到 in=0 或 start=0
  const maxDelta = a.duration - MIN_CLIP_DURATION; // 往右最多留 MIN
  const d = Math.max(minDelta, Math.min(deltaSec, maxDelta));
  return { start: a.start + d, in: a.in + d, duration: a.duration - d };
}
