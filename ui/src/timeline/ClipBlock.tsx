import { memo, type PointerEvent } from 'react';
import { Snowflake } from 'lucide-react';
import type { Project, VideoClip } from '@vidcut/shared';
import { timeToPx } from './scale.js';
import { filmstripTilesFor, secPerTileFor, type VisibleRange } from './filmstripTiles.js';

/** 主軌列高(filmstrip 滿版)。2026-08-16 使用者多輪定案收斂:
 * 主軌=其他軌的 2 倍,同日兩輪放寬 60→64→70(=2×35)。之後想再調,改這
 * 一個數字即可(音訊/字幕/overlay 軌在 AudioChip/Timeline 的 35),改完跑
 * verify:canvas(拖曳幾何)。 */
export const ROW_H = 70;

/** memo：拖字幕/音訊/疊圖時主軌片段 props 全沒變，擋掉整排片段的陪跑重渲染 */
export const ClipBlock = memo(function ClipBlock({
  p,
  clip,
  leftPx,
  pps,
  selected,
  animate,
  floating,
  onTrimStart,
  onMoveStart,
  onSelect,
  fx = '',
  fxDelay,
  visibleRange,
  outAtMax = false,
}: {
  p: Project;
  clip: VideoClip;
  /** 已算好的水平位置（拖曳中的片段＝跟著游標，其他＝讓位後的新位置） */
  leftPx: number;
  pps: number;
  selected: boolean;
  /** 讓位時滑動過去，而不是瞬間跳 */
  animate: boolean;
  /** 正被拖曳：浮起、半透明 */
  floating: boolean;
  onTrimStart: (e: PointerEvent, clip: VideoClip, edge: 'in' | 'out') => void;
  onMoveStart: (e: PointerEvent, clip: VideoClip) => void;
  onSelect: (id: string) => void;
  /** AI 動畫層附加 class（' fx-enter' / ' fx-glow-a|b'）與骨牌進場延遲 */
  fx?: string;
  fxDelay?: number;
  /** Plan 11 Task 3（裁決 5）：out 把手是否已頂到來源長度上限（`dragMath.isAtSourceMax`，
   * Timeline.tsx 算好傳下來）。只影響 out 把手（來源上限只約束右緣），in 把手不受影響。
   * 預設 false——多數呼叫端（測試、非拖曳中的一般 render）不必逐個傳。 */
  outAtMax?: boolean;
  /** 目前捲動視窗覆蓋的內容座標區間（含 buffer，Timeline 傳下來、已量化）。
   * 缺省＝不裁窗（渲染全部格）——測試與極簡呼叫端不必每次都造一個視窗。 */
  visibleRange?: VisibleRange;
}) {
  const media = p.media.find((m) => m.id === clip.mediaId);
  const w = timeToPx(clip.duration, pps);
  // Plan 14 Task 4：黑墊（leadPad）視覺——取代舊的 `inAtMin` prop（`isAtSourceMin`
  // 的「danger+min 硬停」語意已廢止）。`clip.leadPad` 直接讀 props 傳入的 clip
  // （Timeline.tsx 的 `trimmedClips` 已經把拖曳中的 preview／pending 值攤平進去，
  // 這裡不必另外接一個拖曳專用的 prop）。padPx 供黑帶寬度與 filmstrip 內容區右移
  // 共用同一個數字——單一真相來源，不分兩處各自用 `leadPad * pps` 算一次。
  const pad = clip.leadPad ?? 0;
  const padPx = timeToPx(pad, pps);
  // Plan 11 Task 1（範圍裁決 3b/3c，review round 1 Important 1 修正）：算式與
  // Timeline.tsx 的 `handleOffset` 同款（三處手動同步——ClipBlock／AudioChip／
  // Timeline 的 caption+overlay chip，改一處記得改另外兩處）：選取態命中區 12px
  // 跨邊界置中（基準 -6），窄片（<28px）再疊加向外推的量，讓移動帶維持 [6, w-6]
  // 不縮水。未選取維持貼齊（inline `left:0`/`right:0`，行為不變）。
  const NARROW_THRESHOLD = 28;
  const SELECTED_HANDLE_W = 12;
  const overflowOffset = selected
    ? -SELECTED_HANDLE_W / 2 + (w < NARROW_THRESHOLD ? -Math.ceil((NARROW_THRESHOLD - w) / 2) : 0)
    : 0;
  // 2026-08-16 使用者定案:主軌**不顯示**波形帶,filmstrip 吃滿列高。
  // 波形機制(clipWave 查表/--wave-clip-* token/繪製器)完整保留——音訊軌仍用,
  // 要復原只需掛回 canvas+draw effect(參考 AudioChip.tsx 的現行寫法)。
  // 已知代價:muted(volume=0)原以波形變淡提示,現無時間軸層級的視覺線索
  // (音量狀態仍在 Inspector);frozen 的平線指示移除(Snowflake 圖示仍在)。
  const filmstrip = media?.filmstripPath ? `/media/${media.filmstripPath}` : undefined;
  const frameW = media ? ((ROW_H - 4) * media.probe.width) / media.probe.height : 45;
  // 每格代表幾秒：filmstripTiles 缺席 = 舊資產（本欄位加入之前 ingest 的）= 每秒一格
  // （secPerTileFor 內建回退）。有值時（長片會被 filmstripPlan 降頻取樣、格數
  // < duration）要用實際格數換算，否則長片的 filmstrip 會對不上 clip.in
  // （見 shared/src/filmstrip.ts 的 bug 說明）。
  const secPerTile = media ? secPerTileFor(media.probe.duration, media.filmstripTiles) : 1;
  // Plan 9 範圍裁決 #5：時間對齊逐格渲染（取代舊的單一 background-image 紋理）+
  // #6 windowing（visibleRange 缺省＝不裁窗）。frozen 或無 filmstrip 維持底色
  // （現行為，見下方 JSX），不生成任何 tile。
  // Plan 14 Task 4：filmstrip 只覆蓋「內容區」——寬度改吃 `clip.duration - pad`
  // （黑墊不是素材畫面，沒有 tile 可畫），windowing 的參照原點跟著右移 `padPx`
  // （`filmstripTilesFor` 內部用 `clipLeftPx` 換算 visibleRange 交集，內容區左緣
  // 已經不是 clip 左緣本身）。回傳的 tile.x 是「相對內容區左緣」的偏移，渲染時
  // 再加回 `padPx` 換算成「相對 clip 左緣」（見下方 JSX 的 `left: t.x + padPx`）
  // ——無 leadPad 時 pad=0/padPx=0，這條路徑與改動前逐位元組相同（回歸釘見
  // ClipBlock.test.tsx「無 leadPad 渲染輸出不變」）。
  const contentDur = clip.duration - pad;
  const tiles =
    filmstrip && !clip.frozen && media && contentDur > 0
      ? filmstripTilesFor(
          clip.in,
          contentDur,
          pps,
          frameW,
          secPerTile,
          media.filmstripTiles ?? Math.ceil(media.probe.duration),
          leftPx + padPx,
          visibleRange,
        )
      : [];
  return (
    <div
      className={'clipblk' + (selected ? ' selected' : '') + fx}
      onPointerDown={(e) => {
        onSelect(clip.id);
        onMoveStart(e, clip);
      }}
      title={`${clip.label ?? clip.id}  in=${clip.in.toFixed(2)}s dur=${clip.duration.toFixed(2)}s${
        clip.frozen ? ' (frozen)' : ''
      }`}
      style={{
        position: 'absolute',
        ...(fxDelay != null ? { animationDelay: `${fxDelay}ms` } : {}),
        left: leftPx,
        width: w,
        // 上下各 2px 浮在列裡(與字幕 chip 同款,2026-08-16 使用者定案 A)
        top: 2,
        height: ROW_H - 4,
        borderRadius: 'var(--r-card)',
        // Plan 11 Task 1（範圍裁決 3c）：這一層**不再**裁 overflow——選取窄片時把手
        // 要溢出到 chip 邊界外才抓得到。圓角裁切改交給下面的 filmstrip 內層自己扛
        // （它有自己的 overflow:hidden + 同樣的 borderRadius），這裡改成 visible
        // 純粹是為了讓把手（與其外溢的 negative left/right）不被裁掉。
        overflow: 'visible',
        // review round 1 Critical 1：選取態抬升到相鄰 chip 之上，這樣窄片外溢的
        // out 把手（負 right，蓋到下一個 DOM 序在後的 sibling 頭上）才不會被那個
        // sibling 的實色底吃走 pointer 事件——這個 UI 是單選（selectedId 模型，見
        // stores/selection.ts），永遠最多一個 chip 需要抬升，不會有兩個 15 互搶。
        // 低於 floating 的 20（正在拖曳的那個永遠最上面）。
        zIndex: selected ? 15 : undefined,
        cursor: floating ? 'grabbing' : 'grab',
        background: 'var(--card)',
        // 選取＝紅蠟筆圈起來的那一格（--select-edge）。刻意不吃 --accent：
        // 那是主行動色（Export/focus），時間軸的選取是標記層，兩者在暗版是不同顏料。
        // paper 下 --select-edge 指向 ink 字面值，computed 與收編前完全相同。
        boxShadow: selected
          ? 'inset 0 0 0 1.5px var(--select-edge), 0 0 14px var(--accent-glow)'
          : 'inset 0 0 0 1px var(--line-strong)',
        // 讓位動畫：只有「不是被拖的那個」才滑動，被拖的要 1:1 跟手。
        // 非拖曳時不寫 inline transition——box-shadow 補間在 .clipblk、
        // AI 窗的位置補間在 .ai-anim > div（inline 會蓋掉 class，寫了就掛不上）
        ...(animate ? { transition: 'left 120ms ease' } : {}),
        ...(floating
          ? {
              zIndex: 20,
              opacity: 0.9,
              transform: 'scale(1.02)',
              boxShadow: 'var(--shadow-float), inset 0 0 0 1.5px var(--select-edge)',
            }
          : null),
      }}
    >
      {/* filmstrip 縮圖滿版(波形帶已依使用者定案移除,見上方註解)。
          Plan 9 範圍裁決 #5：時間對齊逐格 div，取代單一 background-image 紋理——
          每格固定寬 frameW，各自用 backgroundPosition 裁出 sprite 的第 tileIndex 張。
          底色（frozen／無 filmstrip）鋪在容器層，逐格 div 疊在上面（tiles 為空陣列
          時容器底色照樣顯示，行為與舊版一致）。 */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 'var(--r-card)',
          backgroundColor: clip.frozen ? 'var(--clip-frozen-bg)' : undefined,
          overflow: 'hidden',
        }}
      >
        {filmstrip &&
          !clip.frozen &&
          tiles.map((t, i) => (
            <div
              key={`${t.x}-${t.tileIndex}-${i}`}
              data-testid="filmstrip-tile"
              style={{
                position: 'absolute',
                // t.x 是相對內容區左緣的偏移（見上方 tiles 計算的註解），加回 padPx
                // 換算成相對 clip 左緣——無 leadPad 時 padPx=0，逐位元組不變。
                left: t.x + padPx,
                top: 0,
                width: t.w,
                height: '100%',
                backgroundImage: `url(${filmstrip})`,
                backgroundPosition: `${-t.tileIndex * frameW}px 0`,
                backgroundSize: 'auto 100%',
                backgroundRepeat: 'no-repeat',
              }}
            />
          ))}
        {/* Plan 14 Task 4：黑墊視覺——clip 左緣起 `leadPad × pps` px 的黑帶，視覺語彙
            對齊 Plan 13 的黑尾斜紋帶（同一組 --clip-band-bg 斜紋疊 --panel，見
            Timeline.tsx 的 `tl-blacktail`）。純視覺、不可互動；pad<=0 時不畫（既有
            專案 / 未拖出黑墊時逐位元組不變，不多渲染一個空 div 的邊界情形也不畫，
            避免無意義的 DOM 節點）。 */}
        {pad > 0 && (
          <div
            data-testid="clip-leadpad"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: padPx,
              height: '100%',
              background: `repeating-linear-gradient(
                45deg,
                var(--clip-band-bg),
                var(--clip-band-bg) 6px,
                transparent 6px,
                transparent 12px
              ), var(--panel)`,
              pointerEvents: 'none',
            }}
          />
        )}
      </div>
      <div
        className={'handle' + (pad > 0 ? ' accent' : '')}
        style={{ left: overflowOffset }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onSelect(clip.id);
          onTrimStart(e, clip, 'in');
        }}
      />
      <div
        className={'handle' + (outAtMax ? ' danger' : '')}
        style={{ right: overflowOffset }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onSelect(clip.id);
          onTrimStart(e, clip, 'out');
        }}
      />
      <span
        style={{
          position: 'absolute',
          top: 4,
          // left 9 / maxWidth 18 是一組：要讓開 6px 的 trim handle，且兩側對稱（9×2=18）。
          // 屬於 chip 內部幾何，不是留白階梯。
          left: 9,
          fontSize: 11,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          textShadow: 'var(--clip-text-shadow)',
          pointerEvents: 'none',
          maxWidth: 'calc(100% - 18px)',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}
      >
        {/* size 11 是兩級制的時間軸 chip 例外（theme.css 有記）：標籤字級 11，
            13 會壓過文字。 */}
        {clip.frozen && <Snowflake size={11} />}
        {clip.label ?? clip.id}
      </span>
    </div>
  );
});
