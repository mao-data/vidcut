import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type WheelEvent,
} from 'react';
import {
  clipStartTimes,
  overlayWindow,
  totalDuration,
  type Project,
  type VideoClip,
} from '@vidcut/shared';
import { useProject } from '../stores/project.js';
import { usePlayback } from '../stores/playback.js';
import { useSelection } from '../stores/selection.js';
import { useView } from '../stores/view.js';
import { sendCommand } from '../ws.js';
import { pxToTime, snapTime, timeToPx } from './scale.js';
import { trimIn, trimOut, reorderByDrag, MIN_CLIP_DURATION } from './dragMath.js';

const ROW_H = 56;
const SUB_ROW_H = 24;

interface Peaks {
  samplesPerBucket: number;
  sampleRate: number;
  peaks: number[];
}
const peaksCache = new Map<string, Peaks>();

type DragState =
  | { mode: 'trim-in' | 'trim-out'; clipId: string; startX: number; preview: VideoClip }
  | { mode: 'move'; clipId: string; startX: number; pointerX: number }
  | null;

function useWaveform(peaksPath: string | undefined): Peaks | null {
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  useEffect(() => {
    if (!peaksPath) return;
    const url = `/media/${peaksPath}`;
    const cached = peaksCache.get(url);
    if (cached) {
      setPeaks(cached);
      return;
    }
    void fetch(url)
      .then((r) => r.json())
      .then((j: Peaks) => {
        peaksCache.set(url, j);
        setPeaks(j);
      })
      .catch(() => {});
  }, [peaksPath]);
  return peaks;
}

function ClipBlock({
  p,
  clip,
  start,
  pps,
  selected,
  onTrimStart,
  onMoveStart,
  onSelect,
}: {
  p: Project;
  clip: VideoClip;
  start: number;
  pps: number;
  selected: boolean;
  onTrimStart: (e: PointerEvent, clip: VideoClip, edge: 'in' | 'out') => void;
  onMoveStart: (e: PointerEvent, clip: VideoClip) => void;
  onSelect: (id: string) => void;
}) {
  const media = p.media.find((m) => m.id === clip.mediaId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaks = useWaveform(clip.frozen ? undefined : media?.peaksPath);
  const w = timeToPx(clip.duration, pps);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !peaks) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = 'rgba(120,200,120,0.7)';
    const bucketsPerSec = peaks.sampleRate / peaks.samplesPerBucket;
    const from = Math.floor(clip.in * bucketsPerSec);
    const count = Math.max(1, Math.floor(clip.duration * bucketsPerSec));
    for (let x = 0; x < cv.width; x++) {
      const v = peaks.peaks[from + Math.floor((x / cv.width) * count)] ?? 0;
      const h = v * cv.height;
      ctx.fillRect(x, cv.height - h, 1, h);
    }
  }, [peaks, clip.in, clip.duration, w]);

  const filmstrip = media?.filmstripPath ? `/media/${media.filmstripPath}` : undefined;
  const frameW = media ? (80 * media.probe.width) / media.probe.height : 45;
  const bgOffset = -(clip.in * frameW);
  const handle: CSSProperties = {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 8,
    cursor: 'ew-resize',
    background: 'rgba(255,255,255,0.35)',
    zIndex: 2,
  };
  return (
    <div
      onPointerDown={(e) => {
        onSelect(clip.id);
        onMoveStart(e, clip);
      }}
      title={`${clip.label ?? clip.id}  in=${clip.in.toFixed(2)}s dur=${clip.duration.toFixed(2)}s${
        clip.frozen ? ' (定格)' : ''
      }`}
      style={{
        position: 'absolute',
        left: timeToPx(start, pps),
        width: w,
        height: ROW_H,
        border: selected ? '2px solid #4af' : '1px solid #555',
        borderRadius: 4,
        overflow: 'hidden',
        cursor: 'grab',
        backgroundImage: clip.frozen || !filmstrip ? undefined : `url(${filmstrip})`,
        backgroundPosition: `${bgOffset}px 0`,
        backgroundSize: 'auto 100%',
        backgroundRepeat: 'repeat-x',
        backgroundColor: clip.frozen ? '#3a4a5a' : '#333',
      }}
    >
      <div
        style={{ ...handle, left: 0 }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onSelect(clip.id);
          onTrimStart(e, clip, 'in');
        }}
      />
      <div
        style={{ ...handle, right: 0 }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onSelect(clip.id);
          onTrimStart(e, clip, 'out');
        }}
      />
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: 10,
          fontSize: 11,
          textShadow: '0 0 3px #000',
          pointerEvents: 'none',
        }}
      >
        {clip.frozen ? '❄ ' : ''}
        {clip.label ?? clip.id}
      </span>
      {!clip.frozen && (
        <canvas
          ref={canvasRef}
          width={Math.max(1, Math.floor(w))}
          height={16}
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            width: '100%',
            height: 16,
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
}

export function Timeline() {
  const doc = useProject((s) => s.doc);
  const time = usePlayback((s) => s.time);
  const selected = useSelection((s) => s.selected);
  const pps = useView((s) => s.pxPerSecond);
  const snapEnabled = useView((s) => s.snapEnabled);
  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRef<DragState>(null);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);

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
  const total = totalDuration(doc);
  const starts = clipStartTimes(doc);
  const width = Math.max(timeToPx(total, pps) + 120, 600);

  const layout = doc.tracks.video.map((c, i) => ({
    id: c.id,
    left: timeToPx(starts[i]!, pps),
    width: timeToPx(c.duration, pps),
  }));

  /** 吸附候選：片段邊界、片尾、playhead、整秒 */
  const snapCandidates = (): number[] => {
    const cands = [...starts, total, time];
    for (let s = 0; s <= Math.ceil(total); s++) cands.push(s);
    return cands;
  };
  const maybeSnap = (t: number): number => (snapEnabled ? snapTime(t, snapCandidates(), pps) : t);

  const onSelect = (id: string) => useSelection.getState().select({ kind: 'clip', id });

  const onTrimStart = (e: PointerEvent, clip: VideoClip, edge: 'in' | 'out') => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      mode: edge === 'in' ? 'trim-in' : 'trim-out',
      clipId: clip.id,
      startX: e.clientX,
      preview: { ...clip },
    };
  };

  const onMoveStart = (e: PointerEvent, clip: VideoClip) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode: 'move', clipId: clip.id, startX: e.clientX, pointerX: e.clientX };
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
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setSnapLine(null);
    if (!d) return;
    if (d.mode === 'trim-in' || d.mode === 'trim-out') {
      sendCommand({
        name: 'updateClip',
        clipId: d.clipId,
        patch: {
          in: Number(d.preview.in.toFixed(3)),
          duration: Number(d.preview.duration.toFixed(3)),
        },
      });
    } else if (d.mode === 'move') {
      const contentRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const pointerXInContent = d.pointerX - contentRect.left;
      const order = reorderByDrag(
        doc.tracks.video.map((c) => c.id),
        d.clipId,
        pointerXInContent,
        layout,
      );
      const changed = order.some((id, i) => id !== doc.tracks.video[i]!.id);
      if (changed) sendCommand({ name: 'reorderClips', order });
    }
    rerender();
  };

  const onRulerClick = (e: MouseEvent<HTMLDivElement>) => {
    if (drag.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    usePlayback.getState().seek(maybeSnap(pxToTime(e.clientX - rect.left, pps)));
  };

  // 拖曳 trim 中：用 preview 覆蓋顯示的 clip
  const displayClips = doc.tracks.video.map((c) => {
    const d = drag.current;
    if (d && (d.mode === 'trim-in' || d.mode === 'trim-out') && d.clipId === c.id) return d.preview;
    return c;
  });
  const displayStarts = clipStartTimes({ ...doc, tracks: { ...doc.tracks, video: displayClips } });

  // 尺規刻度密度隨縮放調整
  const tickStep = pps >= 120 ? 0.5 : pps >= 40 ? 1 : pps >= 15 ? 5 : 10;
  const tickCount = Math.floor(total / tickStep) + 1;

  const rowStyle: CSSProperties = {
    position: 'relative',
    height: ROW_H,
    borderBottom: '1px solid #222',
  };
  const subRow: CSSProperties = { ...rowStyle, height: SUB_ROW_H };
  const chip: CSSProperties = {
    position: 'absolute',
    height: SUB_ROW_H - 4,
    borderRadius: 3,
    fontSize: 10,
    paddingLeft: 4,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  };

  return (
    <div>
      {/* 工具列：縮放 / 吸附 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '2px 4px',
          fontSize: 11,
          color: '#aaa',
        }}
      >
        <button onClick={() => useView.getState().zoomBy(1 / 1.4)} title="縮小 (Ctrl+-)">
          −
        </button>
        <button onClick={() => useView.getState().zoomBy(1.4)} title="放大 (Ctrl++)">
          ＋
        </button>
        <button
          onClick={() => {
            const el = scrollRef.current;
            if (el) useView.getState().fit(total, el.clientWidth);
          }}
          title="整條塞進畫面 (Shift+Z)"
        >
          ⤢ Fit
        </button>
        <button
          onClick={() => useView.getState().toggleSnap()}
          title="吸附開關 (N)"
          style={{ color: snapEnabled ? '#6f6' : '#888' }}
        >
          🧲 {snapEnabled ? '吸附開' : '吸附關'}
        </button>
        <span style={{ marginLeft: 'auto', opacity: 0.6 }}>
          {pps.toFixed(0)} px/s · {total.toFixed(2)}s
        </span>
      </div>

      <div
        ref={scrollRef}
        style={{ overflowX: 'auto', border: '1px solid #333', userSelect: 'none' }}
      >
        <div
          style={{ position: 'relative', width, touchAction: 'none' }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {/* 尺規 */}
          <div
            style={{
              position: 'relative',
              height: 20,
              borderBottom: '1px solid #444',
              cursor: 'text',
            }}
            onClick={onRulerClick}
          >
            {Array.from({ length: tickCount }, (_, i) => {
              const t = i * tickStep;
              return (
                <span
                  key={t}
                  style={{
                    position: 'absolute',
                    left: timeToPx(t, pps),
                    fontSize: 10,
                    color: '#888',
                  }}
                >
                  {t}s
                </span>
              );
            })}
          </div>
          {/* video 主軌 */}
          <div style={rowStyle}>
            {displayClips.map((c, i) => (
              <ClipBlock
                key={c.id}
                p={doc}
                clip={c}
                start={displayStarts[i]!}
                pps={pps}
                selected={selected?.kind === 'clip' && selected.id === c.id}
                onTrimStart={onTrimStart}
                onMoveStart={onMoveStart}
                onSelect={onSelect}
              />
            ))}
          </div>
          {/* overlays 軌 */}
          <div style={subRow}>
            {doc.tracks.overlays.map((o) => {
              const win = overlayWindow(doc, o);
              return (
                win && (
                  <div
                    key={o.id}
                    onPointerDown={() =>
                      useSelection.getState().select({ kind: 'overlay', id: o.id })
                    }
                    style={{
                      ...chip,
                      left: timeToPx(win.start, pps),
                      width: timeToPx(win.end - win.start, pps),
                      background:
                        selected?.kind === 'overlay' && selected.id === o.id ? '#7c6' : '#5a4',
                    }}
                  >
                    {o.imagePath.split('/').pop()}
                  </div>
                )
              );
            })}
          </div>
          {/* captions 軌 */}
          <div style={subRow}>
            {doc.tracks.captions.map((c) => (
              <div
                key={c.id}
                onPointerDown={() => useSelection.getState().select({ kind: 'caption', id: c.id })}
                style={{
                  ...chip,
                  left: timeToPx(c.start, pps),
                  width: timeToPx(c.duration, pps),
                  background:
                    selected?.kind === 'caption' && selected.id === c.id ? '#68c' : '#46a',
                }}
              >
                {c.text}
              </div>
            ))}
          </div>
          {/* audio 軌 */}
          <div style={subRow}>
            {doc.tracks.audio.map((a) => (
              <div
                key={a.id}
                onPointerDown={() => useSelection.getState().select({ kind: 'audio', id: a.id })}
                title={`${a.label ?? a.mediaId} vol=${a.volume}${a.ducking ? ' (ducking)' : ''}`}
                style={{
                  ...chip,
                  left: timeToPx(a.start, pps),
                  width: timeToPx(a.duration, pps),
                  background: selected?.kind === 'audio' && selected.id === a.id ? '#d86' : '#a64',
                }}
              >
                {a.ducking ? '🔉 ' : ''}
                {a.label ?? a.mediaId}
              </div>
            ))}
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
                background: '#ff0',
                pointerEvents: 'none',
              }}
            />
          )}
          {/* playhead */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: timeToPx(time, pps),
              width: 2,
              background: 'red',
              pointerEvents: 'none',
            }}
          />
        </div>
      </div>
    </div>
  );
}
