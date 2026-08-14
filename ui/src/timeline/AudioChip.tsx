import { memo, useEffect, useRef, type PointerEvent } from 'react';
import { Volume1 } from 'lucide-react';
import type { AudioItem, Project } from '@vidcut/shared';
import { timeToPx } from './scale.js';
import { drawWaveform, AUDIO_WAVE } from './waveform.js';
import { useWaveform } from './usePeaks.js';

/** 音訊軌列高 */
export const AUDIO_ROW_H = 30;

/** 音訊軌項目：青色全高波形 chip（可拖曳平移、左右緣 trim）。memo 理由同 ClipBlock。 */
export const AudioChip = memo(function AudioChip({
  p,
  a,
  pps,
  selected,
  onDragStart,
  fx = '',
  fxDelay,
}: {
  p: Project;
  a: AudioItem;
  pps: number;
  selected: boolean;
  onDragStart: (e: PointerEvent, a: AudioItem, edge: 'move' | 'in' | 'out') => void;
  /** AI 動畫層附加 class 與骨牌進場延遲 */
  fx?: string;
  fxDelay?: number;
}) {
  const media = p.media.find((m) => m.id === a.mediaId);
  const peaks = useWaveform(media?.peaksPath);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const w = timeToPx(a.duration, pps);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !peaks) return;
    drawWaveform(cv, peaks, { from: a.in, duration: a.duration, midline: false, ...AUDIO_WAVE });
  }, [peaks, a.in, a.duration, w]);

  return (
    <div
      className={'clipblk' + fx}
      onPointerDown={(e) => onDragStart(e, a, 'move')}
      title={`${a.label ?? a.mediaId} vol=${a.volume}${a.ducking ? ' (ducking)' : ''}`}
      style={{
        position: 'absolute',
        ...(fxDelay != null ? { animationDelay: `${fxDelay}ms` } : {}),
        left: timeToPx(a.start, pps),
        width: w,
        height: AUDIO_ROW_H - 4,
        top: 2,
        borderRadius: 6,
        overflow: 'hidden',
        cursor: 'grab',
        background: 'rgba(14, 165, 233, 0.12)',
        boxShadow: selected
          ? 'inset 0 0 0 1.5px var(--audio-bright), 0 0 10px rgba(14, 165, 233, 0.35)'
          : 'inset 0 0 0 1px rgba(14, 165, 233, 0.35)',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      />
      <div
        className="handle"
        style={{ left: 0 }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onDragStart(e, a, 'in');
        }}
      />
      <div
        className="handle"
        style={{ right: 0 }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onDragStart(e, a, 'out');
        }}
      />
      <span
        style={{
          position: 'absolute',
          left: 6,
          top: 2,
          fontSize: 10,
          color: 'var(--audio-bright)',
          textShadow: '0 1px 2px rgba(0,0,0,0.8)',
          pointerEvents: 'none',
          // inline-flex 讓 ducking 圖示與文字置中對齊；chip 是絕對定位、高度固定，
          // 圖示不會把它撐開（同 ClipBlock 的 frozen 標記）。
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {/* size 11 是兩級制的時間軸 chip 例外（theme.css 有記）：chip 只有 26px 高、
            字級 10，13 會壓過文字。 */}
        {a.ducking && <Volume1 size={11} aria-label="ducking" />}
        {a.label ?? a.mediaId}
      </span>
    </div>
  );
});
