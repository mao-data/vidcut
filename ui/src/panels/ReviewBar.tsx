import { useRef, useState } from 'react';
import { Bot, Check, X } from 'lucide-react';
import type { ReviewOutcome } from '@vidcut/shared';
import { useProject } from '../stores/project.js';
import { gsap, useGSAP, motionOK } from '../motion.js';
import { sendReviewResolve } from '../ws.js';

/**
 * AI 呼叫 request_review 時的審核卡（spec §6.2）。
 * overlay 蓋在內容上方置中，不擠壓版面；平常不渲染。
 * review 出現才 mount → mount 動畫天然等於「滑入」。
 */
export function ReviewBar() {
  const review = useProject((s) => s.doc?.review ?? null);
  const [note, setNote] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      if (ref.current && motionOK()) {
        gsap.from(ref.current, { y: -24, opacity: 0, duration: 0.45, ease: 'back.out(1.6)' });
      }
    },
    { scope: ref, dependencies: [review?.id] },
  );

  if (!review) return null;

  const resolve = (outcome: ReviewOutcome) => {
    sendReviewResolve(review.id, outcome, note || undefined);
    setNote('');
  };

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        top: 10,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 40,
        width: 'min(720px, calc(100% - 32px))',
        padding: '12px 16px',
        borderRadius: 'var(--r-panel)',
        background: 'var(--popover-bg-blur)',
        backdropFilter: 'blur(8px)',
        border: '1px solid var(--accent-edge-strong)',
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.55), 0 0 24px var(--accent-halo)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      {/* 顏色走 currentColor（lucide 未給 color 時 stroke 就是 currentColor）：
          SVG 屬性不吃 var()，所以 token 只能從 CSS 的 color 繼承下去。 */}
      {/* size 20 是圖示兩級制的刻意例外（theme.css 有記）：這不是工具列或行內圖示，
          而是審核卡的頭像位——整張卡唯一的視覺重心，縮到 14 就淪為裝飾。 */}
      <Bot size={20} style={{ color: 'var(--accent-text)', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 200 }}>
        <strong style={{ color: 'var(--accent-text)' }}>AI asks for your review:</strong>{' '}
        {review.summary}
        {review.focus?.length ? (
          <span className="tag">(focus: {review.focus.join(', ')})</span>
        ) : null}
      </div>
      <input
        placeholder="Note (required to reject)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        style={{ minWidth: 180 }}
      />
      <button
        className="icon-btn"
        onClick={() => resolve('approved')}
        style={{
          background: 'linear-gradient(135deg, #10b981, #059669)',
          border: '1px solid transparent',
          color: '#fff',
          fontWeight: 600,
        }}
      >
        <Check size={13} /> Approve
      </button>
      <button className="icon-btn" onClick={() => resolve('approved_with_notes')} disabled={!note}>
        <Check size={13} /> Approve with note
      </button>
      <button
        className="btn-danger icon-btn"
        onClick={() => resolve('rejected')}
        disabled={!note}
        title={!note ? 'A note is required to reject' : ''}
      >
        <X size={13} /> Reject
      </button>
    </div>
  );
}
