/**
 * filmstrip 的時間對齊逐格渲染數學（Plan 9 範圍裁決 #5、#6、#7）。
 *
 * 取代舊的「單一 background-image div + backgroundPosition 位移」模型
 * （見已刪除的 `dragMath.ts` 的 `filmstripBgOffset`）。舊模型的 tile 寬
 * （frameW，維持素材長寬比）與 pps 無關，只在「一格恰好等於畫面上一秒」時
 * 才會對齊；zoom 改變後這個假設就破了：zoom-out 時 tile 之間會出現看起來
 * 像是「重複紋理」的錯位，zoom-in 時單一 tile 被拉伸/裁切到超出可辨識範圍，
 * clip 寬 < 一格時整條 filmstrip 直接消失（無 tile 可畫）。
 *
 * 新模型：**每格都是獨立的 div**，固定寬 frameW（維持素材長寬比，不拉伸），
 * 每格用 backgroundPosition 精準裁出 sprite 的第 tileIndex 張縮圖。格數與
 * sprite 索引都由「這一格覆蓋的時間中點落在原始素材的哪一秒」反推——
 * zoom-out 時自然變成「每隔 N 格才推進一張新縮圖」（因為好幾格的中心時間
 * 落在同一個 tileIndex 內），zoom-in 時自然變成「同一張縮圖連續重複好幾格」
 * （因為一秒的畫面本來就該佔那麼多像素）。兩種情況都不需要特判——都是同一條
 * 换算式的自然結果。
 */

/** 一格 filmstrip 的渲染描述：在 clip 內的 x 偏移（px）、格寬（px，最後一格可能被裁）、
 * 要裁哪一張 sprite 縮圖。 */
export interface FilmstripTile {
  /** 這一格左緣相對 clip 左緣的偏移（px）。 */
  x: number;
  /** 這一格的寬度（px）。除了「clip 比一格還窄」的情況外恆等於 frameW；
   * 最後一格若超出 clip 右緣，由呼叫端的 `overflow:hidden` 裁掉，這裡仍回報
   * 未裁的 frameW（呼叫端不需要另外算裁切寬度）。 */
  w: number;
  /** sprite 裡第幾張縮圖（0-based），已 clamp 進 [0, tiles-1]。 */
  tileIndex: number;
}

/** 可見範圍在「內容座標系」（與 leftPx 同一個原點）下的 [start, end] px 區間。 */
export interface VisibleRange {
  start: number;
  end: number;
}

/**
 * secPerTile：filmstrip sprite 每格代表幾秒。
 * `filmstripTiles` 缺席（舊資產，本欄位加入之前 ingest 的）→ 回退每秒一格，
 * 與舊版 `filmstripBgOffset` 的回退語意一致。
 */
export function secPerTileFor(mediaDuration: number, filmstripTiles: number | undefined): number {
  if (!filmstripTiles || filmstripTiles <= 0) return 1;
  return mediaDuration / filmstripTiles;
}

/**
 * 算出一個 clip 要渲染哪些 filmstrip 格（含 windowing）。
 *
 * @param clipInSec   clip.in（clip 在素材裡的起點，秒）
 * @param clipDurSec  clip.duration（秒）
 * @param pps         目前的 px-per-second（決定「一格覆蓋幾秒」）
 * @param frameW      每格固定寬度（px，維持素材長寬比）
 * @param secPerTile  sprite 每格代表幾秒（由 secPerTileFor 算得）
 * @param tiles       sprite 實際格數（用來 clamp tileIndex；<=0 視為 1）
 * @param clipLeftPx  clip 左緣在內容座標系裡的 x（用來與 visibleRange 對齊）
 * @param visibleRange 目前捲動視窗覆蓋的內容座標區間（含 buffer）；缺省＝不裁窗
 *   （render 全部格——單元測試不必每次都造一個視窗）。
 *
 * clip 寬 < frameW 時只回一格（裁右緣，由呼叫端 CSS 負責），這一格的
 * tileIndex 用 clip 中點時間換算，永遠有一張可辨識縮圖（消失 bug 的修法）。
 */
export function filmstripTilesFor(
  clipInSec: number,
  clipDurSec: number,
  pps: number,
  frameW: number,
  secPerTile: number,
  tiles: number,
  clipLeftPx: number,
  visibleRange?: VisibleRange,
): FilmstripTile[] {
  if (clipDurSec <= 0 || pps <= 0 || frameW <= 0) return [];
  const tileCount = Math.max(1, tiles);
  const clipWidthPx = clipDurSec * pps;

  const tileIndexAtCenterTime = (centerTimeSec: number): number => {
    const raw = Math.round(centerTimeSec / secPerTile);
    return Math.min(tileCount - 1, Math.max(0, raw));
  };

  // clip 比一格還窄：單格，裁右緣（呼叫端 overflow:hidden），用 clip 中點時間取樣。
  if (clipWidthPx < frameW) {
    const centerTime = clipInSec + clipDurSec / 2;
    return [{ x: 0, w: frameW, tileIndex: tileIndexAtCenterTime(centerTime) }];
  }

  const totalSlots = Math.max(1, Math.ceil(clipWidthPx / frameW));

  // windowing：只算與 visibleRange 相交的格 index 範圍，其餘不生成（不進 DOM）。
  // slot i 覆蓋半開區間 [i·frameW, (i+1)·frameW)——與 relEnd 相交的最大 slot index
  // 是 floor(relEnd/frameW)，不是 ceil：例如 frameW=10、relEnd=305，slot 30 覆蓋
  // [300,310) 確實含 305（floor(305/10)=30，正確）；slot 31 覆蓋 [310,320)，整段
  // 在 relEnd 之後、不相交，但 ceil(305/10)=31 會多算進來，每次都多渲染一格
  // （review round 1 Important 3：ceil 是 off-by-one，不是刻意的保守 over-render）。
  let firstSlot = 0;
  let lastSlot = totalSlots - 1;
  if (visibleRange) {
    const relStart = visibleRange.start - clipLeftPx;
    const relEnd = visibleRange.end - clipLeftPx;
    // clip 與可視窗完全不相交 → 空陣列。
    if (relEnd < 0 || relStart > clipWidthPx) return [];
    firstSlot = Math.max(0, Math.floor(relStart / frameW));
    lastSlot = Math.min(totalSlots - 1, Math.floor(relEnd / frameW));
  }

  const out: FilmstripTile[] = [];
  for (let i = firstSlot; i <= lastSlot; i++) {
    const x = i * frameW;
    const centerTime = clipInSec + (i + 0.5) * (frameW / pps);
    out.push({ x, w: frameW, tileIndex: tileIndexAtCenterTime(centerTime) });
  }
  return out;
}

/**
 * 可視範圍量化（Plan 9 範圍裁決 #6）：捲動時把 [start, end] 對齊到 `step` px
 * 網格再往外擴一步，讓相鄰幾個 rAF frame 算出同一個量化範圍——避免每個
 * memo 化的 ClipBlock 在每一幀都因為 prop 參考/數值變化而重渲染整排片段。
 */
export function quantizeVisibleRange(range: VisibleRange, step = 256): VisibleRange {
  const start = Math.floor(range.start / step) * step;
  const end = Math.ceil(range.end / step) * step;
  return { start, end };
}
