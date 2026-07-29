import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { clipStartTimes, overlayWindow, totalDuration, type Project, type VideoClip } from '@vidcut/shared';
import { useProject } from '../stores/project.js';
import { usePlayback } from '../stores/playback.js';
import { PX_PER_SECOND, pxToTime, timeToPx } from './scale.js';

const ROW_H = 56;

interface Peaks {
  samplesPerBucket: number;
  sampleRate: number;
  peaks: number[];
}
const peaksCache = new Map<string, Peaks>();

function ClipBlock({ p, clip, start }: { p: Project; clip: VideoClip; start: number }) {
  const media = p.media.find((m) => m.id === clip.mediaId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const w = timeToPx(clip.duration);

  useEffect(() => {
    if (!media?.peaksPath) return;
    const url = `/media/${media.peaksPath}`;
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
  }, [media?.peaksPath]);

  useEffect(() => {
    // 畫 [in, in+duration] 的波形切片
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

  // filmstrip：每秒 1 幀，frame 高 80px；以 background-position 對齊 clip.in
  const filmstrip = media?.filmstripPath ? `/media/${media.filmstripPath}` : undefined;
  const frameW = media ? (80 * media.probe.width) / media.probe.height : 45;
  const bgOffset = -(clip.in * frameW); // 每秒一幀 → in 秒 ≈ in 幀
  return (
    <div
      title={`${clip.label ?? clip.id}  in=${clip.in}s dur=${clip.duration}s`}
      style={{
        position: 'absolute',
        left: timeToPx(start),
        width: w,
        height: ROW_H,
        border: '1px solid #555',
        borderRadius: 4,
        overflow: 'hidden',
        backgroundImage: filmstrip ? `url(${filmstrip})` : undefined,
        backgroundPosition: `${bgOffset}px 0`,
        backgroundSize: 'auto 100%',
        backgroundRepeat: 'repeat-x',
        backgroundColor: '#333',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: 4,
          fontSize: 11,
          textShadow: '0 0 3px #000',
        }}
      >
        {clip.label ?? clip.id}
      </span>
      <canvas
        ref={canvasRef}
        width={Math.max(1, Math.floor(w))}
        height={16}
        style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: 16 }}
      />
    </div>
  );
}

export function Timeline() {
  const doc = useProject((s) => s.doc);
  const time = usePlayback((s) => s.time);
  if (!doc) return null;
  const total = totalDuration(doc);
  const starts = clipStartTimes(doc);
  const width = Math.max(timeToPx(total) + 120, 600);

  const onSeek = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    usePlayback.getState().seek(pxToTime(e.clientX - rect.left + e.currentTarget.scrollLeft));
  };

  const rowStyle: CSSProperties = {
    position: 'relative',
    height: ROW_H,
    borderBottom: '1px solid #222',
  };
  return (
    <div style={{ overflowX: 'auto', border: '1px solid #333', userSelect: 'none' }}>
      <div style={{ position: 'relative', width }} onClick={onSeek}>
        {/* 尺規 */}
        <div style={{ position: 'relative', height: 20, borderBottom: '1px solid #444' }}>
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
          {doc.tracks.video.map((c, i) => (
            <ClipBlock key={c.id} p={doc} clip={c} start={starts[i]!} />
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
                  style={{
                    position: 'absolute',
                    left: timeToPx(win.start),
                    width: timeToPx(win.end - win.start),
                    height: 20,
                    background: '#5a4',
                    borderRadius: 3,
                    fontSize: 10,
                    paddingLeft: 4,
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
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
              style={{
                position: 'absolute',
                left: timeToPx(c.start),
                width: timeToPx(c.duration),
                height: 20,
                background: '#46a',
                borderRadius: 3,
                fontSize: 10,
                paddingLeft: 4,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
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
