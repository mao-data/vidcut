import { useState } from 'react';
import type { ReviewOutcome } from '@vidcut/shared';
import { useProject } from '../stores/project.js';
import { sendReviewResolve } from '../ws.js';

/** AI 呼叫 request_review 時頂部亮出的審核條（spec §6.2）。 */
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
        background: '#2b3a55',
        borderBottom: '2px solid #4af',
        padding: '10px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}
    >
      <span style={{ fontSize: 20 }}>👀</span>
      <div style={{ flex: 1, minWidth: 200 }}>
        <strong>AI 請你確認：</strong> {review.summary}
        {review.focus?.length ? (
          <span style={{ opacity: 0.7 }}>（聚焦：{review.focus.join(', ')}）</span>
        ) : null}
      </div>
      <input
        placeholder="留言（退回時必填）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        style={{
          padding: 6,
          minWidth: 180,
          background: '#1a2436',
          color: '#eee',
          border: '1px solid #456',
          borderRadius: 4,
        }}
      />
      <button
        onClick={() => resolve('approved')}
        style={{ background: '#2a6', color: '#fff', padding: '6px 12px' }}
      >
        ✓ 核准
      </button>
      <button
        onClick={() => resolve('approved_with_notes')}
        disabled={!note}
        style={{ padding: '6px 12px' }}
      >
        ✓ 核准並留言
      </button>
      <button
        onClick={() => resolve('rejected')}
        disabled={!note}
        title={!note ? '退回需填留言' : ''}
        style={{ background: '#a33', color: '#fff', padding: '6px 12px' }}
      >
        ✗ 退回
      </button>
    </div>
  );
}
