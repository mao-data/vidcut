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
  /** clip.volume（0–2；預覽端 clamp 到 1，>1 只在渲染生效） */
  volume: number;
}

/** t 時刻該出聲的音訊軌項目（Player 對映到隱藏 <audio> 元素） */
export interface ActiveAudio {
  id: string;
  src: string;
  /** a.in + (t - a.start) */
  sourceTime: number;
  /** a.volume × 淡入淡出線性增益 */
  volume: number;
  ducking: boolean;
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
  /** t 時刻活躍的音訊項（含淡變後音量） */
  audio: ActiveAudio[];
  /** 任一活躍音訊項要求 ducking → 影片原聲要壓低（與 render.ts DUCK_LEVEL 同步） */
  ducked: boolean;
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
    volume: clip.volume,
  };
}

function activeAudioAt(p: Project, t: number): ActiveAudio[] {
  const out: ActiveAudio[] = [];
  for (const a of p.tracks.audio) {
    const rel = t - a.start;
    if (rel < 0 || rel >= a.duration) continue;
    const media = p.media.find((m) => m.id === a.mediaId);
    if (!media) continue;
    // 淡入淡出：線性增益（與 render.ts 的 afade 曲線一致到人耳分不出的程度）
    let gain = 1;
    if (a.fadeIn && rel < a.fadeIn) gain = rel / a.fadeIn;
    const remain = a.duration - rel;
    if (a.fadeOut && remain < a.fadeOut) gain = Math.min(gain, remain / a.fadeOut);
    out.push({
      id: a.id,
      src: mediaUrl(media),
      sourceTime: a.in + rel,
      volume: a.volume * gain,
      ducking: a.ducking === true,
    });
  }
  return out;
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
  const audio = activeAudioAt(p, t);
  const ducked = audio.some((a) => a.ducking);
  return { active, next, overlays, captions, audio, ducked, done };
}
