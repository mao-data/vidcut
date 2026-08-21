import { memo, useEffect, useRef, type PointerEvent } from 'react';
import { Volume1 } from 'lucide-react';
import type { AudioItem, Project } from '@vidcut/shared';
import { timeToPx } from './scale.js';
import { drawWaveform, audioWave } from './waveform.js';
import { useWaveform } from './usePeaks.js';
import { useTheme } from '../stores/theme.js';

/** 音訊軌列高(=其他軌統一 35,主軌的一半)。2026-08-16 使用者兩輪放寬:30→32→35。 */
export const AUDIO_ROW_H = 35;

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
  // Plan 11 Task 1（範圍裁決 3b/3c，review round 1 Important 1 修正）：同
  // ClipBlock／Timeline 的 `handleOffset` 算式（三處手動同步，見 ClipBlock.tsx
  // 同名常數旁的註解）——選取態命中區 12px 跨邊界置中，窄片再疊加外推量。
  const NARROW_THRESHOLD = 28;
  const SELECTED_HANDLE_W = 12;
  const overflowOffset = selected
    ? -SELECTED_HANDLE_W / 2 + (w < NARROW_THRESHOLD ? -Math.ceil((NARROW_THRESHOLD - w) / 2) : 0)
    : 0;
  // 理由同 ClipBlock：canvas 不吃 CSS 變數，主題換了要自己重畫
  const theme = useTheme((s) => s.theme);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !peaks) return;
    drawWaveform(cv, peaks, { from: a.in, duration: a.duration, midline: false, ...audioWave() });
  }, [peaks, a.in, a.duration, w, theme]);

  return (
    <div
      className={'clipblk' + (selected ? ' selected' : '') + fx}
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
        // Plan 11 Task 1（範圍裁決 3c）：不再裁 overflow——canvas 本身用 inset:0，
        // 不會超出 chip 邊界，圓角裁切不靠這層；讓出空間給選取窄片時外溢的把手。
        overflow: 'visible',
        // review round 1 Critical 1：同 ClipBlock，選取態抬升到相鄰 chip 之上
        // （這條軌沒有 floating 拖曳態的 20，15 已經是這裡的最高值）。
        zIndex: selected ? 15 : undefined,
        cursor: 'grab',
        // 實色底(2026-08-16 使用者定案:時間軸 chip 不透底),值見 theme.css 的 chip-bg 註解
        background: 'var(--audio-chip-bg)',
        boxShadow: selected
          ? 'inset 0 0 0 1.5px var(--audio-bright), 0 0 10px var(--audio-edge)'
          : 'inset 0 0 0 1px var(--audio-edge)',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          borderRadius: 6,
          pointerEvents: 'none',
        }}
      />
      <div
        className="handle"
        style={{ left: overflowOffset }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onDragStart(e, a, 'in');
        }}
      />
      <div
        className="handle"
        style={{ right: overflowOffset }}
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
          textShadow: 'var(--chip-text-shadow)',
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
