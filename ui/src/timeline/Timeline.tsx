import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { AudioLines, Captions, Film, Image, Paperclip } from 'lucide-react';
import {
  clipStartTimes,
  overlayWindow,
  totalDuration,
  type AudioItem,
  type VideoClip,
} from '@vidcut/shared';
import { useProject } from '../stores/project.js';
import { usePlayback } from '../stores/playback.js';
import { useSelection } from '../stores/selection.js';
import { useView } from '../stores/view.js';
import { sendCommand } from '../ws.js';
import { pxToTime, snapTime, tickLabel, tickPlanFor, timeToPx } from './scale.js';
import {
  trimIn,
  trimOut,
  reorderByDrag,
  layoutByOrder,
  clampStart,
  trimSpanIn,
  trimSpanOut,
  trimAudioIn,
  MIN_CLIP_DURATION,
} from './dragMath.js';
import { ClipBlock, ROW_H } from './ClipBlock.js';
import { quantizeVisibleRange, type VisibleRange } from './filmstripTiles.js';
import { AudioChip, AUDIO_ROW_H } from './AudioChip.js';
import { TimelineToolbar } from './Toolbar.js';
import { useEditFx } from '../stores/editFx.js';
import { scrollTargetFor } from '../fx/scroll.js';
import { gsap, motionOK } from '../motion.js';

const SUB_ROW_H = 35; // 2026-08-16 使用者定案：其他軌統一、主軌的一半;同日兩輪放寬 30→32→35
/** 尺規列高度。gutter 的交叉格要逐像素跟它對齊，所以抽成常數而不是兩處各寫 20。 */
const RULER_H = 20;
/**
 * 左側軌頭欄寬。**它在 content 之外**——所有水平座標（拖曳、吸附、尺規 seek）都以
 * contentRef／各自的 currentTarget rect 為基準，把 gutter 排除在那個座標系外，
 * 才不用在每個換算點各扣一次 32（漏一處就是整條軌對不上）。唯二需要顯式扣掉的是
 * 那兩個拿 **scroll 容器** clientWidth 當「可視寬」的地方（fit / Toolbar onFit），
 * 因為 scroll 容器同時包含 gutter 與 content。
 */
const GUTTER_W = 32;
/**
 * 軌道可視區高度（縱向捲動的視窗）。2026-08-16 使用者三輪定案：「區塊放大一點」
 * ＝260 →「軌道板縮 10%」＝234 →「再讓空間給畫面」＝200。之後要調高矮只改
 * 這個數字，不要改成算出來的值——它是版面預算，不是幾何推導。
 * 軌道總高（尺規 20＋主軌 70＋overlay 35＋字幕 35＋音訊 35 ＝ 195）目前還沒超過
 * （內距 198，餘裕 3px），這條路是為未來 >4 軌鋪的。
 */
const TRACKS_VIEW_H = 200;

/**
 * playhead：紫漸層＋光暈＋圓頭。只有它（和 Toolbar 的 Timecode）訂閱 playback time：
 * time 播放中每幀更新（rAF），若 Timeline 本體訂閱，整條時間軸會每秒重渲染 ~60 次。
 *
 * ⚠️ **鉛筆濾鏡（`filter: url(#ap-pencil)`）試裝過，結論是不上。** 別再試一次：
 * 紙主題下讓 playhead 也帶上大使館那隻手的濁度是很自然的想法（DESIGN.md 明寫
 * playhead 屬於紅鉛筆的職責），但實測兩端都不成立，而且成因是結構性的，不是調參數：
 *   - **1× DPR：濾鏡等於沒作用。** 逐像素比對（headless CDP、deviceScaleFactor 1）
 *     乾淨版 vs scale 2.6 只差 12 個像素／4400，scale 2.0 差 1 個。付了重繪成本、
 *     買到看不見的東西。
 *   - **2× DPR：作用了，但難看。** 10 倍放大下看到的不是石墨的濁，是**線緣被啃掉
 *     一塊塊的矩形缺口**，圓頭被壓成扁豆形。線寬量測：乾淨版恆定 4 device px，
 *     過濾後在 3–5 之間跳（±0.5 CSS px 的橫向抖動）。
 * 成因：`feDisplacementMap` 是**位移**像素，而 playhead 只有 2px 寬——任何看得見的
 * 位移量都是「整條線寬的一大半」，於是位移不是把線畫歪，是把線咬破。同一顆濾鏡在
 * `.ap-frame` / `.ap-ring` 上好看，因為那些是**長筆畫**，2.6px 的抖動讀成手繪的
 * 波浪；playhead 是**細線**，同樣的抖動讀成渲染壞掉。細線與位移濾鏡本質不相容。
 * 附帶（就算視覺過關也還有這關）：playhead 播放中每幀改 `left`，濾鏡會讓那條線
 * 每幀重跑一次 turbulence + displacement，成本落在最不該有成本的路徑上。
 * 所以紙主題下 playhead 維持乾淨線，紅色來自 `--accent-bright`（已是紅鉛筆）。
 */
function Playhead({ pps }: { pps: number }) {
  const time = usePlayback((s) => s.time);
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: timeToPx(time, pps) - 1,
        width: 2,
        // 紅蠟筆的筆尖→尾端。收尾端刻意不吃 --accent-2（暗房裡那是主鈕的白蠟筆，
        // 會讓 playhead 從紅漸層到白）；--playhead-tail 在 paper 下＝--accent-2 的
        // ink 字面值，紙上 computed 不變。
        background: 'linear-gradient(var(--accent-bright), var(--playhead-tail))',
        borderRadius: 1,
        boxShadow: '0 0 10px var(--accent-glow-strong)',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: 'var(--accent-bright)',
          // -3.5 = -(9-2)/2：把 9px 圓頭對齊 2px 線的中心。是置中算式，不是留白。
          margin: '-1px 0 0 -3.5px',
          boxShadow: '0 0 8px var(--accent-glow-strong)',
        }}
      />
    </div>
  );
}

type DragState =
  | { mode: 'trim-in' | 'trim-out'; clipId: string; startX: number; preview: VideoClip }
  // contentLeft 在 pointerdown 量一次快取：getBoundingClientRect 會強制同步 layout，
  // 不該在拖曳中每幀呼叫（layout thrashing）
  | { mode: 'move'; clipId: string; startX: number; pointerX: number; contentLeft: number }
  // 絕對時間軌（字幕/音訊/overlay）：拖曳＝平移 start、trim＝改跨度（主軌是磁性軌，語意不同）
  | {
      mode: 'cap';
      edge: 'move' | 'in' | 'out';
      id: string;
      startX: number;
      orig: { start: number; duration: number };
      preview: { start: number; duration: number };
    }
  | {
      mode: 'aud';
      edge: 'move' | 'in' | 'out';
      id: string;
      startX: number;
      mediaDur: number;
      orig: { start: number; in: number; duration: number };
      preview: { start: number; in: number; duration: number };
    }
  | {
      mode: 'ov';
      /** move＝平移；in/out＝Plan 11 Task 1（裁決 4）補的 trim 把手 */
      edge: 'move' | 'in' | 'out';
      id: string;
      startX: number;
      /** 拖曳期間以絕對時間顯示；錨定式放手時換算回 offset。
       * span 與 orig 同放：null＝to-end overlay（duration:null），只有 out 把手
       * 拖曳才會把它落地成具體數字（見 onPointerUp 的 'ov' 分支）。 */
      orig: { absStart: number; span: number | null; anchorClipId?: string };
      preview: { absStart: number; span: number | null };
    }
  | null;
export function Timeline() {
  const doc = useProject((s) => s.doc);
  const selected = useSelection((s) => s.selected);
  const pps = useView((s) => s.pxPerSecond);
  // AI 編輯動畫層：窗開著時軌道容器掛 ai-anim；touched 光暈、added 骨牌進場
  const fxWindow = useEditFx((s) => s.window);
  const fxStamp = useEditFx((s) => s.stamp);
  const fxTouched = useEditFx((s) => s.touched);
  const fxAdded = useEditFx((s) => s.added);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 時間軸內容層（座標換算的基準） */
  const contentRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState>(null);
  /**
   * 放手後、server echo 抵達前的顯示覆蓋（修「放手閃回原位」）：
   * pointerup 清掉 drag preview 的那幾幀 doc 還是舊值，畫面會閃回原位再跳到新位置。
   * 放手時把結果放進 pending 繼續蓋著，等 doc 對上才放掉；1.2s 保險絲避免命令被拒時卡住。
   */
  const pending = useRef<
    | { mode: 'cap'; id: string; start: number; duration: number }
    | { mode: 'aud'; id: string; start: number; in: number; duration: number }
    | {
        mode: 'ov';
        id: string;
        absStart: number;
        span: number | null;
        match:
          | { kind: 'start'; v: number }
          | { kind: 'offset'; clipId: string; v: number }
          /** trim 只送 duration，start/anchor 沒變、不必比對它們 */
          | { kind: 'duration' };
        /** trim 落地的新 duration（null＝to-end，未被 out 把手動過） */
        duration: number | null;
      }
    | { mode: 'clip-trim'; clipId: string; in: number; duration: number }
    | { mode: 'clip-order'; order: string[] }
    | null
  >(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setPending = (v: NonNullable<typeof pending.current>) => {
    pending.current = v;
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    pendingTimer.current = setTimeout(() => {
      pending.current = null;
      rerender();
    }, 1200);
  };
  useEffect(
    () => () => {
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
    },
    [],
  );
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);

  // ---- 拖曳啟動 handlers：useCallback 穩定 reference，memo(ClipBlock/AudioChip) 才擋得住
  // 「拖 A 軌時 B 軌整排陪跑重渲染」。只碰 ref 與 getState，不需依賴。----
  const onSelect = useCallback(
    (id: string) => useSelection.getState().select({ kind: 'clip', id }),
    [],
  );

  const onTrimStart = useCallback((e: PointerEvent, clip: VideoClip, edge: 'in' | 'out') => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      mode: edge === 'in' ? 'trim-in' : 'trim-out',
      clipId: clip.id,
      startX: e.clientX,
      preview: { ...clip },
    };
  }, []);

  const onMoveStart = useCallback((e: PointerEvent, clip: VideoClip) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      mode: 'move',
      clipId: clip.id,
      startX: e.clientX,
      pointerX: e.clientX,
      contentLeft: contentRef.current?.getBoundingClientRect().left ?? 0,
    };
  }, []);

  const onAudDrag = useCallback((e: PointerEvent, a: AudioItem, edge: 'move' | 'in' | 'out') => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    useSelection.getState().select({ kind: 'audio', id: a.id });
    const media = useProject.getState().doc?.media.find((m) => m.id === a.mediaId);
    const orig = { start: a.start, in: a.in, duration: a.duration };
    drag.current = {
      mode: 'aud',
      edge,
      id: a.id,
      startX: e.clientX,
      mediaDur: media?.probe.duration ?? Infinity,
      orig,
      preview: { ...orig },
    };
  }, []);

  // Ctrl/⌘+滾輪：以游標位置為錨點縮放。
  // deps 是 hasDoc 不是 []：Timeline 在專案抵達前 `return null`（見下方 !doc），
  // 首渲染沒有 DOM，空 deps 的那唯一一次 effect 拿到的 scrollRef.current 是 null，
  // listener 永遠掛不上——Ctrl+滾輪從功能加入起就是死的，2026-08-16 真瀏覽器探針
  // （事件到達容器但 defaultPrevented 恆 false）才抓到。hasDoc 翻真的那一輪
  // re-render 之後 effect 重跑，才真的掛上。（ui-verification.md 的
  // useRef+空 deps 陷阱；Timeline.wheelzoom.test 守著這個時序。）
  const hasDoc = doc !== null;
  /** 縮放補償的暫存：onWheel 算好、pps 渲染落地後由 layout effect 套用（見下）。 */
  const zoomScroll = useRef<number | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const content = contentRef.current;
      if (!content) return;
      /**
       * 錨點一律量 **content** 的 rect，不是 scroll 容器的。
       * content 是被捲動的那一層，它的 rect.left 已經含了 -scrollLeft 的位移，
       * 也已經含了左邊 gutter 那 32px 的排版偏移——所以 `clientX - contentRect.left`
       * 本身就是 content 座標，**不可以再加 scrollLeft**（加了會重複計一次）。
       * 舊寫法（scroll 容器 rect + scrollLeft）在沒有 gutter 時等價；gutter 進來後
       * 那條會整整偏 GUTTER_W，游標下的時間點會跳掉。
       */
      const anchorPx = e.clientX - content.getBoundingClientRect().left;
      const cursorTime = pxToTime(anchorPx, useView.getState().pxPerSecond);
      useView.getState().zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
      // 縮放後把同一時間點拉回游標下：目標捲動量＝新像素位置 −「游標離 content 可視左緣
      // 的距離」，後者＝游標離 scroll 容器左緣的距離再扣掉 gutter。
      // ⚠️ **不能在這裡同步寫 el.scrollLeft**：此刻 React 還沒吃到新 pps 重渲染，
      // content 還是舊寬度，瀏覽器會把賦值 clamp 到「舊佈局的可捲上限」（放大初期
      // 常常是 0），補償整個丟掉——真瀏覽器實測 12 步放大後游標下的時間點漂了
      // 857px。存進 ref，等 pps 那一輪渲染完、佈局有了新寬度，再由下面的
      // useLayoutEffect 套用。
      // clientLeft＝左邊框寬（well 有 1px border；rect.left 是含邊框的外緣）。
      // 不扣的話每步多算 1px，連續縮放會以每步 1px 的速度往右漂——真瀏覽器實測
      // 4 步 5.19px，扣掉後 <1px（次像素）。
      const viewportX = e.clientX - el.getBoundingClientRect().left - el.clientLeft - GUTTER_W;
      zoomScroll.current = timeToPx(cursorTime, useView.getState().pxPerSecond) - viewportX;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [hasDoc]);

  /** 縮放補償的遞延套用：pps 渲染落地（content 已是新寬度）後才寫 scrollLeft，
   *  避免上面說的舊佈局 clamp。掛在 layout effect 是為了趕在瀏覽器繪製前，
   *  不然會先閃一幀「放大了但還沒捲」的畫面。 */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && zoomScroll.current !== null) {
      el.scrollLeft = zoomScroll.current;
      zoomScroll.current = null;
    }
  }, [pps]);

  /**
   * filmstrip windowing 的可視範圍（Plan 9 範圍裁決 #6）。ClipBlock 只渲染與這個
   * 範圍相交的 tile——120pps 下一支 1687s 的 clip 會有 ~5200 格，DOM 絕不能全塞。
   *
   * - 範圍＝scroll 容器目前可見的 content 座標 [scrollLeft, scrollLeft+clientWidth]，
   *   前後各加一屏 buffer（捲動時提前把下一屏準備好，不會捲到一半看到空白）。
   * - **quantize 到 256px 網格**：把同一個 256px 量子內的多次捲動收斂成同一組
   *   `{start,end}` **數值**。但 `quantizeVisibleRange` 本身每次呼叫仍回傳新物件
   *   （純函數，見其測試）——真正擋掉 memo 化 ClipBlock 重渲染的是下面
   *   `setVisibleRange` 的 functional updater：數值沒變就回傳 `prev`（同一個物件
   *   參考），React 的 `Object.is` bail-out 才會生效，這一輪 state 更新完全不
   *   commit，subtree 不重渲染。少了這層，就算數值量化過，每次 setState 傳入的
   *   仍是新物件，還是會逐幀 commit、逐幀 shallow-compare 出「prop 變了」
   *   （review round 1 Critical 1 抓到：舊版直接 `setVisibleRange(quantized)`，
   *   量化只擋住了「窗口該不該動」，沒擋住「React 該不該重渲染」）。
   * - **rAF 節流**：scroll 事件本身可能每幀觸發多次，用一個 pending rAF id
   *   把同一幀內的多次 scroll 收斂成一次 state 更新。
   * - pps/width 改變（zoom、fit）時容器的 scrollLeft 可能沒變但可視內容已經不同
   *   （例如 fit 把整條時間軸縮進同一個 scrollLeft=0），所以量測也綁在 `pps` 依賴上，
   *   讓縮放落地後立刻重算一次範圍，不必等下一次使用者捲動才更新窗口。
   */
  const [visibleRange, setVisibleRange] = useState<VisibleRange | null>(null);
  const visRafRef = useRef<number | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      visRafRef.current = null;
      const viewportW = Math.max(0, el.clientWidth - GUTTER_W);
      const buffer = viewportW; // 前後各一屏 buffer（範圍裁決 #6）
      const raw: VisibleRange = {
        start: el.scrollLeft - buffer,
        end: el.scrollLeft + viewportW + buffer,
      };
      const next = quantizeVisibleRange(raw);
      // 數值沒變就回傳 `prev`（同一個物件參考）——React 對 functional updater
      // 回傳值做 `Object.is` 比較，相等就整輪 bail out，不 commit、不重渲染
      // subtree。這是真正擋住 memo 化 ClipBlock 逐幀重渲染的那一層（見上方註解）。
      setVisibleRange((prev) =>
        prev && prev.start === next.start && prev.end === next.end ? prev : next,
      );
    };
    const onScroll = () => {
      if (visRafRef.current !== null) return; // 同一幀內的多次 scroll 只排一次
      visRafRef.current = requestAnimationFrame(measure);
    };
    measure(); // 掛載/pps 變化時立刻算一次，不必等第一次 scroll 事件
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (visRafRef.current !== null) cancelAnimationFrame(visRafRef.current);
    };
  }, [hasDoc, pps]);

  // 供 Shift+Z（fit）取容器寬度
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !doc) return;
    // 扣 GUTTER_W：clientWidth 是 scroll 容器的（含左側軌頭欄），但 fit 要餵的是
    // **content 的可視寬**。不扣的話每次 fit 都多算 32px，內容會略微溢出右緣。
    (window as unknown as { __vidcutFit?: () => void }).__vidcutFit = () =>
      useView.getState().fit(totalDuration(doc), el.clientWidth - GUTTER_W);
  }, [doc]);

  /**
   * 自動 fit 政策（Plan 9 範圍裁決 #4）。
   *
   * - `hasFitOnLoad` 分辨「這是專案第一次抵達」(a) 與「同一個 doc 之後的 patch」(b)：
   *   `doc` 每次 patch 都會換新 reference，這顆 effect 的 deps 是 `[doc]` 所以每次
   *   patch 都會重跑一次——若不記「有沒有 fit 過」，(a) 會在每次 patch 都重跑一次
   *   等同於「每次改動都 fit」，跟 (b) 的「只在**總時長**變化時 fit」政策矛盾。
   * - `prevTotal` 記上一次看到的總時長，只有它變了才算「(b) 加/刪 clip」；
   *   同總時長的 patch（例如純改字幕文字）不觸發。
   * - (c) 拖曳中絕不 fit：`drag.current` 是同步 ref，這裡直接讀，不需要額外的
   *   響應式「isDragging」狀態——拖曳開始本身不會讓這顆 effect 重跑（它的 deps
   *   只有 doc），只有在「拖曳中途 doc 剛好也變了」時才會跑到這裡，讀 ref 拿到
   *   的是當下最新值。**拖曳中跳過時刻意不更新 `prevTotal`**：讓這次的總時長
   *   變化保持「待處理」，拖曳結束後下一次 doc 變化（哪怕總時長沒再變）會用
   *   舊的 `prevTotal` 重新比對出差異、補上這次錯過的 fit——不是遺忘，是延後。
   * - fit 觸發時清掉 pending 的 wheel-zoom 捲動補償（`zoomScroll.current`）：
   *   否則下一輪 pps 落地的 layout effect 會用縮放前算好的舊補償值去蓋掉
   *   fit 剛設定的 scrollLeft，两者互相打架。
   */
  const hasFitOnLoad = useRef(false);
  const prevTotal = useRef<number | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !doc) return;
    if (drag.current) return; // (c) 拖曳中絕不 fit；prevTotal 刻意不動，見上方註解

    const total = totalDuration(doc);
    const isLoad = !hasFitOnLoad.current;
    const totalChanged = prevTotal.current !== null && prevTotal.current !== total;
    prevTotal.current = total;

    if (!isLoad && !totalChanged) return; // 純內容變化（例如改字幕文字），不是 (a)/(b) 的範圍
    if (!isLoad && useView.getState().userZoomed) return; // (b) 使用者縮放過就不搶

    hasFitOnLoad.current = true;
    zoomScroll.current = null; // 與 wheel-zoom 的捲動補償互斥
    useView.getState().fit(total, el.clientWidth - GUTTER_W);
  }, [doc]);

  /**
   * (d) 視窗 resize：重算 zoomBounds；未手動縮放過時一併重新 fit。
   * deps 是 `hasDoc`、不是 `[]`：Timeline 在專案抵達前 `return null`（見下方
   * `!doc`），首渲染沒有 DOM，空 deps 的那唯一一次 effect 拿到的 `scrollRef.current`
   * 是 null，`observe()` 永遠掛不上——與上面 Ctrl+wheel listener 的掛載時序陷阱
   * 同一個坑（ui-verification.md 的 useRef+空 deps 陷阱；`Timeline.autofit.test`
   * 就是靠先 render 再 seed 的時序守著這裡）。ResizeObserver 本身會在容器尺寸變化
   * 時持續觸發，不需要隨 pps 重新 attach；callback 內一律用 `useProject.getState()`/
   * `useView.getState()` 讀最新值，避免閉包捕捉舊 doc。
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const d = useProject.getState().doc;
      if (!d) return;
      const total = totalDuration(d);
      const width = el.clientWidth - GUTTER_W;
      if (useView.getState().userZoomed) {
        useView.getState().setZoomBounds(total, width);
      } else {
        zoomScroll.current = null; // 與 wheel-zoom 的捲動補償互斥
        useView.getState().fit(total, width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasDoc]);

  // AI 變更在視窗外 → 平滑捲過去（reduced-motion 時直接跳）
  useEffect(() => {
    if (!fxStamp) return;
    const t = useEditFx.getState().consumeScroll();
    if (t === null) return;
    const el = scrollRef.current;
    if (!el) return;
    const target = scrollTargetFor(
      timeToPx(t, useView.getState().pxPerSecond),
      el.scrollLeft,
      // 同 fit：scrollTargetFor 要的是 content 的可視寬，clientWidth 含 gutter 得扣掉。
      // 不扣會把「已經看得到」的範圍高估 32px，貼著右緣的變更就不捲過去了。
      el.clientWidth - GUTTER_W,
    );
    if (target === null) return;
    if (motionOK()) gsap.to(el, { scrollLeft: target, duration: 0.4, ease: 'power2.out' });
    else el.scrollLeft = target;
  }, [fxStamp]);

  if (!doc) return null;

  // pending 對帳：doc 已反映我們送出的值 → 覆蓋功成身退
  {
    const pd = pending.current;
    if (pd) {
      const matched = (() => {
        switch (pd.mode) {
          case 'cap': {
            const c = doc.tracks.captions.find((x) => x.id === pd.id);
            return !c || (c.start === pd.start && c.duration === pd.duration);
          }
          case 'aud': {
            const a = doc.tracks.audio.find((x) => x.id === pd.id);
            return !a || (a.start === pd.start && a.in === pd.in && a.duration === pd.duration);
          }
          case 'ov': {
            const o = doc.tracks.overlays.find((x) => x.id === pd.id);
            if (!o) return true;
            const posMatch =
              pd.match.kind === 'start'
                ? o.start === pd.match.v
                : pd.match.kind === 'offset'
                  ? o.anchor?.clipId === pd.match.clipId && o.anchor?.offset === pd.match.v
                  : true; // 'duration'：trim 沒動 start/anchor，不比對位置
            return posMatch && o.duration === pd.duration;
          }
          case 'clip-trim': {
            const c = doc.tracks.video.find((x) => x.id === pd.clipId);
            return !c || (c.in === pd.in && c.duration === pd.duration);
          }
          case 'clip-order':
            return (
              doc.tracks.video.length === pd.order.length &&
              doc.tracks.video.every((c, i) => c.id === pd.order[i])
            );
        }
      })();
      if (matched) {
        pending.current = null;
        if (pendingTimer.current) {
          clearTimeout(pendingTimer.current);
          pendingTimer.current = null;
        }
      }
    }
  }
  /** 人拖曳中絕不掛動畫（1:1 跟手）；drag ref 在 rerender() 當下是新鮮的 */
  const aiAnim = fxWindow && !drag.current;
  const fxFor = (id: string): { cls: string; delay?: number } => {
    const i = fxAdded.get(id);
    if (i !== undefined) return { cls: ' fx-enter', delay: i * 40 };
    if (fxTouched.has(id)) return { cls: fxStamp % 2 ? ' fx-glow-a' : ' fx-glow-b' };
    return { cls: '' };
  };

  const total = totalDuration(doc);
  const starts = clipStartTimes(doc);
  const width = Math.max(timeToPx(total, pps) + 120, 600);

  const layout = doc.tracks.video.map((c, i) => ({
    id: c.id,
    left: timeToPx(starts[i]!, pps),
    width: timeToPx(c.duration, pps),
  }));

  /** 吸附候選：片段邊界、片尾、playhead、整秒（playhead 讀 getState，避免訂閱 time） */
  const snapCandidates = (): number[] => {
    const cands = [...starts, total, usePlayback.getState().time];
    for (let s = 0; s <= Math.ceil(total); s++) cands.push(s);
    return cands;
  };
  const maybeSnap = (t: number): number =>
    useView.getState().snapEnabled ? snapTime(t, snapCandidates(), pps) : t;

  // ---- 絕對時間軌（字幕/overlay）的拖曳啟動 ----
  const capture = (e: PointerEvent) =>
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

  const onCapDrag = (e: PointerEvent, id: string, edge: 'move' | 'in' | 'out') => {
    const c = doc.tracks.captions.find((x) => x.id === id);
    if (!c) return;
    capture(e);
    useSelection.getState().select({ kind: 'caption', id });
    const pd = pending.current;
    const orig =
      pd?.mode === 'cap' && pd.id === id
        ? { start: pd.start, duration: pd.duration }
        : { start: c.start, duration: c.duration };
    drag.current = { mode: 'cap', edge, id, startX: e.clientX, orig, preview: { ...orig } };
  };

  const onOvDrag = (e: PointerEvent, id: string, edge: 'move' | 'in' | 'out' = 'move') => {
    const o = doc.tracks.overlays.find((x) => x.id === id);
    const win = o && overlayWindow(doc, o);
    if (!o || !win) return;
    capture(e);
    useSelection.getState().select({ kind: 'overlay', id });
    const orig = {
      absStart: win.start,
      span: o.duration === null ? null : win.end - win.start,
      ...(o.anchor ? { anchorClipId: o.anchor.clipId } : {}),
    };
    drag.current = { mode: 'ov', edge, id, startX: e.clientX, orig, preview: { ...orig } };
  };

  /**
   * 平移時的雙邊吸附：左右緣哪邊吸得動就用哪邊（都吸不動回原值）。
   * span null（overlay 到片尾）只吸左緣。
   */
  const snapSpan = (rawStart: number, span: number | null): number => {
    if (!useView.getState().snapEnabled) return rawStart;
    const left = snapTime(rawStart, snapCandidates(), pps);
    if (left !== rawStart) {
      setSnapLine(left);
      return left;
    }
    if (span !== null) {
      const right = snapTime(rawStart + span, snapCandidates(), pps);
      if (right !== rawStart + span) {
        setSnapLine(right);
        return right - span;
      }
    }
    setSnapLine(null);
    return rawStart;
  };

  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const deltaSec = pxToTime(e.clientX - d.startX, pps);
    if (d.mode === 'trim-in' || d.mode === 'trim-out') {
      const index = doc.tracks.video.findIndex((c) => c.id === d.clipId);
      const clip = doc.tracks.video[index];
      if (!clip) return;
      const media = doc.media.find((m) => m.id === clip.mediaId);
      const mediaDur = media?.probe.duration ?? Infinity;
      const clipStart = starts[index]!;

      if (d.mode === 'trim-out') {
        const raw = trimOut(clip, deltaSec, mediaDur);
        // 吸附「時間軸上的右邊界」
        const snappedEdge = maybeSnap(clipStart + raw.duration);
        const dur = Math.min(
          Math.max(snappedEdge - clipStart, MIN_CLIP_DURATION),
          mediaDur - clip.in,
        );
        d.preview = { ...clip, duration: dur };
        setSnapLine(dur !== raw.duration ? clipStart + dur : null);
      } else {
        const raw = trimIn(clip, deltaSec);
        const sourceRight = clip.in + clip.duration;
        const snappedEdge = maybeSnap(clipStart + raw.duration);
        const dur = Math.min(
          Math.max(snappedEdge - clipStart, MIN_CLIP_DURATION),
          sourceRight, // in 不得小於 0
        );
        d.preview = { ...clip, in: sourceRight - dur, duration: dur };
        setSnapLine(dur !== raw.duration ? clipStart + dur : null);
      }
      rerender();
    } else if (d.mode === 'move') {
      d.pointerX = e.clientX;
      rerender();
    } else if (d.mode === 'cap') {
      if (d.edge === 'move') {
        d.preview = {
          start: clampStart(snapSpan(d.orig.start + deltaSec, d.orig.duration)),
          duration: d.orig.duration,
        };
      } else if (d.edge === 'in') {
        const raw = trimSpanIn(d.orig, deltaSec);
        const rightEdge = d.orig.start + d.orig.duration;
        const snapped = maybeSnap(raw.start);
        const start = Math.max(0, Math.min(snapped, rightEdge - MIN_CLIP_DURATION));
        d.preview = { start, duration: rightEdge - start };
        setSnapLine(snapped !== raw.start ? start : null);
      } else {
        const raw = trimSpanOut(d.orig, deltaSec);
        const snappedEdge = maybeSnap(d.orig.start + raw.duration);
        const duration = Math.max(MIN_CLIP_DURATION, snappedEdge - d.orig.start);
        d.preview = { start: d.orig.start, duration };
        setSnapLine(duration !== raw.duration ? d.orig.start + duration : null);
      }
      rerender();
    } else if (d.mode === 'aud') {
      if (d.edge === 'move') {
        d.preview = {
          ...d.orig,
          start: clampStart(snapSpan(d.orig.start + deltaSec, d.orig.duration)),
        };
      } else if (d.edge === 'in') {
        // 先吸附左緣、再用 trimAudioIn 統一 clamp（in>=0 / start>=0 / MIN）
        const raw = trimAudioIn(d.orig, deltaSec);
        const snapped = maybeSnap(raw.start);
        d.preview = trimAudioIn(d.orig, snapped - d.orig.start);
        setSnapLine(snapped !== raw.start ? d.preview.start : null);
      } else {
        const raw = trimSpanOut(d.orig, deltaSec, d.mediaDur - d.orig.in);
        const snappedEdge = maybeSnap(d.orig.start + raw.duration);
        const duration = Math.max(
          MIN_CLIP_DURATION,
          Math.min(snappedEdge - d.orig.start, d.mediaDur - d.orig.in),
        );
        d.preview = { ...d.orig, duration };
        setSnapLine(duration !== raw.duration ? d.orig.start + duration : null);
      }
      rerender();
    } else if (d.mode === 'ov') {
      if (d.edge === 'move') {
        d.preview = {
          absStart: clampStart(snapSpan(d.orig.absStart + deltaSec, d.orig.span)),
          span: d.orig.span,
        };
      } else {
        // trim（範圍裁決 4）：與 caption chip 同款，直接借 trimSpanIn/trimSpanOut。
        // to-end overlay（span===null）的「目前有效時長」＝總長減 absStart——
        // in 把手用它算右緣但不落地 duration（preview.span 維持 null）；
        // out 把手以它為起點把 duration 落地成具體數字（材料化）。
        const effectiveSpan = d.orig.span ?? totalDuration(doc) - d.orig.absStart;
        if (d.edge === 'in') {
          const raw = trimSpanIn({ start: d.orig.absStart, duration: effectiveSpan }, deltaSec);
          const rightEdge = d.orig.absStart + effectiveSpan;
          const snapped = maybeSnap(raw.start);
          const absStart = Math.max(0, Math.min(snapped, rightEdge - MIN_CLIP_DURATION));
          d.preview = {
            absStart,
            // to-end 維持 null（in 把手不落地 duration，語意仍是「到片尾」）
            span: d.orig.span === null ? null : rightEdge - absStart,
          };
          setSnapLine(snapped !== raw.start ? absStart : null);
        } else {
          const raw = trimSpanOut({ duration: effectiveSpan }, deltaSec);
          const snappedEdge = maybeSnap(d.orig.absStart + raw.duration);
          const span = Math.max(MIN_CLIP_DURATION, snappedEdge - d.orig.absStart);
          d.preview = { absStart: d.orig.absStart, span };
          setSnapLine(span !== raw.duration ? d.orig.absStart + span : null);
        }
      }
      rerender();
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setSnapLine(null);
    if (!d) return;
    if (d.mode === 'trim-in' || d.mode === 'trim-out') {
      const inSec = Number(d.preview.in.toFixed(3));
      const duration = Number(d.preview.duration.toFixed(3));
      setPending({ mode: 'clip-trim', clipId: d.clipId, in: inSec, duration });
      sendCommand({ name: 'updateClip', clipId: d.clipId, patch: { in: inSec, duration } });
    } else if (d.mode === 'move') {
      const order = reorderByDrag(
        doc.tracks.video.map((c) => c.id),
        d.clipId,
        d.pointerX - d.contentLeft,
        layout,
      );
      const changed = order.some((id, i) => id !== doc.tracks.video[i]!.id);
      if (changed) {
        setPending({ mode: 'clip-order', order });
        sendCommand({ name: 'reorderClips', order });
      }
    } else if (d.mode === 'cap') {
      if (d.preview.start !== d.orig.start || d.preview.duration !== d.orig.duration) {
        const start = Number(d.preview.start.toFixed(3));
        const duration = Number(d.preview.duration.toFixed(3));
        setPending({ mode: 'cap', id: d.id, start, duration });
        sendCommand({ name: 'updateCaption', id: d.id, patch: { start, duration } });
      }
    } else if (d.mode === 'aud') {
      if (
        d.preview.start !== d.orig.start ||
        d.preview.in !== d.orig.in ||
        d.preview.duration !== d.orig.duration
      ) {
        const start = Number(d.preview.start.toFixed(3));
        const inSec = Number(d.preview.in.toFixed(3));
        const duration = Number(d.preview.duration.toFixed(3));
        setPending({ mode: 'aud', id: d.id, start, in: inSec, duration });
        sendCommand({
          name: 'updateAudio',
          id: d.id,
          patch: { start, in: inSec, duration },
        });
      }
    } else if (d.mode === 'ov') {
      if (d.edge === 'move') {
        if (d.preview.absStart !== d.orig.absStart) {
          if (d.orig.anchorClipId) {
            // 錨定式：換算回相對片段起點的 offset（保持跟隨片段；可為負＝先於片段出現）
            const idx = doc.tracks.video.findIndex((c) => c.id === d.orig.anchorClipId);
            const clipStart = idx >= 0 ? clipStartTimes(doc)[idx]! : 0;
            const offset = Number((d.preview.absStart - clipStart).toFixed(3));
            setPending({
              mode: 'ov',
              id: d.id,
              absStart: clipStart + offset,
              span: d.orig.span,
              duration: d.orig.span,
              match: { kind: 'offset', clipId: d.orig.anchorClipId, v: offset },
            });
            sendCommand({
              name: 'updateOverlay',
              id: d.id,
              patch: { anchor: { clipId: d.orig.anchorClipId, offset } },
            });
          } else {
            const start = Number(d.preview.absStart.toFixed(3));
            setPending({
              mode: 'ov',
              id: d.id,
              absStart: start,
              span: d.orig.span,
              duration: d.orig.span,
              match: { kind: 'start', v: start },
            });
            sendCommand({ name: 'updateOverlay', id: d.id, patch: { start } });
          }
        }
      } else if (d.edge === 'in') {
        // in 把手：範圍裁決 4——放手一發 updateOverlay，anchor 模式的 offset 換算
        // 沿用上面 move 路徑同一套算式。span 只有原本就不是 to-end 時才落地成 duration
        // （to-end 的 in 拖曳「正常運作」但不材料化，見裁決 4 與 preview 算式）。
        if (d.preview.absStart !== d.orig.absStart) {
          const duration = d.preview.span === null ? null : Number(d.preview.span.toFixed(3));
          if (d.orig.anchorClipId) {
            const idx = doc.tracks.video.findIndex((c) => c.id === d.orig.anchorClipId);
            const clipStart = idx >= 0 ? clipStartTimes(doc)[idx]! : 0;
            const offset = Number((d.preview.absStart - clipStart).toFixed(3));
            setPending({
              mode: 'ov',
              id: d.id,
              absStart: clipStart + offset,
              span: d.preview.span,
              duration,
              match: { kind: 'offset', clipId: d.orig.anchorClipId, v: offset },
            });
            sendCommand({
              name: 'updateOverlay',
              id: d.id,
              patch:
                duration === null
                  ? { anchor: { clipId: d.orig.anchorClipId, offset } }
                  : { anchor: { clipId: d.orig.anchorClipId, offset }, duration },
            });
          } else {
            const start = Number(d.preview.absStart.toFixed(3));
            setPending({
              mode: 'ov',
              id: d.id,
              absStart: start,
              span: d.preview.span,
              duration,
              match: { kind: 'start', v: start },
            });
            sendCommand({
              name: 'updateOverlay',
              id: d.id,
              patch: duration === null ? { start } : { start, duration },
            });
          }
        }
      } else {
        // out 把手：只改 duration，start/anchor 完全不動——to-end overlay 從這裡
        // 材料化成具體數字（裁決 4：「to end」overlay 只有 out 把手有這個特殊行為）。
        if (d.preview.span !== d.orig.span) {
          const duration = d.preview.span === null ? null : Number(d.preview.span.toFixed(3));
          setPending({
            mode: 'ov',
            id: d.id,
            absStart: d.orig.absStart,
            span: d.preview.span,
            duration,
            match: { kind: 'duration' },
          });
          sendCommand({ name: 'updateOverlay', id: d.id, patch: { duration } });
        }
      }
    }
    rerender();
  };

  const onRulerClick = (e: MouseEvent<HTMLDivElement>) => {
    if (drag.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    usePlayback.getState().seek(maybeSnap(pxToTime(e.clientX - rect.left, pps)));
  };

  /**
   * 點時間軸空白處 → 取消選取（工項 0 的第二條路徑；另一條是 App 的 Escape）。
   *
   * **掛在內容層、靠 `data-tl-blank` 白名單分辨**，不是 `e.target === e.currentTarget`：
   * 「空白」不只有內容層自己，四條軌道各自的空處（chip 右邊那一大片）也是空白，
   * 而那些空處在 DOM 上屬於軌道 row 的 `<div>`。純 currentTarget 比較只會認得
   * 內容層本身，點軌道空處就沒反應——那正是使用者最常點的地方。
   *
   * 反過來，**絕不能只看 currentTarget 以外的冒泡**：clip / chip / 把手 / 尺規全都
   * 冒泡到這一層。尺規尤其不能碰——它的 click 是 seek。所以標記是**明確 opt-in**：
   * 只有內容層與四條軌道 row 掛 `data-tl-blank`，其餘一律不掛，於是
   * `e.target` 帶標記 ⇔ 點到的真的是空白。chip 的 click 目標是 chip 自己，
   * 沒有標記，一路冒泡上來也不會誤判（拖曳放手後補的那發 click 同理）。
   */
  const onBlankClick = (e: MouseEvent<HTMLDivElement>) => {
    if (drag.current) return;
    if (!(e.target instanceof Element) || !e.target.hasAttribute('data-tl-blank')) return;
    useSelection.getState().select(null);
  };

  // 拖曳 trim 中：用 preview 覆蓋顯示的 clip；放手後由 pending 接手蓋到 echo 抵達
  const trimmedClips = doc.tracks.video.map((c) => {
    const d = drag.current;
    if (d && (d.mode === 'trim-in' || d.mode === 'trim-out') && d.clipId === c.id) return d.preview;
    const pd = pending.current;
    if (pd?.mode === 'clip-trim' && pd.clipId === c.id)
      return { ...c, in: pd.in, duration: pd.duration };
    return c;
  });

  // 拖曳排序中：即時算出「放手後的順序」，讓其他片段先滑開讓位
  const moveDrag = drag.current?.mode === 'move' ? drag.current : null;
  const previewOrder = moveDrag
    ? reorderByDrag(
        doc.tracks.video.map((c) => c.id),
        moveDrag.clipId,
        moveDrag.pointerX - moveDrag.contentLeft,
        layout,
      )
    : pending.current?.mode === 'clip-order'
      ? pending.current.order
      : null;

  /**
   * 讓位後每個片段該在的位置（用 id 對映）。
   * 渲染時**維持原本的順序**、只改 left —— 若讓 React 依 key 重排，DOM 節點會被搬移，
   * CSS transition 會被中斷、變成瞬間跳位（動畫就沒了）。
   */
  const leftById = layoutByOrder(trimmedClips, previewOrder, pps);

  /** 被拖曳的片段：用「原始位置 + 游標位移」1:1 跟手，不吃讓位後的排版 */
  const draggedLeftPx = (() => {
    if (!moveDrag) return 0;
    const orig = layout.find((l) => l.id === moveDrag.clipId);
    return (orig?.left ?? 0) + (moveDrag.pointerX - moveDrag.startX);
  })();

  // 尺規刻度密度隨縮放調整：CapCut 式像素密度自適應（標籤永遠 >=80px 間距，
  // 縮放時步距自動變粗變細；細分點視空間插在標籤之間）——計畫邏輯住在 scale.ts。
  const { labelStepSec, dotStepSec } = tickPlanFor(pps);
  const labelCount = Math.floor(total / labelStepSec) + 1;
  const dotCount = dotStepSec ? Math.floor(total / dotStepSec) + 1 : 0;

  // 軌道之間的分隔線 2026-08-16 使用者定案移除(減線)——軌的辨識靠 gutter 圖示
  // 與 chip 本身;尺規底線(--line-strong)是結構線,保留。gutter 格的 border
  // 要與這裡逐位元組同步(見 gutterCell 註解)。
  const rowStyle: CSSProperties = {
    position: 'relative',
    height: ROW_H,
  };
  const subRow: CSSProperties = { ...rowStyle, height: SUB_ROW_H };
  const chip: CSSProperties = {
    position: 'absolute',
    height: SUB_ROW_H - 4,
    top: 2,
    borderRadius: 5,
    fontSize: 10,
    paddingLeft: 6,
    lineHeight: `${SUB_ROW_H - 4}px`,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  };
  /**
   * Plan 11 Task 1（範圍裁決 3c）：窄片（<28px）選取後把手外溢座標，caption／overlay
   * chip 共用同一個門檻與算式（ClipBlock／AudioChip 各自持有一份同款的，因為那兩個
   * 是獨立元件檔；這裡是 Timeline 內部直接畫 DOM，就地算即可）。
   */
  const NARROW_THRESHOLD = 28;
  const handleOffset = (w: number, isSel: boolean): number =>
    isSel && w < NARROW_THRESHOLD ? -Math.ceil((NARROW_THRESHOLD - w) / 2) : 0;

  /**
   * 軌頭欄的一格。高度與 borderBottom 必須跟右邊對應那一列**逐位元組相同**，
   * 差一像素整條 gutter 就會跟軌道錯開（愈往下累積愈明顯）。
   * 背景吃 `--panel`（兩主題都是實底：#202023 / #f7f3e9）而不是 `--timeline-well-bg`
   * ——後者是半透明 rgba，chip 從底下橫向捲過去會直接透出來。
   */
  const gutterCell = (h: number, border: string): CSSProperties => ({
    height: h,
    borderBottom: border,
    background: 'var(--panel)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-3)',
  });

  return (
    <div>
      <TimelineToolbar
        total={total}
        onFit={() => {
          const el = scrollRef.current;
          // 扣 GUTTER_W 的理由同 __vidcutFit：clientWidth 含左側軌頭欄。
          if (el) useView.getState().fit(total, el.clientWidth - GUTTER_W);
        }}
      />

      {/*
       * 捲動容器：雙軸。橫向是原本就有的時間軸捲動；縱向是為 >4 軌鋪路，
       * 高度由 TRACKS_VIEW_H 固定住，超過才出現捲軸。
       */}
      <div
        ref={scrollRef}
        style={{
          overflow: 'auto',
          height: TRACKS_VIEW_H,
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-panel)',
          background: 'var(--timeline-well-bg)',
          userSelect: 'none',
        }}
      >
        {/*
         * 兩欄：左軌頭欄 + 右內容欄。gutter 在 content **之外**，content 內部的
         * 結構與座標語意一格都沒動（見 GUTTER_W 註解）。
         * minHeight:'100%' ——內容不足可視高度時，下方空白也吃 well 背景並落在
         * onClick 的冒泡路徑上，所以點軌道下方的空處一樣 deselect。
         */}
        <div
          style={{ display: 'flex', minHeight: '100%', width: width + GUTTER_W }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          // 空白處點擊＝取消選取。標記與白名單邏輯見 `onBlankClick` 的註解。
          onClick={onBlankClick}
        >
          {/*
           * 軌頭欄：`sticky left:0` ——橫捲時釘在左邊，縱捲時跟著軌道走。
           * 它**不掛** `data-tl-blank`：空白 deselect 是明確 opt-in 白名單
           * （見 onBlankClick），點軌頭不該觸發任何事。
           */}
          <div
            style={{
              position: 'sticky',
              left: 0,
              zIndex: 3,
              flexShrink: 0,
              width: GUTTER_W,
              borderRight: '1px solid var(--line-strong)',
            }}
          >
            {/* 交叉格：雙向 sticky（left 由父層給、top 自己給），zIndex 全場最高，
                否則橫捲的 chip 或縱捲的尺規會蓋過它。 */}
            <div
              style={{
                ...gutterCell(RULER_H, '1px solid var(--line)'),
                position: 'sticky',
                top: 0,
                zIndex: 4,
              }}
            />
            <div style={gutterCell(ROW_H, 'none')}>
              <Film size={13} aria-label="video track" />
            </div>
            <div style={gutterCell(SUB_ROW_H, 'none')}>
              <Image size={13} aria-label="overlay track" />
            </div>
            <div style={gutterCell(SUB_ROW_H, 'none')}>
              <Captions size={13} aria-label="caption track" />
            </div>
            <div style={gutterCell(AUDIO_ROW_H, 'none')}>
              <AudioLines size={13} aria-label="audio track" />
            </div>
          </div>

          <div
            ref={contentRef}
            // flexShrink:0 ——width 是座標換算的基準（timeToPx 的值域），被 flex 壓縮
            // 一個次像素，整條時間軸的像素↔秒對應就跟 pps 對不上了。
            style={{
              position: 'relative',
              width,
              flexShrink: 0,
              minHeight: '100%',
              touchAction: 'none',
            }}
            data-tl-blank
          >
            {/* 尺規：`sticky top:0` ＋實底，縱捲時刻度釘在頂上、chip 不能從底下透出 */}
            <div
              style={{
                position: 'sticky',
                top: 0,
                zIndex: 2,
                height: RULER_H,
                background: 'var(--panel)',
                // 2026-08-16 使用者定案:時間線細緻一點——由 --line-strong 降一階
                borderBottom: '1px solid var(--line)',
                cursor: 'text',
              }}
              onClick={onRulerClick}
            >
              {Array.from({ length: labelCount }, (_, i) => {
                const t = i * labelStepSec;
                return (
                  <span
                    key={t}
                    className="mono"
                    style={{
                      position: 'absolute',
                      // +3：刻度線右側的讓字距離，屬於尺規幾何（對齊刻度），不是留白階梯
                      left: timeToPx(t, pps) + 3,
                      fontSize: 10,
                      color: 'var(--text-3)',
                    }}
                  >
                    {tickLabel(t)}
                  </span>
                );
              })}
              {/* 主刻度豎線(2026-08-16 使用者定案:主刻度短線)。6px/--line,貼尺規
                  帶底緣、不往軌道區延伸(減線後的乾淨要守住)。間距跟著 labelStepSec
                  走——CapCut 式像素密度自適應後,標籤永遠 >=80px 間距,這條線只在
                  「有標籤」的位置畫,不再是固定 4 等分。 */}
              {Array.from({ length: labelCount }, (_, i) => {
                const t = i * labelStepSec;
                return (
                  <span
                    key={`tick-${i}`}
                    style={{
                      position: 'absolute',
                      left: timeToPx(t, pps),
                      bottom: 0,
                      width: 1,
                      height: 6,
                      background: 'var(--line)',
                      pointerEvents: 'none',
                    }}
                  />
                );
              })}
              {/* 細分點：CapCut 式——縮放時不加更多文字,只在標籤之間補低對比的
                  細分點(2px 短線),密度視空間自動決定(dotStepSec 見 scale.ts)。
                  跳過與標籤重合的位置(labelStepSec 的整數倍),避免點疊在主刻度上。 */}
              {dotStepSec
                ? Array.from({ length: dotCount }, (_, i) => {
                    const t = i * dotStepSec;
                    // dotStepSec 恆為 labelStepSec 的整除（/5 或 /2，見 tickPlanFor），
                    // 用點數 i 對「每幾點一個標籤」取模，避免浮點誤差讓 t%labelStepSec
                    // 在邊界抖動、誤判成不重合。
                    const dotsPerLabel = Math.round(labelStepSec / dotStepSec);
                    const onLabel = i % dotsPerLabel === 0;
                    if (onLabel) return null;
                    return (
                      <span
                        key={`dot-${i}`}
                        style={{
                          position: 'absolute',
                          left: timeToPx(t, pps),
                          bottom: 0,
                          width: 1,
                          height: 3,
                          background: 'var(--line)',
                          opacity: 0.55,
                          pointerEvents: 'none',
                        }}
                      />
                    );
                  })
                : null}
            </div>
            {/* video 主軌。`data-tl-blank`＝這條軌道的空處也算空白（見 onBlankClick）。 */}
            <div style={rowStyle} className={aiAnim ? 'ai-anim' : undefined} data-tl-blank>
              {trimmedClips.map((c) => {
                const isDragged = moveDrag?.clipId === c.id;
                const cf = fxFor(c.id);
                return (
                  <ClipBlock
                    key={c.id}
                    p={doc}
                    clip={c}
                    fx={cf.cls}
                    fxDelay={cf.delay}
                    leftPx={isDragged ? draggedLeftPx : (leftById.get(c.id) ?? 0)}
                    pps={pps}
                    selected={selected?.kind === 'clip' && selected.id === c.id}
                    animate={moveDrag !== null && !isDragged}
                    floating={isDragged === true}
                    onTrimStart={onTrimStart}
                    onMoveStart={onMoveStart}
                    onSelect={onSelect}
                    visibleRange={visibleRange ?? undefined}
                  />
                );
              })}
            </div>
            {/* overlays 軌（拖曳平移＋左右緣 trim；錨定式改 offset）。
                Plan 11 Task 1（範圍裁決 4）：與 caption chip 同款把手，trimSpanIn/
                trimSpanOut 接在 onPointerMove/onPointerUp，這裡只負責畫。 */}
            <div style={subRow} className={aiAnim ? 'ai-anim' : undefined} data-tl-blank>
              {doc.tracks.overlays.map((o) => {
                let win = overlayWindow(doc, o);
                const d = drag.current;
                const pd = pending.current;
                if (win && d?.mode === 'ov' && d.id === o.id) {
                  const span = d.preview.span;
                  win = {
                    start: d.preview.absStart,
                    end: span === null ? win.end : d.preview.absStart + span,
                  };
                } else if (win && pd?.mode === 'ov' && pd.id === o.id) {
                  win = {
                    start: pd.absStart,
                    end: pd.span === null ? win.end : pd.absStart + pd.span,
                  };
                }
                const isSel = selected?.kind === 'overlay' && selected.id === o.id;
                const of = fxFor(o.id);
                const ovWidthPx = win ? timeToPx(win.end - win.start, pps) : 0;
                const ovOffset = handleOffset(ovWidthPx, isSel);
                return (
                  win && (
                    <div
                      key={o.id}
                      className={'clipblk' + (isSel ? ' selected' : '') + of.cls}
                      onPointerDown={(e) => onOvDrag(e, o.id, 'move')}
                      title={
                        o.anchor
                          ? 'Anchored to clip (drag changes offset; follows the clip)'
                          : undefined
                      }
                      style={{
                        ...chip,
                        cursor: 'grab',
                        ...(of.delay != null ? { animationDelay: `${of.delay}ms` } : {}),
                        left: timeToPx(win.start, pps),
                        width: ovWidthPx,
                        // Plan 11 Task 1（範圍裁決 3c）：窄片選取時把手要溢出，這層不能再裁掉它
                        ...(ovOffset !== 0 ? { overflow: 'visible' } : null),
                        color: 'var(--ok-text)',
                        background: 'var(--ok-chip-bg)', // 實色底(2026-08-16:chip 不透底)
                        boxShadow: isSel
                          ? 'inset 0 0 0 1.5px var(--ok)'
                          : 'inset 0 0 0 1px var(--ok-edge)',
                        // 錨定圖示要跟檔名置中對齊：chip 原本靠 lineHeight 置中文字，
                        // 行內 SVG 會壓在基線上；改 flex 對齊，高度仍由 chip 的固定值決定。
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      <div
                        className="handle"
                        style={{ left: ovOffset }}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          onOvDrag(e, o.id, 'in');
                        }}
                      />
                      <div
                        className="handle"
                        style={{ right: ovOffset }}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          onOvDrag(e, o.id, 'out');
                        }}
                      />
                      {/* size 11 是兩級制的時間軸 chip 例外（theme.css 有記）：chip 只有
                        20px 高、字級 10，13 會撐爆。 */}
                      {o.anchor && (
                        <Paperclip size={11} aria-label="anchored" style={{ flexShrink: 0 }} />
                      )}
                      {o.imagePath.split('/').pop()}
                    </div>
                  )
                );
              })}
            </div>
            {/* captions 軌（拖曳平移＋左右緣 trim） */}
            <div style={subRow} className={aiAnim ? 'ai-anim' : undefined} data-tl-blank>
              {doc.tracks.captions.map((c) => {
                const d = drag.current;
                const pd = pending.current;
                const view =
                  d?.mode === 'cap' && d.id === c.id
                    ? { start: d.preview.start, duration: d.preview.duration }
                    : pd?.mode === 'cap' && pd.id === c.id
                      ? { start: pd.start, duration: pd.duration }
                      : { start: c.start, duration: c.duration };
                const isSel = selected?.kind === 'caption' && selected.id === c.id;
                const cf = fxFor(c.id);
                const capWidthPx = timeToPx(view.duration, pps);
                const capOffset = handleOffset(capWidthPx, isSel);
                return (
                  <div
                    key={c.id}
                    className={'clipblk' + (isSel ? ' selected' : '') + cf.cls}
                    onPointerDown={(e) => onCapDrag(e, c.id, 'move')}
                    style={{
                      ...chip,
                      cursor: 'grab',
                      ...(cf.delay != null ? { animationDelay: `${cf.delay}ms` } : {}),
                      left: timeToPx(view.start, pps),
                      width: capWidthPx,
                      // Plan 11 Task 1（範圍裁決 3c）：窄片選取時把手要溢出，這層不能再裁掉它
                      ...(capOffset !== 0 ? { overflow: 'visible' } : null),
                      // chip 專屬文字階(--accent-text 在加濃底上不足 4.5,見 theme.css)
                      color: 'var(--accent-chip-text)',
                      background: 'var(--accent-chip-bg)', // 實色底(2026-08-16:chip 不透底)
                      // 選取環同 ClipBlock：紅蠟筆的 --select-edge，不是主行動色
                      boxShadow: isSel
                        ? 'inset 0 0 0 1.5px var(--select-edge)'
                        : 'inset 0 0 0 1px var(--accent-edge)',
                    }}
                  >
                    <div
                      className="handle"
                      style={{ left: capOffset }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        onCapDrag(e, c.id, 'in');
                      }}
                    />
                    <div
                      className="handle"
                      style={{ right: capOffset }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        onCapDrag(e, c.id, 'out');
                      }}
                    />
                    {c.text}
                  </div>
                );
              })}
            </div>
            {/* audio 軌（全高青色波形；拖曳平移＋左右緣 trim） */}
            <div
              style={{ ...rowStyle, height: AUDIO_ROW_H }}
              className={aiAnim ? 'ai-anim' : undefined}
              data-tl-blank
            >
              {doc.tracks.audio.map((a) => {
                const d = drag.current;
                const pd = pending.current;
                const shown =
                  d?.mode === 'aud' && d.id === a.id
                    ? {
                        ...a,
                        start: d.preview.start,
                        in: d.preview.in,
                        duration: d.preview.duration,
                      }
                    : pd?.mode === 'aud' && pd.id === a.id
                      ? { ...a, start: pd.start, in: pd.in, duration: pd.duration }
                      : a;
                return (
                  <AudioChip
                    key={a.id}
                    p={doc}
                    a={shown}
                    pps={pps}
                    fx={fxFor(a.id).cls}
                    fxDelay={fxFor(a.id).delay}
                    selected={selected?.kind === 'audio' && selected.id === a.id}
                    onDragStart={onAudDrag}
                  />
                );
              })}
            </div>
            {/* 吸附指示線 */}
            {snapLine !== null && (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: timeToPx(snapLine, pps),
                  width: 1,
                  // 時間軸內的吸附導線＝標記層（跟 playhead 同一支筆），所以吃
                  // --select-edge 而不是主行動色；它的暈 --accent-glow-strong 在暗版
                  // 已是紅蠟筆，線若留在 chalk 會在紅暈裡鑲一道白邊。
                  // ⚠️ 這條與 Player.tsx 畫在**影片上**的 --warn 導線是兩回事，
                  // 那兩條維持琥珀（stage 例外規則）。
                  // paper 下 --select-edge = ink 字面值，與收編前 var(--accent) 同色。
                  background: 'var(--select-edge)',
                  boxShadow: '0 0 6px var(--accent-glow-strong)',
                  pointerEvents: 'none',
                }}
              />
            )}
            <Playhead pps={pps} />
          </div>
        </div>
      </div>
    </div>
  );
}
