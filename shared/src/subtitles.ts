/**
 * 把 CaptionItem 序列化成 SRT / WebVTT。
 *
 * 時間基準是**成品時間軸**——`CaptionItem.start` 本來就是時間軸絕對秒，
 * 與匯出影片的 0 秒對齊，所以這裡不做任何換算。
 */
import type { CaptionItem } from './types.js';

/** 濾掉空字與零長度、依開始時間排序（同時開始時短的在前）。 */
function usableCues(
  captions: readonly CaptionItem[],
): { text: string; start: number; end: number }[] {
  return captions
    .filter((c) => c.text.trim() !== '' && c.duration > 0)
    .map((c) => ({ text: c.text.trim(), start: c.start, end: c.start + c.duration }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function stamp(seconds: number, sep: ',' | '.'): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60_000) % 60;
  const h = Math.floor(totalMs / 3_600_000);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)}${sep}${String(ms).padStart(3, '0')}`;
}

export function serializeSrt(captions: readonly CaptionItem[]): string {
  const cues = usableCues(captions);
  if (cues.length === 0) return '';
  return (
    cues
      .map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}`)
      .join('\n\n') + '\n'
  );
}

export function serializeVtt(captions: readonly CaptionItem[]): string {
  const cues = usableCues(captions);
  if (cues.length === 0) return 'WEBVTT\n';
  return (
    'WEBVTT\n\n' +
    cues.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.text}`).join('\n\n') +
    '\n'
  );
}
