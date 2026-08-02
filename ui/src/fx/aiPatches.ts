import { clipStartTimes, overlayWindow, type JsonPatch, type Project } from '@vidcut/shared';

/** AI 一輪編輯的動畫描述：哪些項目要光暈、哪些要進場、要捲到哪。 */
export interface AiFx {
  /** 內容或位置被修改的項目 id（光暈） */
  touched: string[];
  /** 新增的項目 id（骨牌進場） */
  added: string[];
  /** added∪touched 中最早的時間軸起點（秒）；無可算時 null（自動捲動目標） */
  minStart: number | null;
}

const TRACKS = ['video', 'captions', 'overlays', 'audio'] as const;
type TrackName = (typeof TRACKS)[number];

const itemsOf = (doc: Project, t: TrackName): ReadonlyArray<{ id: string }> => doc.tracks[t];

/**
 * 從 immer patch 推出「AI 這輪動了什麼」。
 * 三種 patch 形狀（與 server 端 produceWithPatches 的輸出一致）：
 * - 深路徑（tracks.X.i.field…）→ 該 index 的項目 touched
 * - 元素替換（tracks.X.i，op add/replace）→ 依 id 是否存在於 prev 分 added/touched
 * - 整軌替換或含 'length'/remove 的陣列操作 → 退回整軌 diff（index 已位移，逐 patch 讀不可靠）
 */
export function analyzeAiPatches(patches: JsonPatch[], prev: Project, next: Project): AiFx {
  const added = new Set<string>();
  const touched = new Set<string>();
  const wholeTracks = new Set<TrackName>();

  for (const p of patches) {
    if (p.path[0] !== 'tracks') continue;
    const t = p.path[1] as TrackName;
    if (!TRACKS.includes(t)) continue;
    if (p.path.length === 2) {
      wholeTracks.add(t);
      continue;
    }
    const idx = p.path[2];
    if (typeof idx !== 'number') {
      // 'length' 等：陣列縮放，index 已不可信 → 整軌 diff
      wholeTracks.add(t);
      continue;
    }
    if (p.path.length === 3) {
      if (p.op === 'remove') {
        wholeTracks.add(t); // 移除使後續 index 位移 → 整軌 diff
        continue;
      }
      const id = (p.value as { id?: string } | undefined)?.id;
      if (!id) continue;
      if (itemsOf(prev, t).some((x) => x.id === id)) touched.add(id);
      else added.add(id);
    } else {
      const item = itemsOf(next, t)[idx];
      if (item) touched.add(item.id);
    }
  }

  for (const t of wholeTracks) {
    const prevArr = itemsOf(prev, t);
    const nextArr = itemsOf(next, t);
    const prevById = new Map(prevArr.map((x, i) => [x.id, { x, i }]));
    nextArr.forEach((x, i) => {
      const was = prevById.get(x.id);
      if (!was) added.add(x.id);
      else if (was.i !== i || JSON.stringify(was.x) !== JSON.stringify(x)) touched.add(x.id);
    });
  }

  // 只對 next 中仍存在的項目做動畫；同 id 以 added 優先
  const nextIds = new Set(TRACKS.flatMap((t) => itemsOf(next, t).map((x) => x.id)));
  const addedArr = [...added].filter((id) => nextIds.has(id));
  const touchedArr = [...touched].filter((id) => nextIds.has(id) && !added.has(id));

  let minStart: number | null = null;
  const consider = (s: number | null | undefined) => {
    if (s != null && (minStart === null || s < minStart)) minStart = s;
  };
  const all = new Set([...addedArr, ...touchedArr]);
  const starts = clipStartTimes(next);
  next.tracks.video.forEach((c, i) => all.has(c.id) && consider(starts[i]));
  next.tracks.captions.forEach((c) => all.has(c.id) && consider(c.start));
  next.tracks.audio.forEach((a) => all.has(a.id) && consider(a.start));
  next.tracks.overlays.forEach((o) => all.has(o.id) && consider(overlayWindow(next, o)?.start));

  return { touched: touchedArr, added: addedArr, minStart };
}
