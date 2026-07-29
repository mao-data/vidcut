import {
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
  type Project,
  type VideoClip,
} from '@vidcut/shared';
import { useProject } from '../stores/project.js';
import { usePlayback } from '../stores/playback.js';
import { useSelection } from '../stores/selection.js';
import { sendCommand } from '../ws.js';
import { PX_PER_SECOND, pxToTime, timeToPx } from './scale.js';
import { trimIn, trimOut, reorderByDrag } from './dragMath.js';

const ROW_H = 56;

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
  selected,
  onTrimStart,
  onMoveStart,
  onSelect,
}: {
  p: Project;
  clip: VideoClip;
  start: number;
  selected: boolean;
  onTrimStart: (e: PointerEvent, clip: VideoClip, edge: 'in' | 'out') => void;
  onMoveStart: (e: PointerEvent, clip: VideoClip) => void;
  onSelect: (id: string) => void;
}) {
  const media = p.media.find((m) => m.id === clip.mediaId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaks = useWaveform(media?.peaksPath);
  const w = timeToPx(clip.duration);

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
  }, [peaks, clip.in, clip.duration]);

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
      title={`${clip.label ?? clip.id}  in=${clip.in.toFixed(2)}s dur=${clip.duration.toFixed(2)}s`}
      style={{
        position: 'absolute',
        left: timeToPx(start),
        width: w,
        height: ROW_H,
        border: selected ? '2px solid #4af' : '1px solid #555',
        borderRadius: 4,
        overflow: 'hidden',
        cursor: 'grab',
        backgroundImage: filmstrip ? `url(${filmstrip})` : undefined,
        backgroundPosition: `${bgOffset}px 0`,
        backgroundSize: 'auto 100%',
        backgroundRepeat: 'repeat-x',
        backgroundColor: '#333',
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
        {clip.label ?? clip.id}
      </span>
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
    </div>
  );
}

export function Timeline() {
  const doc = useProject((s) => s.doc);
  const time = usePlayback((s) => s.time);
  const selected = useSelection((s) => s.selected);
  const drag = useRef<DragState>(null);
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);

  if (!doc) return null;
  const total = totalDuration(doc);
  const starts = clipStartTimes(doc);
  const width = Math.max(timeToPx(total) + 120, 600);

  const layout = doc.tracks.video.map((c, i) => ({
    id: c.id,
    left: timeToPx(starts[i]!),
    width: timeToPx(c.duration),
  }));

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
    const deltaSec = pxToTime(e.clientX - d.startX);
    if (d.mode === 'trim-in' || d.mode === 'trim-out') {
      const clip = doc.tracks.video.find((c) => c.id === d.clipId);
      if (!clip) return;
      const media = doc.media.find((m) => m.id === clip.mediaId);
      const mediaDur = media?.probe.duration ?? Infinity;
      d.preview =
        d.mode === 'trim-in'
          ? { ...clip, ...trimIn(clip, deltaSec) }
          : { ...clip, ...trimOut(clip, deltaSec, mediaDur) };
      rerender();
    } else if (d.mode === 'move') {
      d.pointerX = e.clientX;
      rerender();
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode === 'trim-in' || d.mode === 'trim-out') {
      sendCommand({
        name: 'updateClip',
        clipId: d.clipId,
        patch: { in: d.preview.in, duration: d.preview.duration },
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
    usePlayback.getState().seek(pxToTime(e.clientX - rect.left));
  };

  // 拖曳 trim 中：用 preview 覆蓋顯示的 clip
  const displayClips = doc.tracks.video.map((c) => {
    const d = drag.current;
    if (d && (d.mode === 'trim-in' || d.mode === 'trim-out') && d.clipId === c.id) return d.preview;
    return c;
  });
  const displayStarts = clipStartTimes({ ...doc, tracks: { ...doc.tracks, video: displayClips } });

  const rowStyle: CSSProperties = {
    position: 'relative',
    height: ROW_H,
    borderBottom: '1px solid #222',
  };
  return (
    <div style={{ overflowX: 'auto', border: '1px solid #333', userSelect: 'none' }}>
      <div
        style={{ position: 'relative', width, touchAction: 'none' }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div
          style={{ position: 'relative', height: 20, borderBottom: '1px solid #444', cursor: 'text' }}
          onClick={onRulerClick}
        >
          {Array.from({ length: Math.ceil(total) + 1 }, (_, s) => (
            <span
              key={s}
              style={{ position: 'absolute', left: timeToPx(s), fontSize: 10, color: '#888' }}
            >
              {s}s
            </span>
          ))}
        </div>
        {/* video 主軌 */}
        <div style={rowStyle}>
          {displayClips.map((c, i) => (
            <ClipBlock
              key={c.id}
              p={doc}
              clip={c}
              start={displayStarts[i]!}
              selected={selected?.kind === 'clip' && selected.id === c.id}
              onTrimStart={onTrimStart}
              onMoveStart={onMoveStart}
              onSelect={onSelect}
            />
          ))}
        </div>
        {/* overlays 軌 */}
        <div style={{ ...rowStyle, height: 24 }}>
          {doc.tracks.overlays.map((o) => {
            const win = overlayWindow(doc, o);
            return (
              win && (
                <div
                  key={o.id}
                  onPointerDown={() => useSelection.getState().select({ kind: 'overlay', id: o.id })}
                  style={{
                    position: 'absolute',
                    left: timeToPx(win.start),
                    width: timeToPx(win.end - win.start),
                    height: 20,
                    background: selected?.kind === 'overlay' && selected.id === o.id ? '#7c6' : '#5a4',
                    borderRadius: 3,
                    fontSize: 10,
                    paddingLeft: 4,
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    cursor: 'pointer',
                  }}
                >
                  {o.imagePath.split('/').pop()}
                </div>
              )
            );
          })}
        </div>
        {/* captions 軌 */}
        <div style={{ ...rowStyle, height: 24 }}>
          {doc.tracks.captions.map((c) => (
            <div
              key={c.id}
              onPointerDown={() => useSelection.getState().select({ kind: 'caption', id: c.id })}
              style={{
                position: 'absolute',
                left: timeToPx(c.start),
                width: timeToPx(c.duration),
                height: 20,
                background: selected?.kind === 'caption' && selected.id === c.id ? '#68c' : '#46a',
                borderRadius: 3,
                fontSize: 10,
                paddingLeft: 4,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                cursor: 'pointer',
              }}
            >
              {c.text}
            </div>
          ))}
        </div>
        {/* audio 軌 */}
        <div style={{ ...rowStyle, height: 24 }}>
          {doc.tracks.audio.map((a) => (
            <div
              key={a.id}
              style={{
                position: 'absolute',
                left: timeToPx(a.start),
                width: timeToPx(a.duration),
                height: 20,
                background: '#a64',
                borderRadius: 3,
                fontSize: 10,
                paddingLeft: 4,
              }}
            >
              {a.mediaId}
            </div>
          ))}
        </div>
        {/* playhead */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: timeToPx(time),
            width: 2,
            background: 'red',
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  );
}

export { PX_PER_SECOND };
