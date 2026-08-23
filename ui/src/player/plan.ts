import {
  clipSourceTime,
  locate,
  outputDuration,
  overlayWindow,
  totalDuration,
  type CaptionItem,
  type Project,
  type VideoClip,
} from '@vidcut/shared';
import { mediaUrl } from '../ws.js';

export interface ActiveSource {
  clipIndex: number;
  clipId: string;
  src: string;
  /**
   * clip.in + clip 內偏移（定格幀固定為 clip.in）——經 `clipSourceTime` 換算，
   * 落在黑墊（leadPad）內時 `sourceFor` 回 `null` 整個 ActiveSource（見下方）。
   */
  sourceTime: number;
  /** 定格幀：畫面凍結，播放器不應推進此來源 */
  frozen: boolean;
  /** clip.volume（0–2；預覽端 clamp 到 1，>1 只在渲染生效） */
  volume: number;
}

/**
 * t 時刻該出聲的音訊軌項目。
 * 不帶 src：<audio> 元素是依 doc.tracks.audio 常駐渲染的（含非活躍項），
 * 來源由該處決定；這裡再算一份只會變成沒人讀的死欄位。
 */
export interface ActiveAudio {
  id: string;
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
  /**
   * t 落在 `[主軌總長, outputDuration)`——主軌畫面已結束、但輸出還沒結束（其他軌
   * 還有內容，Plan 13 裁決 1、4）。這段沒有影片來源，`active`/`next` 皆為 null；
   * Player（Task 3）依此把三層 video 隱藏/遮黑，而不是誤判成「空專案」。
   * 與 `done` 互斥：done 之後（t >= outputDuration）一律 false。
   */
  blackTail: boolean;
  /** t 已達輸出結尾（Plan 13 起＝outputDuration，含黑尾；以前是主軌 totalDuration） */
  done: boolean;
}

/**
 * OverlayItem → 播放器要畫的形狀。單獨抽出來是因為 Player 有第二個呼叫點：
 * 拖曳中的 overlay 就算離開時間窗也要留在畫面上（見 Player.tsx 的 withDragged），
 * 那條路徑必須跟這裡產生一模一樣的 src/position，否則會出現「補回來的那張圖路徑不同」。
 */
export function overlayView(
  o: Project['tracks']['overlays'][number],
): PlayerPlan['overlays'][number] {
  return { id: o.id, src: `/media/${o.imagePath}`, position: o.position };
}

/**
 * Plan 12 Task 2（裁決 3）：trim-in 拖曳中的即時 source 覆蓋，只認 clipId 相符的 clip。
 * Plan 14 Task 3：加可選 `leadPad`——拖進黑墊時（把手往右拖過內容起點）播放器要即時
 * 顯示黑，而不是繼續用 doc 舊的 leadPad 算出一個過期的來源時間。省略＝沿用 doc 的
 * `clip.leadPad`（Task 4 的拖曳寫入端目前還不帶這個欄位，正是靠這個可選設計維持
 * typecheck 過——沒帶 leadPad 的呼叫點行為不變）。
 */
export type TrimPreview = { clipId: string; in: number; leadPad?: number } | null;

/**
 * clip 的有效黑墊長度（review round 1 finding 3）：trimPreview 若指名這個 clip，
 * 優先用預覽的 `leadPad`；省略 leadPad 時回退到 doc 既有值（不能回退成 0——
 * 那會讓「只帶 in、沒帶 leadPad」的呼叫點在拖曳中把既有黑墊瞬間視覺移除，
 * 需求書點名的風險）；trimPreview 不指名這個 clip 就直接用 doc 值。
 * `sourceFor`／`planAt` 共用同一份計算，避免同一條 fallback 規則兩處手打各改一次。
 */
function effectivePadFor(
  clip: Pick<VideoClip, 'id' | 'leadPad'>,
  trimPreview: TrimPreview,
): number {
  const pad =
    clip.id === trimPreview?.clipId ? (trimPreview.leadPad ?? clip.leadPad) : clip.leadPad;
  return pad ?? 0;
}

function sourceFor(
  p: Project,
  clipIndex: number,
  offsetInClip: number,
  trimPreview: TrimPreview,
): ActiveSource | null {
  const clip = p.tracks.video[clipIndex];
  if (!clip) return null;
  const media = p.media.find((m) => m.id === clip.mediaId);
  if (!media) return null;
  // trimPreview 只覆蓋 in（與 leadPad，Plan 14）：非目標 clip（clipId 不符）維持用 doc 的
  // clip.in/leadPad，目標 clip 則用預覽值取代——offsetInClip 不受影響（clip 在時間軸上的
  // 起點 trim-in 不會移動，見 Timeline.tsx scheduleFollow(clipStart) 的註解）。
  const isTarget = clip.id === trimPreview?.clipId;
  const effectiveClip = isTarget
    ? { in: trimPreview!.in, leadPad: effectivePadFor(clip, trimPreview) }
    : clip;
  if (clip.frozen) {
    // 定格幀：黑墊之後才開始定格畫面（裁決原文）——offsetInClip 落在 pad 內同樣回 null，
    // 過了 pad 就固定顯示來源的 in（不推進，語意與無 leadPad 時相同）。
    const pad = effectiveClip.leadPad ?? 0;
    if (offsetInClip < pad) return null;
    return {
      clipIndex,
      clipId: clip.id,
      src: mediaUrl(media),
      sourceTime: effectiveClip.in,
      frozen: true,
      volume: clip.volume,
    };
  }
  const sourceTime = clipSourceTime(effectiveClip, offsetInClip);
  if (sourceTime === null) return null; // 落在黑墊內：該 clip 當下無畫面
  return {
    clipIndex,
    clipId: clip.id,
    src: mediaUrl(media),
    sourceTime,
    frozen: false,
    volume: clip.volume,
  };
}

function activeAudioAt(p: Project, t: number): ActiveAudio[] {
  const out: ActiveAudio[] = [];
  for (const a of p.tracks.audio) {
    const rel = t - a.start;
    if (rel < 0 || rel >= a.duration) continue;
    // 淡入淡出：線性增益（與 render.ts 的 afade 曲線一致到人耳分不出的程度）
    let gain = 1;
    if (a.fadeIn && rel < a.fadeIn) gain = rel / a.fadeIn;
    const remain = a.duration - rel;
    if (a.fadeOut && remain < a.fadeOut) gain = Math.min(gain, remain / a.fadeOut);
    out.push({
      id: a.id,
      sourceTime: a.in + rel,
      volume: a.volume * gain,
      ducking: a.ducking === true,
    });
  }
  return out;
}

/**
 * 時間軸時間 → 播放器該顯示的一切（Player 組件的唯一決策來源）。
 * `trimPreview` 省略或傳 null 時，映射與現行行為逐位元組相同（pin：plan.test.ts）。
 */
export function planAt(p: Project, t: number, trimPreview: TrimPreview = null): PlayerPlan {
  const total = totalDuration(p);
  // Plan 13 裁決 1、4：輸出/播放結尾改為 outputDuration（= max(主軌總長, 各軌最遠內容)），
  // 不再是主軌 totalDuration——[total, outputDuration) 是黑尾（其他軌還有內容、主軌已結束）。
  const output = outputDuration(p);
  const done = output > 0 && t >= output;
  // [0, total) 區間行為與改動前逐位元組相同（pin：plan.test.ts）；黑尾區間
  // （total <= t < output）没有主軌內容，loc 必為 null（Math.min(t, total) 夾在 total，
  // locate 在 t === total 回最後一個 clip 尾端——那是「主軌播完」，不是黑尾本身的來源，
  // 所以黑尾要另外判斷、把 active/next 明確清成 null，不能沿用夾制後的 loc）。
  // `output > total` 才可能有黑尾：空專案（total=0, output=0）不算——那是「沒有內容」，
  // 不是「主軌播完、其他軌還在演」。
  const blackTail = output > total && !done && t >= total;
  const loc = blackTail ? null : locate(p, Math.min(t, total));
  const active = loc ? sourceFor(p, loc.clipIndex, loc.offsetInClip, trimPreview) : null;
  // Plan 14 Task 3：premount 語意——offset 落在本 clip 的黑墊內時（active === null 但
  // loc 有效，即「該 clip 當下無畫面」的情形），next 要指向**本 clip 的內容起點**
  // （offsetInClip = pad，換算後 sourceTime = clip.in），不是下一個 clip：黑墊結束時
  // 才能無縫接上畫面。pad 要吃 trimPreview 覆蓋（拖曳中即時調整黑墊長度時，premount
  // 目標要跟著變，理由同 sourceFor 內 effectiveClip 的覆蓋）。不在黑墊內（含無 leadPad
  // 的既有行為）維持原本「premount 下一個 clip」不變。
  const effectivePad = loc !== null ? effectivePadFor(loc.clip, trimPreview) : 0;
  const inOwnPad = loc !== null && active === null && loc.offsetInClip < effectivePad;
  const next = loc
    ? inOwnPad
      ? sourceFor(p, loc.clipIndex, effectivePad, trimPreview)
      : sourceFor(p, loc.clipIndex + 1, 0, trimPreview)
    : null;
  const overlays = p.tracks.overlays
    .filter((o) => {
      const w = overlayWindow(p, o);
      return w && t >= w.start && t < w.end;
    })
    .map(overlayView);
  const captions = p.tracks.captions.filter((c) => t >= c.start && t < c.start + c.duration);
  const audio = activeAudioAt(p, t);
  const ducked = audio.some((a) => a.ducking);
  return { active, next, overlays, captions, audio, ducked, blackTail, done };
}
