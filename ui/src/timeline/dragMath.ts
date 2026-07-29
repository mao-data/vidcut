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
