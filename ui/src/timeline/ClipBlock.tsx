import { memo, useEffect, useRef, type CSSProperties, type PointerEvent } from 'react';
import { Snowflake } from 'lucide-react';
import type { Project, VideoClip } from '@vidcut/shared';
import { timeToPx } from './scale.js';
import { drawWaveform, CLIP_WAVE } from './waveform.js';
import { useWaveform } from './usePeaks.js';

/** 主軌列高（上：filmstrip／下：波形帶） */
export const ROW_H = 64;

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
}) {
  const media = p.media.find((m) => m.id === clip.mediaId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaks = useWaveform(clip.frozen ? undefined : media?.peaksPath);
  const w = timeToPx(clip.duration, pps);
  /** 下緣波形帶高度（約 40%，定案於 spec §3） */
  const bandH = Math.round(ROW_H * 0.4);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !peaks) return;
    drawWaveform(cv, peaks, { from: clip.in, duration: clip.duration, ...CLIP_WAVE });
  }, [peaks, clip.in, clip.duration, w]);

  const filmstrip = media?.filmstripPath ? `/media/${media.filmstripPath}` : undefined;
  const filmH = ROW_H - bandH;
  const frameW = media ? (filmH * media.probe.width) / media.probe.height : 45;
  const bgOffset = -(clip.in * frameW);
  const muted = clip.volume === 0;
  const handle: CSSProperties = {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 6,
    cursor: 'ew-resize',
    zIndex: 2,
  };
  return (
    <div
      className="clipblk"
      onPointerDown={(e) => {
        onSelect(clip.id);
        onMoveStart(e, clip);
      }}
      title={`${clip.label ?? clip.id}  in=${clip.in.toFixed(2)}s dur=${clip.duration.toFixed(2)}s${
        clip.frozen ? ' (定格)' : ''
      }`}
      style={{
        position: 'absolute',
        left: leftPx,
        width: w,
        height: ROW_H,
        borderRadius: 'var(--r-card)',
        overflow: 'hidden',
        cursor: floating ? 'grabbing' : 'grab',
        background: 'var(--card)',
        boxShadow: selected
          ? 'inset 0 0 0 1.5px var(--accent), 0 0 14px rgba(139, 92, 246, 0.35)'
          : 'inset 0 0 0 1px var(--line-strong)',
        // 讓位動畫：只有「不是被拖的那個」才滑動，被拖的要 1:1 跟手
        transition: animate ? 'left 120ms ease' : 'box-shadow 0.15s ease',
        ...(floating
          ? {
              zIndex: 20,
              opacity: 0.9,
              transform: 'scale(1.02)',
              boxShadow: '0 6px 20px rgba(0, 0, 0, 0.65), inset 0 0 0 1.5px var(--accent)',
            }
          : null),
      }}
    >
      {/* 上：filmstrip 縮圖區 */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: filmH,
          backgroundImage: clip.frozen || !filmstrip ? undefined : `url(${filmstrip})`,
          backgroundPosition: `${bgOffset}px 0`,
          backgroundSize: 'auto 100%',
          backgroundRepeat: 'repeat-x',
          backgroundColor: clip.frozen ? '#2d3a52' : undefined,
        }}
      />
      {/* 下：波形帶（frozen＝平線） */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: bandH,
          background: 'rgba(0, 0, 0, 0.32)',
        }}
      >
        {clip.frozen ? (
          <div
            style={{
              position: 'absolute',
              left: 6,
              right: 6,
              top: '50%',
              height: 1.5,
              background: 'rgba(255, 255, 255, 0.15)',
            }}
          />
        ) : (
          <canvas
            ref={canvasRef}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              pointerEvents: 'none',
              opacity: muted ? 0.35 : 1,
            }}
          />
        )}
      </div>
      <div
        className="handle"
        style={{ ...handle, left: 0 }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onSelect(clip.id);
          onTrimStart(e, clip, 'in');
        }}
      />
      <div
        className="handle"
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
          top: 3,
          left: 9,
          fontSize: 11,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          textShadow: '0 1px 3px rgba(0,0,0,0.9)',
          pointerEvents: 'none',
          maxWidth: 'calc(100% - 18px)',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}
      >
        {clip.frozen && <Snowflake size={11} />}
        {clip.label ?? clip.id}
      </span>
    </div>
  );
});
