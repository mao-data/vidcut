import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from 'react';
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
  shiftStart,
  trimSpanIn,
  trimSpanOut,
  trimAudioIn,
  MIN_CLIP_DURATION,
} from './dragMath.js';
import { ClipBlock, ROW_H } from './ClipBlock.js';
import { AudioChip, AUDIO_ROW_H } from './AudioChip.js';
import { TimelineToolbar } from './Toolbar.js';

const SUB_ROW_H = 24;

/**
 * playhead：紫漸層＋光暈＋圓頭。只有它（和 Toolbar 的 Timecode）訂閱 playback time：
 * time 播放中每幀更新（rAF），若 Timeline 本體訂閱，整條時間軸會每秒重渲染 ~60 次。
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
        background: 'linear-gradient(#a78bfa, #6366f1)',
        borderRadius: 1,
        boxShadow: '0 0 10px rgba(139, 92, 246, 0.7)',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          background: '#a78bfa',
          margin: '-1px 0 0 -3.5px',
          boxShadow: '0 0 8px rgba(139, 92, 246, 0.9)',
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
          start: shiftStart(snapSpan(d.orig.start + deltaSec, d.orig.duration), 0),
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
          start: shiftStart(snapSpan(d.orig.start + deltaSec, d.orig.duration), 0),
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
      d.preview = { absStart: shiftStart(snapSpan(d.orig.absStart + deltaSec, d.orig.span), 0) };
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
          // 錨定式：換算回相對片段起點的 offset（保持跟隨片段）
          const idx = doc.tracks.video.findIndex((c) => c.id === d.orig.anchorClipId);
          const clipStart = idx >= 0 ? clipStartTimes(doc)[idx]! : 0;
          const offset = Number(Math.max(0, d.preview.absStart - clipStart).toFixed(3));
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
          background: 'rgba(0, 0, 0, 0.18)',
          userSelect: 'none',
        }}
      >
        <div
          ref={contentRef}
          style={{ position: 'relative', width, touchAction: 'none' }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
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
                    left: timeToPx(t, pps) + 3,
                    fontSize: 9.5,
                    color: 'var(--text-3)',
                  }}
                >
                  {t}s
                </span>
              );
            })}
          </div>
          {/* video 主軌 */}
          <div style={rowStyle}>
            {trimmedClips.map((c) => {
              const isDragged = moveDrag?.clipId === c.id;
              return (
                <ClipBlock
                  key={c.id}
                  p={doc}
                  clip={c}
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
          <div style={subRow}>
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
              return (
                win && (
                  <div
                    key={o.id}
                    onPointerDown={(e) => onOvDrag(e, o.id)}
                    title={o.anchor ? '錨定於片段（拖曳改 offset，跟著片段走）' : undefined}
                    style={{
                      ...chip,
                      cursor: 'grab',
                      left: timeToPx(win.start, pps),
                      width: timeToPx(win.end - win.start, pps),
                      color: '#6ee7b7',
                      background: 'rgba(52, 211, 153, 0.14)',
                      boxShadow: isSel
                        ? 'inset 0 0 0 1.5px var(--ok)'
                        : 'inset 0 0 0 1px rgba(52, 211, 153, 0.35)',
                    }}
                  >
                    {o.anchor ? '📎 ' : ''}
                    {o.imagePath.split('/').pop()}
                  </div>
                )
              );
            })}
          </div>
          {/* captions 軌（拖曳平移＋左右緣 trim） */}
          <div style={subRow}>
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
              return (
                <div
                  key={c.id}
                  className="clipblk"
                  onPointerDown={(e) => onCapDrag(e, c.id, 'move')}
                  style={{
                    ...chip,
                    cursor: 'grab',
                    left: timeToPx(view.start, pps),
                    width: timeToPx(view.duration, pps),
                    color: '#c4b5fd',
                    background: 'rgba(139, 92, 246, 0.14)',
                    boxShadow: isSel
                      ? 'inset 0 0 0 1.5px var(--accent)'
                      : 'inset 0 0 0 1px rgba(139, 92, 246, 0.35)',
                  }}
                >
                  <div
                    className="handle"
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left: 0,
                      width: 6,
                      cursor: 'ew-resize',
                      zIndex: 2,
                    }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      onCapDrag(e, c.id, 'in');
                    }}
                  />
                  <div
                    className="handle"
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      right: 0,
                      width: 6,
                      cursor: 'ew-resize',
                      zIndex: 2,
                    }}
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
          <div style={{ ...rowStyle, height: AUDIO_ROW_H, borderBottom: 'none' }}>
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
                background: 'var(--accent)',
                boxShadow: '0 0 6px rgba(139, 92, 246, 0.8)',
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
