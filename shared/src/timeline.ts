import type { MediaAsset, OverlayItem, Project, VideoClip } from './types.js';

export interface Located {
  clipIndex: number;
  clip: VideoClip;
  media: MediaAsset;
  offsetInClip: number;
}

/** 主軌總長（磁性：clip duration 總和）。 */
export function totalDuration(p: Project): number {
  return p.tracks.video.reduce((s, c) => s + c.duration, 0);
}

/**
 * 輸出長度（Plan 13 裁決 1）= max(主軌總長, 各 audio 的 start+duration,
 * 各 caption 的 start+duration, 各**具體時長** overlay 的 win.end)。
 * 主軌之後、outputDuration 之前是黑尾（見 ui/src/player/plan.ts 的 blackTail、
 * server/src/render.ts 的 tpad，Task 2/3）。
 *
 * **不變式（避免與 overlayWindow 循環）**：到片尾（`duration: null`）的 overlay
 * **不參與**這個 max——它的視窗結尾本身就是「跟隨 outputDuration」（見下方
 * `overlayWindow`），若把它納入計算會變成「輸出長度取決於一個取決於輸出長度的值」。
 * 這裡只用具體時長 overlay 的 `start + duration` 直接算 end，不呼叫
 * `overlayWindow`（後者對 to-end overlay 會遞迴回這個函式）。
 */
export function outputDuration(p: Project): number {
  let max = totalDuration(p);
  for (const a of p.tracks.audio) {
    max = Math.max(max, a.start + a.duration);
  }
  for (const c of p.tracks.captions) {
    max = Math.max(max, c.start + c.duration);
  }
  for (const o of p.tracks.overlays) {
    if (o.duration === null) continue; // to-end：跟隨輸出，不參與計算（見上方註解）
    const start = overlayStart(p, o);
    if (start === null) continue; // 錨點失效：overlayWindow 對它也回 null，不合成
    max = Math.max(max, start + o.duration);
  }
  return max;
}

/** overlayWindow 與 outputDuration 共用的起點解析（不含 end，避免循環）。 */
function overlayStart(p: Project, o: OverlayItem): number | null {
  if (o.anchor) {
    const idx = p.tracks.video.findIndex((c) => c.id === o.anchor!.clipId);
    if (idx === -1) return null;
    return clipStartTimes(p)[idx]! + o.anchor.offset;
  }
  if (o.start !== undefined) return o.start;
  return null;
}

/** 每個 clip 在時間軸上的起點（累加）。 */
export function clipStartTimes(p: Project): number[] {
  const starts: number[] = [];
  let t = 0;
  for (const c of p.tracks.video) {
    starts.push(t);
    t += c.duration;
  }
  return starts;
}

/**
 * 時間軸時間 → clip + clip 內偏移。
 * t 超出 [0, total] 回 null；邊界歸屬右側 clip；t === total 回最後一個 clip 的尾端。
 */
export function locate(p: Project, t: number): Located | null {
  if (t < 0) return null;
  const total = totalDuration(p);
  if (p.tracks.video.length === 0 || t > total) return null;
  const starts = clipStartTimes(p);
  if (t === total) {
    // 片尾特例：回最後一個 clip 的尾端
    const i = p.tracks.video.length - 1;
    return located(p, i, p.tracks.video[i]!.duration);
  }
  for (let i = p.tracks.video.length - 1; i >= 0; i--) {
    if (t >= starts[i]!) return located(p, i, t - starts[i]!);
  }
  return null;
}

function located(p: Project, clipIndex: number, offsetInClip: number): Located | null {
  const clip = p.tracks.video[clipIndex];
  if (!clip) return null;
  const media = p.media.find((m) => m.id === clip.mediaId);
  if (!media) return null;
  return { clipIndex, clip, media, offsetInClip };
}

/**
 * 解析 overlay 的時間窗。anchor 指向不存在的 clip 回 null；
 * duration:null 表示到片尾——**Plan 13 起「片尾」= outputDuration**（含黑尾），
 * 不再是 totalDuration：黑尾也要被到片尾的 overlay 蓋住（裁決 4）。
 * 這裡呼叫 `outputDuration` 是安全的：`outputDuration` 內部只用具體時長 overlay
 * 直接算 end，不會呼叫本函式，所以不構成循環（見 `outputDuration` 註解的不變式）。
 */
export function overlayWindow(p: Project, o: OverlayItem): { start: number; end: number } | null {
  const start = overlayStart(p, o);
  if (start === null) return null;
  const end = o.duration === null ? outputDuration(p) : start + o.duration;
  return { start, end };
}
