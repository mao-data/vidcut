import {
  locate,
  overlayWindow,
  totalDuration,
  type CaptionItem,
  type Project,
} from '@vidcut/shared';
import { mediaUrl } from '../ws.js';

export interface ActiveSource {
  clipIndex: number;
  clipId: string;
  src: string;
  /** clip.in + clip 內偏移（定格幀固定為 clip.in） */
  sourceTime: number;
  /** 定格幀：畫面凍結，播放器不應推進此來源 */
  frozen: boolean;
}

export interface PlayerPlan {
  active: ActiveSource | null;
  /** 下一 clip 的起點（premount 用；最後一段時 null） */
  next: ActiveSource | null;
  overlays: Array<{
    id: string;
    src: string;
    position: { x: number; y: number; scale: number };
  }>;
  /** 直接給整條 CaptionItem：逐詞高亮需要 tokens，另投影一份只會漏欄位 */
  captions: CaptionItem[];
  /** t 已達片尾 */
  done: boolean;
}

function sourceFor(p: Project, clipIndex: number, offsetInClip: number): ActiveSource | null {
  const clip = p.tracks.video[clipIndex];
  if (!clip) return null;
  const media = p.media.find((m) => m.id === clip.mediaId);
  if (!media) return null;
  return {
    clipIndex,
    clipId: clip.id,
    src: mediaUrl(media),
    sourceTime: clip.frozen ? clip.in : clip.in + offsetInClip,
    frozen: clip.frozen === true,
  };
}

/** 時間軸時間 → 播放器該顯示的一切（Player 組件的唯一決策來源）。 */
export function planAt(p: Project, t: number): PlayerPlan {
  const total = totalDuration(p);
  const done = total > 0 && t >= total;
  const loc = locate(p, Math.min(t, total));
  const active = loc ? sourceFor(p, loc.clipIndex, loc.offsetInClip) : null;
  const next = loc ? sourceFor(p, loc.clipIndex + 1, 0) : null;
  const overlays = p.tracks.overlays
    .filter((o) => {
      const w = overlayWindow(p, o);
      return w && t >= w.start && t < w.end;
    })
    .map((o) => ({ id: o.id, src: `/media/${o.imagePath}`, position: o.position }));
  const captions = p.tracks.captions.filter((c) => t >= c.start && t < c.start + c.duration);
  return { active, next, overlays, captions, done };
}
