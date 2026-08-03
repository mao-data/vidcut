/**
 * 播放中媒體元素的時鐘同步策略（spec 2026-08-02-preview-audio-sync）。
 * 小漂移調 playbackRate 追趕（不中斷、無雜音），大漂移才硬 seek。
 */
export type SyncAction = { kind: 'seek' } | { kind: 'rate'; rate: number };

/** 大跳（拖 playhead、換片段）才 seek */
const SEEK_AT = 0.25;
/** 死區：追到這裡就復速，避免在 0 附近抖動 */
const DEAD_ZONE = 0.02;
/** 比例增益與調速上限（±8%；preservesPitch 預設下人耳難察） */
const GAIN = 0.5;
const MAX_NUDGE = 0.08;

export function syncAction(drift: number): SyncAction {
  const mag = Math.abs(drift);
  if (mag >= SEEK_AT) return { kind: 'seek' };
  if (mag <= DEAD_ZONE) return { kind: 'rate', rate: 1 };
  const nudge = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, drift * GAIN));
  return { kind: 'rate', rate: 1 + nudge };
}
