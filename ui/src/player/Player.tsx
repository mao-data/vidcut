import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { activeTokenIndex, totalDuration, type CaptionItem } from '@vidcut/shared';
import { useProject } from '../stores/project.js';
import { usePlayback } from '../stores/playback.js';
import { planAt } from './plan.js';

const DRIFT_TOLERANCE = 0.06; // 60ms
const PRELAUNCH = 0.05; // 邊界前 50ms 啟動 next

/**
 * 逐詞高亮。預覽端只是把每個詞包成 span 依 playhead 換顏色——
 * 渲染端要一個詞一張 PNG 字卡，但這裡幾乎免費，所以預覽是「真的所見即所得」。
 * 排版交給瀏覽器換行，與 text_card.py 的貪婪換行不會完全一致（字型度量不同），
 * 位置與斷行的最終依據是成片。
 */
function Karaoke({ cap, time }: { cap: CaptionItem; time: number }) {
  const active = activeTokenIndex(cap, time);
  return (
    <>
      {cap.tokens!.map((tok, i) => (
        <span
          key={i}
          style={{ color: i <= active ? (cap.style.highlight ?? cap.style.fill) : cap.style.fill }}
        >
          {i > 0 && /\w$/.test(cap.tokens![i - 1]!.text) && /^\w/.test(tok.text) ? ' ' : ''}
          {tok.text}
        </span>
      ))}
    </>
  );
}

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
  const blurFill = doc?.canvas.fit === 'blur';
  // effect 與 render body 共用同一份 plan（播放中每幀都算，別算兩次）
  const plan = useMemo(() => (doc ? planAt(doc, time) : null), [doc, time]);

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
        spare.muted = false;
        if (playing) void spare.play().catch(() => {});
        return; // 下一輪 effect 以新 active 繼續
      }
      act.src = plan.active.src;
      act.currentTime = plan.active.sourceTime;
      mountedClip.current[key] = plan.active.clipId;
    }

    // 漂移校正
    if (Math.abs(act.currentTime - plan.active.sourceTime) > DRIFT_TOLERANCE) {
      act.currentTime = plan.active.sourceTime;
    }
    if (plan.active.frozen) {
      // 定格幀：停在該格、不出聲，避免反覆 seek
      act.muted = true;
      if (!act.paused) act.pause();
    } else {
      act.muted = false;
      if (playing && act.paused) void act.play().catch(() => {});
      if (!playing && !act.paused) act.pause();
    }

    // premount + 預啟動 next
    if (plan.next && mountedClip.current[spareKey] !== plan.next.clipId) {
      spare.src = plan.next.src;
      spare.currentTime = plan.next.sourceTime;
      spare.muted = true;
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
      if (Math.abs(bg.currentTime - plan.active.sourceTime) > 0.3) {
        bg.currentTime = plan.active.sourceTime;
      }
      if (playing && bg.paused) void bg.play().catch(() => {});
      if (!playing && !bg.paused) bg.pause();
    }
  }, [doc, plan, time, playing, blurFill]);

  if (!doc || !plan) return null;
  const vidStyle = (visible: boolean): CSSProperties => ({
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    opacity: visible ? 1 : 0,
  });
  return (
    <div>
      <div
        style={{
          position: 'relative',
          aspectRatio: '9/16',
          maxHeight: '72vh',
          margin: '0 auto',
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
        {plan.overlays.map((o) => (
          <img
            key={o.id}
            src={o.src}
            alt=""
            style={{
              position: 'absolute',
              left: `${o.position.x * 100}%`,
              top: `${o.position.y * 100}%`,
              transform: `translate(-50%, 0) scale(${o.position.scale})`,
              maxWidth: '90%',
              pointerEvents: 'none',
            }}
          />
        ))}
        {plan.captions.map((c) => (
          <div
            key={c.id}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: `${c.style.y * 100}%`,
              textAlign: 'center',
              fontFamily: c.style.fontFamily,
              fontSize: c.style.fontSize / 3,
              color: c.style.fill,
              WebkitTextStroke: c.style.stroke ? `1px ${c.style.stroke}` : undefined,
              pointerEvents: 'none',
            }}
          >
            {c.tokens && c.tokens.length > 0 ? <Karaoke cap={c} time={time} /> : c.text}
          </div>
        ))}
      </div>
    </div>
  );
}
