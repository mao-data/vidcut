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
 * duration:null 表示到片尾。
 */
export function overlayWindow(
  p: Project,
  o: OverlayItem,
): { start: number; end: number } | null {
  let start: number;
  if (o.anchor) {
    const idx = p.tracks.video.findIndex((c) => c.id === o.anchor!.clipId);
    if (idx === -1) return null;
    start = clipStartTimes(p)[idx]! + o.anchor.offset;
  } else if (o.start !== undefined) {
    start = o.start;
  } else {
    return null;
  }
  const end = o.duration === null ? totalDuration(p) : start + o.duration;
  return { start, end };
}
