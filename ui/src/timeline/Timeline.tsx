import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { Paperclip } from 'lucide-react';
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
import { pxToTime, snapTime, timeToPx } from './scale.js';
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
import { AudioChip, AUDIO_ROW_H } from './AudioChip.js';
import { TimelineToolbar } from './Toolbar.js';
import { useEditFx } from '../stores/editFx.js';
import { scrollTargetFor } from '../fx/scroll.js';
import { gsap, motionOK } from '../motion.js';

const SUB_ROW_H = 30; // 2026-08-16 使用者定案:其他軌統一 30(主軌 60 的一半)

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
      id: string;
      startX: number;
      /** 拖曳期間以絕對時間顯示；錨定式放手時換算回 offset */
      orig: { absStart: number; span: number | null; anchorClipId?: string };
      preview: { absStart: number };
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
        match: { kind: 'start'; v: number } | { kind: 'offset'; clipId: string; v: number };
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

  // Ctrl/⌘+滾輪：以游標位置為錨點縮放
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cursorPx = e.clientX - rect.left + el.scrollLeft;
      const cursorTime = pxToTime(cursorPx, useView.getState().pxPerSecond);
      useView.getState().zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
      // 縮放後把同一時間點拉回游標下
      const newPx = timeToPx(cursorTime, useView.getState().pxPerSecond);
      el.scrollLeft = newPx - (e.clientX - rect.left);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // 供 Shift+Z（fit）取容器寬度
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !doc) return;
    (window as unknown as { __vidcutFit?: () => void }).__vidcutFit = () =>
      useView.getState().fit(totalDuration(doc), el.clientWidth);
  }, [doc]);

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
      el.clientWidth,
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
            return pd.match.kind === 'start'
              ? o.start === pd.match.v
              : o.anchor?.clipId === pd.match.clipId && o.anchor?.offset === pd.match.v;
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

  const onOvDrag = (e: PointerEvent, id: string) => {
    const o = doc.tracks.overlays.find((x) => x.id === id);
    const win = o && overlayWindow(doc, o);
    if (!o || !win) return;
    capture(e);
    useSelection.getState().select({ kind: 'overlay', id });
    drag.current = {
      mode: 'ov',
      id,
      startX: e.clientX,
      orig: {
        absStart: win.start,
        span: o.duration === null ? null : win.end - win.start,
        ...(o.anchor ? { anchorClipId: o.anchor.clipId } : {}),
      },
      preview: { absStart: win.start },
    };
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
      d.preview = { absStart: clampStart(snapSpan(d.orig.absStart + deltaSec, d.orig.span)) };
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
            match: { kind: 'start', v: start },
          });
          sendCommand({ name: 'updateOverlay', id: d.id, patch: { start } });
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

  // 尺規刻度密度隨縮放調整
  const tickStep = pps >= 120 ? 0.5 : pps >= 40 ? 1 : pps >= 15 ? 5 : 10;
  const tickCount = Math.floor(total / tickStep) + 1;

  const rowStyle: CSSProperties = {
    position: 'relative',
    height: ROW_H,
    borderBottom: '1px solid var(--line)',
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

  return (
    <div>
      <TimelineToolbar
        total={total}
        onFit={() => {
          const el = scrollRef.current;
          if (el) useView.getState().fit(total, el.clientWidth);
        }}
      />

      <div
        ref={scrollRef}
        style={{
          overflowX: 'auto',
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-panel)',
          background: 'var(--timeline-well-bg)',
          userSelect: 'none',
        }}
      >
        <div
          ref={contentRef}
          style={{ position: 'relative', width, touchAction: 'none' }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          // 空白處點擊＝取消選取。標記與白名單邏輯見 `onBlankClick` 的註解。
          onClick={onBlankClick}
          data-tl-blank
        >
          {/* 尺規 */}
          <div
            style={{
              position: 'relative',
              height: 20,
              borderBottom: '1px solid var(--line-strong)',
              cursor: 'text',
            }}
            onClick={onRulerClick}
          >
            {Array.from({ length: tickCount }, (_, i) => {
              const t = i * tickStep;
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
                  {t}s
                </span>
              );
            })}
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
                />
              );
            })}
          </div>
          {/* overlays 軌（拖曳平移；錨定式改 offset） */}
          <div style={subRow} className={aiAnim ? 'ai-anim' : undefined} data-tl-blank>
            {doc.tracks.overlays.map((o) => {
              let win = overlayWindow(doc, o);
              const d = drag.current;
              const pd = pending.current;
              if (win && d?.mode === 'ov' && d.id === o.id) {
                const span = d.orig.span;
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
              return (
                win && (
                  <div
                    key={o.id}
                    className={of.cls.trim() || undefined}
                    onPointerDown={(e) => onOvDrag(e, o.id)}
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
                      width: timeToPx(win.end - win.start, pps),
                      color: 'var(--ok-text)',
                      background: 'var(--ok-wash)',
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
              return (
                <div
                  key={c.id}
                  className={'clipblk' + cf.cls}
                  onPointerDown={(e) => onCapDrag(e, c.id, 'move')}
                  style={{
                    ...chip,
                    cursor: 'grab',
                    ...(cf.delay != null ? { animationDelay: `${cf.delay}ms` } : {}),
                    left: timeToPx(view.start, pps),
                    width: timeToPx(view.duration, pps),
                    color: 'var(--accent-text)',
                    background: 'var(--accent-wash)',
                    // 選取環同 ClipBlock：紅蠟筆的 --select-edge，不是主行動色
                    boxShadow: isSel
                      ? 'inset 0 0 0 1.5px var(--select-edge)'
                      : 'inset 0 0 0 1px var(--accent-edge)',
                  }}
                >
                  <div
                    className="handle"
                    style={{ left: 0 }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      onCapDrag(e, c.id, 'in');
                    }}
                  />
                  <div
                    className="handle"
                    style={{ right: 0 }}
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
            style={{ ...rowStyle, height: AUDIO_ROW_H, borderBottom: 'none' }}
            className={aiAnim ? 'ai-anim' : undefined}
            data-tl-blank
          >
            {doc.tracks.audio.map((a) => {
              const d = drag.current;
              const pd = pending.current;
              const shown =
                d?.mode === 'aud' && d.id === a.id
                  ? { ...a, start: d.preview.start, in: d.preview.in, duration: d.preview.duration }
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
  );
}
