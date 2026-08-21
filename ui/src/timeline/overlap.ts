/**
 * 同軌重疊區間計算（Plan 11 Task 4，裁決 7）：純函數，不碰 DOM。
 *
 * 適用對象是絕對時間軌（audio／caption／overlay）——這些軌上的項目各自帶獨立的
 * [start, end)，彼此可能刻意重疊（例如 BGM 疊 SFX），純視覺提示、不阻擋操作。
 * 主軌是磁性排列、結構上不可能重疊，不適用本函數（呼叫端不會對主軌用它）。
 *
 * 邊界語意：`a.end === b.start` 視為**相接、不算重疊**——半開區間 [start, end)
 * 的自然結果，也是裁決 7 明確釘住的案例。
 */

/** 一軌上的一個項目：只取時間窗，呼叫端自行把 id 對回原始資料。 */
export interface OverlapWindow {
  id: string;
  start: number;
  end: number;
}

/** 某個項目在時間軸上與同軌其他項目重疊的一段子區間。 */
export interface OverlapSegment {
  id: string;
  start: number;
  end: number;
}

/**
 * 逐項目算出「這個項目跟軌上其他項目重疊的子區間」，同一項目與多個鄰居的重疊
 * 若有重疊會先合併（避免呼叫端在同一個 id 上疊出重複的 danger 線段）。
 * 回傳陣列不保證順序；不重疊的項目不會出現在回傳值裡。
 */
export function overlapSegments(items: OverlapWindow[]): OverlapSegment[] {
  const out: OverlapSegment[] = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!;
    const raw: Array<{ start: number; end: number }> = [];
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      const b = items[j]!;
      const start = Math.max(a.start, b.start);
      const end = Math.min(a.end, b.end);
      // 半開區間相接（start === end）不算重疊，只有真正的正寬度交集才算。
      if (start < end) raw.push({ start, end });
    }
    for (const seg of mergeIntervals(raw)) {
      out.push({ id: a.id, start: seg.start, end: seg.end });
    }
  }
  return out;
}

/** 合併重疊/相接的區間（排序後線性掃描）。輸入可為空。 */
function mergeIntervals(
  segs: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  if (segs.length === 0) return [];
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}
