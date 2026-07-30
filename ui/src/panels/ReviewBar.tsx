import { useState } from 'react';
import { Bot, Check, X } from 'lucide-react';
import type { ReviewOutcome } from '@vidcut/shared';
import { useProject } from '../stores/project.js';
import { sendReviewResolve } from '../ws.js';

/**
 * AI 呼叫 request_review 時的審核卡（spec §6.2）。
 * overlay 蓋在內容上方置中，不擠壓版面；平常不渲染。
 */
export function ReviewBar() {
  const review = useProject((s) => s.doc?.review ?? null);
  const [note, setNote] = useState('');
  if (!review) return null;

  const resolve = (outcome: ReviewOutcome) => {
    sendReviewResolve(review.id, outcome, note || undefined);
    setNote('');
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: 10,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 40,
        width: 'min(720px, calc(100% - 32px))',
        padding: '12px 16px',
        borderRadius: 'var(--r-panel)',
        background: 'rgba(26, 29, 46, 0.92)',
        backdropFilter: 'blur(8px)',
        border: '1px solid rgba(139, 92, 246, 0.45)',
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.55), 0 0 24px rgba(139, 92, 246, 0.15)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <Bot size={20} color="#c4b5fd" />
      <div style={{ flex: 1, minWidth: 200 }}>
        <strong style={{ color: '#c4b5fd' }}>AI 請你確認：</strong> {review.summary}
        {review.focus?.length ? (
          <span className="tag">（聚焦：{review.focus.join(', ')}）</span>
        ) : null}
      </div>
      <input
        placeholder="留言（退回時必填）"
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
        <Check size={14} /> 核准
      </button>
      <button className="icon-btn" onClick={() => resolve('approved_with_notes')} disabled={!note}>
        <Check size={14} /> 核准並留言
      </button>
      <button
        className="btn-danger icon-btn"
        onClick={() => resolve('rejected')}
        disabled={!note}
        title={!note ? '退回需填留言' : ''}
      >
        <X size={14} /> 退回
      </button>
    </div>
  );
}
