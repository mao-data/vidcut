import { memo, type PointerEvent } from 'react';
import { Snowflake } from 'lucide-react';
import type { Project, VideoClip } from '@vidcut/shared';
import { timeToPx } from './scale.js';

/** 主軌列高(filmstrip 滿版)。2026-08-16 使用者多輪定案收斂:
 * 主軌=其他軌的 2 倍,同日兩輪放寬 60→64→70(=2×35)。之後想再調,改這
 * 一個數字即可(音訊/字幕/overlay 軌在 AudioChip/Timeline 的 35),改完跑
 * verify:canvas(拖曳幾何)。 */
export const ROW_H = 70;

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
  fx = '',
  fxDelay,
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
  /** AI 動畫層附加 class（' fx-enter' / ' fx-glow-a|b'）與骨牌進場延遲 */
  fx?: string;
  fxDelay?: number;
}) {
  const media = p.media.find((m) => m.id === clip.mediaId);
  const w = timeToPx(clip.duration, pps);
  // 2026-08-16 使用者定案:主軌**不顯示**波形帶,filmstrip 吃滿列高。
  // 波形機制(clipWave 查表/--wave-clip-* token/繪製器)完整保留——音訊軌仍用,
  // 要復原只需掛回 canvas+draw effect(參考 AudioChip.tsx 的現行寫法)。
  // 已知代價:muted(volume=0)原以波形變淡提示,現無時間軸層級的視覺線索
  // (音量狀態仍在 Inspector);frozen 的平線指示移除(Snowflake 圖示仍在)。
  const filmstrip = media?.filmstripPath ? `/media/${media.filmstripPath}` : undefined;
  const frameW = media ? ((ROW_H - 4) * media.probe.width) / media.probe.height : 45;
  const bgOffset = -(clip.in * frameW);
  return (
    <div
      className={'clipblk' + fx}
      onPointerDown={(e) => {
        onSelect(clip.id);
        onMoveStart(e, clip);
      }}
      title={`${clip.label ?? clip.id}  in=${clip.in.toFixed(2)}s dur=${clip.duration.toFixed(2)}s${
        clip.frozen ? ' (frozen)' : ''
      }`}
      style={{
        position: 'absolute',
        ...(fxDelay != null ? { animationDelay: `${fxDelay}ms` } : {}),
        left: leftPx,
        width: w,
        // 上下各 2px 浮在列裡(與字幕 chip 同款,2026-08-16 使用者定案 A)
        top: 2,
        height: ROW_H - 4,
        borderRadius: 'var(--r-card)',
        overflow: 'hidden',
        cursor: floating ? 'grabbing' : 'grab',
        background: 'var(--card)',
        // 選取＝紅蠟筆圈起來的那一格（--select-edge）。刻意不吃 --accent：
        // 那是主行動色（Export/focus），時間軸的選取是標記層，兩者在暗版是不同顏料。
        // paper 下 --select-edge 指向 ink 字面值，computed 與收編前完全相同。
        boxShadow: selected
          ? 'inset 0 0 0 1.5px var(--select-edge), 0 0 14px var(--accent-glow)'
          : 'inset 0 0 0 1px var(--line-strong)',
        // 讓位動畫：只有「不是被拖的那個」才滑動，被拖的要 1:1 跟手。
        // 非拖曳時不寫 inline transition——box-shadow 補間在 .clipblk、
        // AI 窗的位置補間在 .ai-anim > div（inline 會蓋掉 class，寫了就掛不上）
        ...(animate ? { transition: 'left 120ms ease' } : {}),
        ...(floating
          ? {
              zIndex: 20,
              opacity: 0.9,
              transform: 'scale(1.02)',
              boxShadow: 'var(--shadow-float), inset 0 0 0 1.5px var(--select-edge)',
            }
          : null),
      }}
    >
      {/* filmstrip 縮圖滿版(波形帶已依使用者定案移除,見上方註解) */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: clip.frozen || !filmstrip ? undefined : `url(${filmstrip})`,
          backgroundPosition: `${bgOffset}px 0`,
          backgroundSize: 'auto 100%',
          backgroundRepeat: 'repeat-x',
          backgroundColor: clip.frozen ? 'var(--clip-frozen-bg)' : undefined,
        }}
      />
      <div
        className="handle"
        style={{ left: 0 }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onSelect(clip.id);
          onTrimStart(e, clip, 'in');
        }}
      />
      <div
        className="handle"
        style={{ right: 0 }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onSelect(clip.id);
          onTrimStart(e, clip, 'out');
        }}
      />
      <span
        style={{
          position: 'absolute',
          top: 4,
          // left 9 / maxWidth 18 是一組：要讓開 6px 的 trim handle，且兩側對稱（9×2=18）。
          // 屬於 chip 內部幾何，不是留白階梯。
          left: 9,
          fontSize: 11,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          textShadow: 'var(--clip-text-shadow)',
          pointerEvents: 'none',
          maxWidth: 'calc(100% - 18px)',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}
      >
        {/* size 11 是兩級制的時間軸 chip 例外（theme.css 有記）：標籤字級 11，
            13 會壓過文字。 */}
        {clip.frozen && <Snowflake size={11} />}
        {clip.label ?? clip.id}
      </span>
    </div>
  );
});
