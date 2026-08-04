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
import { planAt } from './plan.js';
import { syncAction } from './sync.js';
import { CaptionLayer } from './CaptionLayer.js';
import { dragOverlay, dragCaption } from './dragLayer.js';

const DRIFT_TOLERANCE = 0.06; // 60ms
const PRELAUNCH = 0.05; // 邊界前 50ms 啟動 next
/** ducking 時影片原聲的壓低比例——必須與 server/src/render.ts 的 DUCK_LEVEL 同值，預覽才等於成品 */
const DUCK_LEVEL = 0.25;

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
   * 一次 mouse-move 一個 command 會灌爆 undo history）；pointerup 才 sendCommand。
   */
  const dragRef = useRef<{
    kind: 'overlay' | 'caption';
    id: string;
    startX: number;
    startY: number;
    startPos: { x: number; y: number };
    bbox: { w: number; h: number };
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
   * overlay/字幕的「這一幀該顯示什麼」只算一次、渲染與 pointerdown handler 共用同一份——
   * 不要各自查一次 dragOverride/pendingRef（曾經各查各的，兩條路徑一條漏改就會不一致，
   * 見 Task 15 fix round 1 Finding 3）。優先序：拖曳中的本地覆寫 > pending（放手、echo
   * 未到）> doc 原始值。pointerdown 直接讀這裡算出來的值當拖曳起點，於是「放手後立刻
   * 再拖一次」自然以上一次放手的結果為起點，不會把第一次的位移吃掉。
   */
  const overlaysForRender = plan.overlays.map((o) => {
    if (dragOverride?.kind === 'overlay' && dragOverride.id === o.id && dragOverride.position) {
      return { ...o, position: { ...o.position, ...dragOverride.position } };
    }
    const pd = pendingRef.current;
    if (pd?.kind === 'overlay' && pd.id === o.id) {
      return { ...o, position: { ...o.position, ...pd.position } };
    }
    return o;
  });
  const captionsForRender = plan.captions.map((c) => {
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
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = {
      kind: 'overlay',
      id: o.id,
      startX: e.clientX,
      startY: e.clientY,
      startPos: { x: o.position.x, y: o.position.y },
      bbox: { w: rect.width / scale, h: rect.height / scale },
    };
  };

  /** cap 來自 CaptionLayer 用 captionsForRender 渲染出的項目（已套過 pending），理由同上。 */
  const onCaptionPointerDown = (e: ReactPointerEvent<HTMLDivElement>, cap: CaptionItem) => {
    useSelection.getState().select({ kind: 'caption', id: cap.id });
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = {
      kind: 'caption',
      id: cap.id,
      startX: e.clientX,
      startY: e.clientY,
      startPos: { x: 0, y: cap.style.y },
      bbox: { w: 1080, h: rect.height / scale },
    };
  };

  const onDragPointerMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const delta = { dx: (e.clientX - d.startX) / scale, dy: (e.clientY - d.startY) / scale };
    if (d.kind === 'overlay') {
      const r = dragOverlay(d.startPos, delta, d.bbox, { w: 1080, h: 1920 });
      setDragOverride({ kind: 'overlay', id: d.id, position: r.position });
      setGuides(r.guides);
    } else {
      const r = dragCaption(d.startPos.y, delta.dy, d.bbox.h, 1920);
      setDragOverride({ kind: 'caption', id: d.id, y: r.y });
      setGuides(r.guides);
    }
  };

  const onDragPointerUp = () => {
    const d = dragRef.current;
    const o = dragOverride;
    dragRef.current = null;
    setGuides([]);
    setDragOverride(null);
    if (!d || !o) return;
    if (d.kind === 'overlay' && o.position) {
      const scale0 = doc.tracks.overlays.find((x) => x.id === d.id)?.position.scale ?? 1;
      // 四位小數（1080 空間下約 0.1px 解析度）：pending 對帳與 sendCommand 送出的必須是
      // 同一個數字，不然 doc echo 抵達時浮點尾數對不上，pending 永遠對帳不到，只能靠
      // 1.2s 保險絲清掉（同 Timeline.tsx 對 start/duration 送出前 toFixed(3) 的理由）。
      const position = { x: Number(o.position.x.toFixed(4)), y: Number(o.position.y.toFixed(4)) };
      setPendingDrag({ kind: 'overlay', id: d.id, position });
      sendCommand({
        name: 'updateOverlay',
        id: d.id,
        patch: { position: { ...position, scale: scale0 } },
      });
    } else if (d.kind === 'caption' && o.y !== undefined) {
      const cap = doc.tracks.captions.find((c) => c.id === d.id);
      if (cap) {
        const y = Number(o.y.toFixed(4));
        setPendingDrag({ kind: 'caption', id: d.id, y });
        sendCommand({
          name: 'updateCaption',
          id: d.id,
          patch: { style: { ...cap.style, y } },
        });
      }
    }
    rerender();
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
                onPointerDown={onOverlayPointerDown}
                onPointerMove={onDragPointerMove}
                onPointerUp={onDragPointerUp}
                style={{
                  position: 'absolute',
                  left: 1080 * o.position.x,
                  top: 1920 * o.position.y,
                  transform: `translate(-50%, 0) scale(${o.position.scale})`,
                  transformOrigin: 'top center',
                  maxWidth: 1080 * 0.9,
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
            onCaptionPointerMove={onDragPointerMove}
            onCaptionPointerUp={onDragPointerUp}
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
