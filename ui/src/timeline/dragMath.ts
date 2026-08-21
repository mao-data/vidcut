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
