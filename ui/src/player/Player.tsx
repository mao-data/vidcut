import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { totalDuration, type CaptionItem, type SnapGuide } from '@vidcut/shared';
import { useProject } from '../stores/project.js';
import { usePlayback } from '../stores/playback.js';
import { useSelection } from '../stores/selection.js';
import { mediaUrl, sendCommand } from '../ws.js';
import { useEditFx } from '../stores/editFx.js';
import { useEditDraft } from '../stores/editDraft.js';
import { planAt, overlayView } from './plan.js';
import { syncAction } from './sync.js';
import { CaptionLayer } from './CaptionLayer.js';
import { dragOverlay, dragCaption } from './dragLayer.js';

const DRIFT_TOLERANCE = 0.06; // 60ms
const PRELAUNCH = 0.05; // 邊界前 50ms 啟動 next
/** ducking 時影片原聲的壓低比例——必須與 server/src/render.ts 的 DUCK_LEVEL 同值，預覽才等於成品 */
const DUCK_LEVEL = 0.25;

/**
 * NaN／Infinity 保險絲：送出前擋掉非有限數。
 *
 * 怎麼會有 NaN：stageW 還沒量到時 `scale = 0/1080 = 0`，pointerdown 存下的 `d.scale` 就是 0，
 * `dx / 0` → Infinity，一路算下來 `Number(NaN.toFixed(4))` → NaN。NaN 進 `JSON.stringify`
 * 會變成 **null**，而當時 server 的 `updateOverlay` 不驗數值，`{"x":null}` 會直接寫進專案檔
 * ——之後每次載入都是壞的 position。真瀏覽器要踩到很難（stage 有 aspect-ratio + 版面已定），
 * 但保險絲一行、壞掉的成本是整個專案檔，比例懸殊。擋下來的後果只是「這次拖曳不生效」，
 * 而拖曳本來就是隨手可以再做一次的操作。
 * （命令層後來也補了 `numericError`，所以現在是兩道；這一道仍然留著——在這裡擋下來
 * 是「安靜地不送」，讓它跑到 server 才被拒是使用者眼前彈一句錯誤，體感差很多。）
 */
function finite(...ns: number[]): boolean {
  return ns.every((n) => Number.isFinite(n));
}

/**
 * 讓 `id` 這一項一定出現在渲染清單裡：已經在裡面就原樣回傳（絕大多數情況，零成本），
 * 不在就用 `from` 從 doc 撈回來補在**最後**（畫在最上層——正在拖的東西本來就該在最上面）。
 * 補回來的項目沿用同一個 id 當 React key，所以是「同一個節點繼續存在」，不是重新掛載。
 * 呼叫端與理由見 Player 內 planOverlays/planCaptions 的長註解。
 */
function withDragged<T extends { id: string }>(
  list: T[],
  id: string | null,
  from: (id: string) => T | null,
): T[] {
  if (!id || list.some((x) => x.id === id)) return list;
  const item = from(id);
  return item ? [...list, item] : list;
}

/**
 * 雙 <video> A/B 無縫引擎（spec §7）。active 出聲、spare premount 下一片段並靜音；
 * 邊界前 50ms 靜音啟動 spare，到點交換可見性。rAF + performance.now() 為主時鐘。
 */
export function Player() {
  const doc = useProject((s) => s.doc);
  const time = usePlayback((s) => s.time);
  const playing = usePlayback((s) => s.playing);
  const vA = useRef<HTMLVideoElement>(null);
  const vB = useRef<HTMLVideoElement>(null);
  /** blur 填充模式的背景層（只是背景，容許些許漂移——模糊會蓋掉） */
  const vBg = useRef<HTMLVideoElement>(null);
  const activeIsA = useRef(true);
  const mountedClip = useRef<{ a: string | null; b: string | null }>({ a: null, b: null });
  /** 音訊軌：每個 AudioItem 一個隱藏 <audio>（元素常駐、進出活躍窗才 play/pause） */
  const audioEls = useRef(new Map<string, HTMLAudioElement>());
  const blurFill = doc?.canvas.fit === 'blur';
  /** AI 新增的項目在預覽畫面淡入進場（fx-enter）；播放中自然進出窗不動畫 */
  const fxAdded = useEditFx((s) => s.added);
  const captionCards = useProject((s) => s.captionCards);
  const editDraft = useEditDraft((s) => s.caption);
  // effect 與 render body 共用同一份 plan（播放中每幀都算，別算兩次）
  const plan = useMemo(() => (doc ? planAt(doc, time) : null), [doc, time]);

  /**
   * 疊圖/字幕層的 1080×1920 座標空間縮放係數，量測「影片實際填滿的那個元素」
   * （stage div，objectFit:contain + aspectRatio 9/16 讓 video 精確填滿它）的寬度。
   * 唯一的縮放來源——不得再引入第二條路徑或魔術常數（見任務需求）。
   *
   * ref 用 state（非 useRef）：doc 到位前 `!doc → return null` 不會 render stage div，
   * 若用 useRef+空 deps 的 effect，第一次（也是唯一一次）跑的時候元素還不存在，
   * 之後 doc 抵達、stage 真的掛上 DOM 時就再也不會重新 observe。
   */
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const [stageW, setStageW] = useState(0);
  /**
   * 畫布拖曳（overlay position / 字幕 style.y）：pointerdown 記起點到 ref（不觸發 render）；
   * pointermove 只更新本地覆寫 + 導線（同 Timeline 的拖曳模式：move 不送命令，
   * 一次 mouse-move 一個 command 會灌爆 undo history）；收尾才 sendCommand。
   *
   * 整個手勢掛在 **window** 上（見 beginDrag），不是掛在被拖的那個元素上——
   * 元素可能在手勢進行中被 React 卸載/重掛，掛在它身上的 pointerup 就永遠不會來。
   */
  const dragRef = useRef<{
    kind: 'overlay' | 'caption';
    id: string;
    /** 只認這一根手指/這一顆滑鼠的事件（多點觸控下別被第二根手指的 pointerup 收掉） */
    pointerId: number;
    startX: number;
    startY: number;
    /** 按下當下的縮放係數：bbox 與位移換算共用同一個值，手勢中途版面變寬也不會前後不一致 */
    scale: number;
    startPos: { x: number; y: number };
    bbox: { w: number; h: number };
    /** 最後一次 pointermove 算出的預覽值；null＝按下後沒移動過（純點選，不送命令） */
    last: { position?: { x: number; y: number }; y?: number } | null;
    /** 解除這次手勢掛在 window 上的監聽 */
    detach: () => void;
  } | null>(null);
  const [dragOverride, setDragOverride] = useState<{
    kind: 'overlay' | 'caption';
    id: string;
    position?: { x: number; y: number };
    y?: number;
  } | null>(null);
  const [guides, setGuides] = useState<SnapGuide[]>([]);
  /**
   * 放手後、server echo 抵達前的顯示覆蓋（修「放手閃回原位」，同時修一個比閃回更嚴重的
   * 問題：見下方 overlaysForRender/captionsForRender——渲染跟「下一次拖曳的起點」共用
   * 同一份合併結果，不然「放手後立刻再拖一次」會從 doc 的舊值起算，把第一次的位移吃掉）。
   * 同 Timeline.tsx 的 pending 機制：pointerup 送出命令的同時把結果存進這裡繼續蓋著，
   * 等 doc 真的追上（reconcile 區塊比對相等）才放掉；1.2s 保險絲避免命令被拒/掉包時卡死。
   * 用 useRef（不是 useState）：這個值變了不需要單獨觸發 re-render——寫入的當下一定伴隨
   * dragOverride/guides 的 setState（已經會 re-render），只有「timeout 到期、doc 卻還沒追上」
   * 這條路徑需要額外強制刷新，用下面的 rerender() 手動處理。
   */
  const pendingRef = useRef<
    | { kind: 'overlay'; id: string; position: { x: number; y: number } }
    | { kind: 'caption'; id: string; y: number }
    | null
  >(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, forceRerender] = useState(0);
  const rerender = () => forceRerender((n) => n + 1);
  const setPendingDrag = (v: NonNullable<typeof pendingRef.current>) => {
    pendingRef.current = v;
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = setTimeout(() => {
      pendingRef.current = null;
      rerender();
    }, 1200);
  };
  useEffect(
    () => () => {
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
      // Player 自己被卸載時也要把 window 上的拖曳監聽拆掉，否則洩漏到下一次掛載
      dragRef.current?.detach();
    },
    [],
  );
  // useLayoutEffect（不是 useEffect）：doc 剛到位、stage 第一次掛上 DOM 那一幀，
  // 要在瀏覽器畫出來之前就量到寬並設好 scale，否則第一個畫出的畫面會是 scale(0)
  // （疊圖/字幕全部縮到看不見）閃一下才變回正常大小。
  useLayoutEffect(() => {
    if (!stageEl) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setStageW(w);
    });
    ro.observe(stageEl);
    setStageW(stageEl.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [stageEl]);

  useEffect(() => {
    if (doc) usePlayback.getState().setTotal(totalDuration(doc));
  }, [doc]);

  // 主時鐘：rAF + performance.now() 差分
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      usePlayback.getState().tick(usePlayback.getState().time, (now - last) / 1000);
      last = now;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  /**
   * 音訊軌同步：獨立 effect。
   * 影片那個 effect 在 A/B 交換與「無 active」路徑上會提前 return——音訊軌與影片的
   * A/B 狀態無關，混在一起會讓交換的那一輪整個跳過音訊校正（跨片段邊界 seek 時，
   * 出窗的音訊不會被暫停）。拆開後這個不變量是無條件的。
   */
  useEffect(() => {
    if (!plan) return;
    for (const [id, el] of audioEls.current) {
      const a = plan.audio.find((x) => x.id === id);
      if (!a) {
        if (!el.paused) el.pause();
        continue;
      }
      if (playing) {
        // 播放中絕不因小漂移 seek（seek→重啟延遲→再落後的風暴＝斷續雜音）；
        // 小漂移調 playbackRate 追趕，大跳（拖 playhead）才 seek
        const s = syncAction(a.sourceTime - el.currentTime);
        if (s.kind === 'seek') {
          el.currentTime = a.sourceTime;
          if (el.playbackRate !== 1) el.playbackRate = 1;
        } else if (el.playbackRate !== s.rate) {
          el.playbackRate = s.rate;
        }
      } else if (Math.abs(el.currentTime - a.sourceTime) > DRIFT_TOLERANCE) {
        el.currentTime = a.sourceTime; // 暫停下拖 playhead 要立即到位
      }
      el.volume = Math.min(a.volume, 1);
      if (playing && el.paused) void el.play().catch(() => {});
      if (!playing && !el.paused) el.pause();
    }
  }, [plan, playing]);

  // 每次 time/doc 變化：對齊 video 元素
  useEffect(() => {
    if (!doc || !plan) return;
    const act = activeIsA.current ? vA.current : vB.current;
    const spare = activeIsA.current ? vB.current : vA.current;
    const key = activeIsA.current ? 'a' : 'b';
    const spareKey = activeIsA.current ? 'b' : 'a';
    if (!act || !spare) return;

    if (!plan.active) {
      act.pause();
      spare.pause();
      return;
    }

    // 換 clip：spare 已 premount 同一 clip → 交換；否則硬切
    if (mountedClip.current[key] !== plan.active.clipId) {
      if (mountedClip.current[spareKey] === plan.active.clipId) {
        activeIsA.current = !activeIsA.current;
        act.pause();
        act.muted = true;
        spare.volume = Math.min(plan.active.volume * (plan.ducked ? DUCK_LEVEL : 1), 1);
        spare.muted = plan.active.volume === 0;
        if (playing) void spare.play().catch(() => {});
        return; // 下一輪 effect 以新 active 繼續
      }
      act.src = plan.active.src;
      act.currentTime = plan.active.sourceTime;
      mountedClip.current[key] = plan.active.clipId;
    }

    // 漂移校正：播放中調速追趕（同音訊軌，見上），暫停/定格才允許直接 snap
    if (playing && !plan.active.frozen) {
      const s = syncAction(plan.active.sourceTime - act.currentTime);
      if (s.kind === 'seek') {
        act.currentTime = plan.active.sourceTime;
        if (act.playbackRate !== 1) act.playbackRate = 1;
      } else if (act.playbackRate !== s.rate) {
        act.playbackRate = s.rate;
      }
    } else if (Math.abs(act.currentTime - plan.active.sourceTime) > DRIFT_TOLERANCE) {
      act.currentTime = plan.active.sourceTime;
    }
    if (plan.active.frozen) {
      // 定格幀：停在該格、不出聲，避免反覆 seek
      act.muted = true;
      if (!act.paused) act.pause();
    } else {
      // clip.volume × ducking；HTMLMediaElement volume 上限 1（>1 的增益只在渲染生效）
      act.volume = Math.min(plan.active.volume * (plan.ducked ? DUCK_LEVEL : 1), 1);
      act.muted = plan.active.volume === 0;
      if (playing && act.paused) void act.play().catch(() => {});
      if (!playing && !act.paused) act.pause();
    }

    // premount + 預啟動 next（playbackRate 復位：spare 起播不得帶殘留調速）
    if (plan.next && mountedClip.current[spareKey] !== plan.next.clipId) {
      spare.src = plan.next.src;
      spare.currentTime = plan.next.sourceTime;
      spare.muted = true;
      spare.playbackRate = 1;
      mountedClip.current[spareKey] = plan.next.clipId;
    }
    if (plan.next && playing) {
      const clipEnd = doc.tracks.video
        .slice(0, plan.active.clipIndex + 1)
        .reduce((s, c) => s + c.duration, 0);
      if (clipEnd - time < PRELAUNCH && spare.paused) void spare.play().catch(() => {});
    }

    // blur 背景層：跟著 active 來源，容忍 0.3s 漂移（模糊看不出來）
    const bg = vBg.current;
    if (blurFill && bg) {
      if (!bg.src.endsWith(plan.active.src)) bg.src = plan.active.src;
      if (playing) {
        const s = syncAction(plan.active.sourceTime - bg.currentTime);
        if (s.kind === 'seek') bg.currentTime = plan.active.sourceTime;
        else if (bg.playbackRate !== s.rate) bg.playbackRate = s.rate;
      } else if (Math.abs(bg.currentTime - plan.active.sourceTime) > 0.3) {
        bg.currentTime = plan.active.sourceTime;
      }
      if (playing && bg.paused) void bg.play().catch(() => {});
      if (!playing && !bg.paused) bg.pause();
    }
  }, [doc, plan, time, playing, blurFill]);

  if (!doc || !plan) return null;

  // pending 對帳：doc 已反映我們送出的值 → 覆蓋功成身退（同 Timeline.tsx 的對帳區塊）。
  {
    const pd = pendingRef.current;
    if (pd) {
      const matched =
        pd.kind === 'overlay'
          ? (() => {
              const o = doc.tracks.overlays.find((x) => x.id === pd.id);
              return !o || (o.position.x === pd.position.x && o.position.y === pd.position.y);
            })()
          : (() => {
              const c = doc.tracks.captions.find((x) => x.id === pd.id);
              return !c || c.style.y === pd.y;
            })();
      if (matched) {
        pendingRef.current = null;
        if (pendingTimerRef.current) {
          clearTimeout(pendingTimerRef.current);
          pendingTimerRef.current = null;
        }
      }
    }
  }

  const vidStyle = (visible: boolean): CSSProperties => ({
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    opacity: visible ? 1 : 0,
  });

  /** 1080 座標空間縮放係數——與下方 1080×1920 layer 的 transform 同一個來源，不得重算/硬編。 */
  const scale = stageW / 1080;

  /**
   * 拖曳中的項目**豁免時間窗過濾**：手勢沒結束前，它一定留在畫面上。
   *
   * 不做這件事會出現「盲拖」——`plan.overlays/plan.captions` 是照 playhead 過濾的，播放中
   * 拖曳（一句字幕常常只有 2–3 秒）拖到一半就出窗，項目直接從 plan 消失；dragOverride 是在
   * 這兩個清單的 .map() 裡套的，清單裡沒有它就沒有東西可套，畫面**停住不動**，但 window 上的
   * pointermove 照樣在更新 d.last。實測：y=0.8 往下拖 40px（畫面顯示 0.8208）→ 出窗消失 →
   * 使用者沒有任何回饋卻繼續拖到 +900px → 放手送出 0.9521。他最後看到的是 0.82，文件卻拿到
   * 0.95，1080 空間裡差 250px。附帶症狀：吸附導線還照畫，畫布上飄著幾條沒有主人的黃線。
   *
   * 兩個修法都能讓「送出的＝使用者最後看到的」成立，這裡選**留住元素**而不是**凍結 d.last**：
   *  - 凍結 d.last：元素依舊在眼前消失，之後的拖曳全部無效（手指還按著、畫面卻毫無反應
   *    ——看起來像當掉），放手後位置停在消失前那一刻，跟游標差了 250px；而且要另外處理
   *    導線（元素不見了導線得跟著收），凍結／解凍的判斷還得靠額外的 ref 把「目前 plan 有誰」
   *    傳進掛在 window 上的 handler（那條 closure 是 pointerdown 當下那一次 render 的，
   *    讀不到最新的 plan），為了一個「畫面沒反應」的體驗加一層狀態同步，划不來。
   *  - 留住元素（本作法）：全程看得到自己拖的東西跟著手指跑，放手送出的就是眼前那個位置，
   *    finishDrag 那句「使用者確實看到它移到那裡」的前提才真的成立；導線也自然有主人。
   *    代價是手勢進行中畫面會短暫顯示一個「照時間軸不該出現在這一刻」的項目——但它正是
   *    使用者手指下的那一個，而且放手就恢復正常過濾，比讓它憑空消失更符合直覺。
   *    附帶好處：key 沒變，React 會沿用同一個 DOM 節點，連帶把「出窗卸載」這條最常見的
   *    卸載路徑一起消掉（其餘卸載路徑仍由 window 上的監聽兜底，見 beginDrag）。
   * 項目在拖曳途中被真的刪掉時補不回來（doc 裡也沒有了），畫面消失是正確的，
   * finishDrag 對這種情況本來就不送命令，不會有盲拖後果。
   */
  const dragging = dragRef.current;
  const planOverlays = withDragged(
    plan.overlays,
    dragging?.kind === 'overlay' ? dragging.id : null,
    (id) => {
      const o = doc.tracks.overlays.find((x) => x.id === id);
      return o ? overlayView(o) : null;
    },
  );
  const planCaptions = withDragged(
    plan.captions,
    dragging?.kind === 'caption' ? dragging.id : null,
    (id) => doc.tracks.captions.find((c) => c.id === id) ?? null,
  );

  /**
   * overlay/字幕的「這一幀該顯示什麼」只算一次、渲染與 pointerdown handler 共用同一份——
   * 不要各自查一次 dragOverride/pendingRef（曾經各查各的，兩條路徑一條漏改就會不一致，
   * 見 Task 15 fix round 1 Finding 3）。優先序：拖曳中的本地覆寫 > pending（放手、echo
   * 未到）> doc 原始值。pointerdown 直接讀這裡算出來的值當拖曳起點，於是「放手後立刻
   * 再拖一次」自然以上一次放手的結果為起點，不會把第一次的位移吃掉。
   */
  const overlaysForRender = planOverlays.map((o) => {
    if (dragOverride?.kind === 'overlay' && dragOverride.id === o.id && dragOverride.position) {
      return { ...o, position: { ...o.position, ...dragOverride.position } };
    }
    const pd = pendingRef.current;
    if (pd?.kind === 'overlay' && pd.id === o.id) {
      return { ...o, position: { ...o.position, ...pd.position } };
    }
    return o;
  });
  const captionsForRender = planCaptions.map((c) => {
    if (
      dragOverride?.kind === 'caption' &&
      dragOverride.id === c.id &&
      dragOverride.y !== undefined
    ) {
      return { ...c, style: { ...c.style, y: dragOverride.y } };
    }
    const pd = pendingRef.current;
    if (pd?.kind === 'caption' && pd.id === c.id) {
      return { ...c, style: { ...c.style, y: pd.y } };
    }
    return c;
  });

  const moveDrag = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const delta = { dx: (e.clientX - d.startX) / d.scale, dy: (e.clientY - d.startY) / d.scale };
    if (d.kind === 'overlay') {
      const r = dragOverlay(d.startPos, delta, d.bbox, { w: 1080, h: 1920 });
      d.last = { position: r.position };
      setDragOverride({ kind: 'overlay', id: d.id, position: r.position });
      setGuides(r.guides);
    } else {
      const r = dragCaption(d.startPos.y, delta.dy, d.bbox.h, 1920);
      d.last = { y: r.y };
      setDragOverride({ kind: 'caption', id: d.id, y: r.y });
      setGuides(r.guides);
    }
  };

  /**
   * 手勢收尾：正常放手（pointerup）與異常中止（pointercancel／發現按鍵早就放開了）**共用同一條路**。
   *
   * 異常中止「送出最後預覽到的位置」而不是「回捲成 doc 舊值」，是刻意的選擇：
   *  1. 使用者確實把元素移動過，而且畫布上一路顯示著新位置——回捲等於當著他的面吃掉一次編輯，
   *     而且是在他沒做錯任何事的時候（元素離開時間窗、字卡 hash 換了…都不是他能預期的事件）。
   *     「一路顯示著」不是自我安慰，是被上面 planOverlays/planCaptions 的時間窗豁免撐住的
   *     不變量：手勢期間被拖的項目一定在渲染清單裡，dragOverride 一定套得上去。
   *     （這條不變量若被拿掉，d.last 會在畫面停住之後繼續跑，這裡就變成送出使用者
   *     從沒看過的位置——別為了省一次 find 而破壞它。）
   *  2. 這是有 undo 的編輯器：多送一個命令最壞是按一次 Cmd-Z，少送一個命令則是靜默資料遺失
   *     （使用者以為存了、重新整理才發現沒有——正是本次要修的那個故障的體感）。
   *  3. 異常路徑與正常路徑收斂到同一個文件狀態，只是抵達方式不同，行為好推理也好測。
   * 沒移動過（last === null，例如只是點一下選取）就什麼都不送，不污染 undo history。
   *
   * 不管走哪條路，dragOverride 一定清掉：本地覆寫是唯一可能「永久」卡住的東西
   * （pendingRef 有 1.2s 保險絲，dragOverride 沒有），畫面上會變成一個伺服器從不知道
   * 存在的幻影位置。
   */
  const finishDrag = () => {
    const d = dragRef.current;
    if (!d) return;
    d.detach();
    dragRef.current = null;
    setGuides([]);
    setDragOverride(null);
    // doc 讀當下最新的（不是 render closure 裡那份）：手勢可能跨越好幾次 server echo
    const cur = useProject.getState().doc;
    if (!d.last || !cur) {
      rerender();
      return;
    }
    if (d.kind === 'overlay' && d.last.position) {
      // 項目在拖曳途中被刪掉了就不送（送出去也只會被 server 拒絕）
      const ov = cur.tracks.overlays.find((x) => x.id === d.id);
      if (ov) {
        // 四位小數（1080 空間下約 0.1px 解析度）：pending 對帳與 sendCommand 送出的必須是
        // 同一個數字，不然 doc echo 抵達時浮點尾數對不上，pending 永遠對帳不到，只能靠
        // 1.2s 保險絲清掉（同 Timeline.tsx 對 start/duration 送出前 toFixed(3) 的理由）。
        const position = {
          x: Number(d.last.position.x.toFixed(4)),
          y: Number(d.last.position.y.toFixed(4)),
        };
        if (finite(position.x, position.y)) {
          setPendingDrag({ kind: 'overlay', id: d.id, position });
          sendCommand({
            name: 'updateOverlay',
            id: d.id,
            patch: { position: { ...position, scale: ov.position.scale } },
          });
        }
      }
    } else if (d.kind === 'caption' && d.last.y !== undefined) {
      const cap = cur.tracks.captions.find((c) => c.id === d.id);
      if (cap) {
        const y = Number(d.last.y.toFixed(4));
        if (finite(y)) {
          setPendingDrag({ kind: 'caption', id: d.id, y });
          sendCommand({
            name: 'updateCaption',
            id: d.id,
            patch: { style: { ...cap.style, y } },
          });
        }
      }
    }
    rerender();
  };

  /**
   * 開始一次畫布拖曳。**pointermove/up/cancel 一律掛在 window，不掛在被拖的元素上。**
   *
   * 被拖的元素隨時可能在手勢進行中被 React 卸載或重掛，而且全都是正常使用者做得到的事：
   *  - 播放中拖：plan.captions/plan.overlays 依 playhead 過濾，一句字幕常常只有 2–3 秒，
   *    拖到一半就出窗被卸載；
   *  - 字卡 hash 變（CardCaptionForHash 是 key={hash}，換 hash＝重新掛載）；
   *  - 打字預覽在 ApproxCaption↔CardCaption 之間切換（同 key 不同元件型別＝重新掛載）。
   * 元素一被移除，pointer capture 會被隱式釋放，掛在它身上的 pointerup **永遠不會到達**
   * ——命令不送、本地覆寫卻停在放手時的座標，畫面看起來拖成功了但伺服器毫不知情，重新整理
   * 打回原形。這與 CLAUDE.md「UI 驗證的陷阱」記錄的 `<img draggable>` 是同一種故障，
   * draggable={false} 只堵住其中一個入口。
   *
   * 真 Chromium 實測（capture 中的元素被 remove()，CDP 真實輸入事件）事件序列：
   *   el:pointerdown → el/win:pointermove → [remove] → win:pointermove（target 已重新命中到
   *   <html>）→ win:lostpointercapture（target 是 **document**，不是被移除的元素）→
   *   win:pointermove → win:pointerup。元素上的 pointerup 完全沒有出現。
   * 兩個結論：(a) window 上的 pointermove/pointerup 在元素卸載後照樣送達，是唯一可靠的
   * 追蹤點；(b) lostpointercapture 雖然也到得了 window，但**刻意不拿它當收尾訊號**——
   * 「重新掛載」類的觸發（hash 變、元件型別換）也會發它，但那時使用者其實還在拖一個
   * 看得見的元素，收在那裡等於把手勢攔腰砍斷；改成一路追到 pointerup，重掛對使用者完全透明
   * （覆寫是照 id 套的，不綁 DOM 節點）。真正需要當場收尾的只有 pointercancel（瀏覽器宣告
   * 這根 pointer 不會再有事件了，例如原生 text-drag 搶走手勢）。
   */
  const beginDrag = (
    e: ReactPointerEvent<HTMLElement>,
    d: {
      kind: 'overlay' | 'caption';
      id: string;
      startPos: { x: number; y: number };
      bbox: { w: number; h: number };
    },
  ) => {
    // 上一次手勢沒收乾淨（理論上不會，但第二根手指按下去就會走到這）：先照正常規則收掉它，
    // 不是直接丟棄——丟棄就等於又製造一次「動了但沒送出」的靜默失敗。
    finishDrag();
    const el = e.currentTarget;
    const pointerId = e.pointerId;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      // buttons === 0：按鍵是在我們看不到的地方放開的（例如游標已經移出瀏覽器視窗，
      // capture 又因為元素卸載而失效），pointerup 永遠不會來——當場收尾，別留下覆寫。
      if (ev.buttons === 0) finishDrag();
      else moveDrag(ev);
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      finishDrag();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    dragRef.current = {
      ...d,
      pointerId,
      startX: e.clientX,
      startY: e.clientY,
      scale,
      last: null,
      detach: () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
      },
    };
    // capture 照設（正常情況下讓事件穩定落在這個元素、游標不亂跳），但手勢的正確性
    // 不依賴它——它在元素被卸載的那一刻就會被隱式釋放。
    el.setPointerCapture(pointerId);
  };

  /**
   * 單一穩定 handler（不在 .map() 裡逐項用 inline arrow 包，避免每個 overlay 每次
   * render 都配一個新 closure）：從 data-ov-id 找回是哪個 overlay，讀 overlaysForRender
   * （已經套過 pending）而非 plan.overlays（doc 原始值）。
   */
  const onOverlayPointerDown = (e: ReactPointerEvent<HTMLImageElement>) => {
    const id = e.currentTarget.dataset.ovId;
    const o = overlaysForRender.find((x) => x.id === id);
    if (!o) return;
    useSelection.getState().select({ kind: 'overlay', id: o.id });
    const rect = e.currentTarget.getBoundingClientRect();
    beginDrag(e, {
      kind: 'overlay',
      id: o.id,
      startPos: { x: o.position.x, y: o.position.y },
      bbox: { w: rect.width / scale, h: rect.height / scale },
    });
  };

  /** cap 來自 CaptionLayer 用 captionsForRender 渲染出的項目（已套過 pending），理由同上。 */
  const onCaptionPointerDown = (e: ReactPointerEvent<HTMLDivElement>, cap: CaptionItem) => {
    useSelection.getState().select({ kind: 'caption', id: cap.id });
    const rect = e.currentTarget.getBoundingClientRect();
    beginDrag(e, {
      kind: 'caption',
      id: cap.id,
      startPos: { x: 0, y: cap.style.y },
      bbox: { w: 1080, h: rect.height / scale },
    });
  };

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 0,
      }}
    >
      <div
        ref={setStageEl}
        style={{
          position: 'relative',
          aspectRatio: '9/16',
          // 依「容器」高度縮放，不是視窗高度（用 vh 的話時間軸一高就會撐出捲軸）
          height: '100%',
          maxWidth: '100%',
          background: '#000',
          borderRadius: 10,
          overflow: 'hidden',
          boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px var(--line-strong)',
        }}
      >
        {blurFill && (
          <video
            ref={vBg}
            muted
            playsInline
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              filter: 'blur(24px)',
              transform: 'scale(1.15)',
            }}
          />
        )}
        <video ref={vA} muted playsInline style={vidStyle(activeIsA.current)} />
        <video ref={vB} muted playsInline style={vidStyle(!activeIsA.current)} />
        {/* 音訊軌元素（不可見；常駐讓 seek/play 不用重新載檔） */}
        {doc.tracks.audio.map((a) => {
          const media = doc.media.find((m) => m.id === a.mediaId);
          return media ? (
            <audio
              key={a.id}
              ref={(el) => {
                if (el) audioEls.current.set(a.id, el);
                else audioEls.current.delete(a.id);
              }}
              src={mediaUrl(media)}
              preload="auto"
            />
          ) : null;
        })}
        {/*
          1080×1920 座標空間：與匯出畫布同尺寸，用量測到的 stage 寬縮放——
          縮放係數只有這一處來源，不得再有第二條路徑或魔術常數（fontSize/3 已廢除）。
        */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: 1080,
            height: 1920,
            transformOrigin: 'top left',
            transform: `scale(${scale})`,
            pointerEvents: 'none',
          }}
        >
          {overlaysForRender.map((o) => {
            return (
              <img
                key={o.id}
                data-ov-id={o.id}
                src={o.src}
                className={fxAdded.has(o.id) ? 'fx-enter' : undefined}
                alt=""
                // <img> 預設瀏覽器原生可拖曳（HTML5 drag-and-drop）——按下後只要一移動,
                // 原生拖曳手勢就會搶走這個手勢:dragstart 觸發、隨即 pointercancel,
                // 我們的 pointerup 永遠不會到達,onDragPointerUp 不會跑,sendCommand
                // 永遠不會送出。畫面上看起來拖曳「成功」了（本地覆蓋卡在放開時的座標
                // 不會消失),但伺服器端座標從未更新——使用者以為存了,其實沒有,重新整理
                // 就會打回原形。draggable={false} 關掉原生手勢,讓 pointer 事件序列完整跑完。
                draggable={false}
                // 只掛 pointerdown：move/up/cancel 都掛在 window（見 beginDrag 的長註解），
                // 因為這個 <img> 隨時可能在手勢中途離開時間窗被卸載，它身上的 pointerup
                // 到那時就永遠不會來了。
                onPointerDown={onOverlayPointerDown}
                style={{
                  position: 'absolute',
                  left: 1080 * o.position.x,
                  top: 1920 * o.position.y,
                  // translate(-50%,0) + transformOrigin 'top center'：x 錨＝水平中心、
                  // y 錨＝上緣，縮放繞著「上緣中點」做——與 render.ts 的
                  // `overlay=x=(W*x)-(w/2):y=(H*y)`（w 是縮放後的寬）同一組語意。
                  transform: `translate(-50%, 0) scale(${o.position.scale})`,
                  transformOrigin: 'top center',
                  // ⚠️ 這裡曾經有一行 `maxWidth: 1080 * 0.9`，讓預覽的圖被夾到 972px，
                  // 而 render.ts 是以原生尺寸合成——文字卡一律是畫布全寬（1080），
                  // 所以「成品比預覽大 1/0.9 ≈ 11%」每次都中。夾制沒有任何渲染端的對應物，
                  // 也沒有記載過的用途，原生尺寸才是正確的預覽（2026-08-04 移除）。
                  pointerEvents: 'auto',
                  cursor: 'grab',
                  touchAction: 'none',
                }}
              />
            );
          })}
          <CaptionLayer
            captions={captionsForRender}
            cards={captionCards}
            time={time}
            added={fxAdded}
            draft={editDraft}
            onCaptionPointerDown={onCaptionPointerDown}
          />
          {/* 吸附導線：命中時才畫，畫在同一 1080 座標空間內（已被外層 scale 換算成畫面 px） */}
          {guides.map((g, i) =>
            g.axis === 'x' ? (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: g.pos,
                  top: 0,
                  width: 2,
                  height: 1920,
                  background: 'var(--warn, #eab308)',
                  pointerEvents: 'none',
                }}
              />
            ) : (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  top: g.pos,
                  left: 0,
                  height: 2,
                  width: 1080,
                  background: 'var(--warn, #eab308)',
                  pointerEvents: 'none',
                }}
              />
            ),
          )}
        </div>
      </div>
    </div>
  );
}
