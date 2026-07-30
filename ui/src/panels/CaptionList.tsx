import { useEffect, useMemo, useRef, useState } from 'react';
import { motionOK } from '../motion.js';
import { activeTokenIndex, type CaptionItem, type CaptionStyle } from '@vidcut/shared';
import { useProject } from '../stores/project.js';
import { usePlayback } from '../stores/playback.js';
import { useSelection } from '../stores/selection.js';
import { sendCommand } from '../ws.js';

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/**
 * 字幕列表 view。逐句改字在列表裡比在時間軸上點來點去快得多（CapCut 的關鍵 UX），
 * 所以字幕不走「只能在 Inspector 編選取項」那條路。
 *
 * 改字時若該句有逐詞時間戳，會**清掉 tokens**——原本的詞邊界對新文字已經沒有意義，
 * 硬留著會讓高亮跟著錯的詞跑。要重新取得逐詞高亮就再跑一次 auto_caption。
 */
export function CaptionList() {
  const captions = useProject((s) => s.doc?.tracks.captions ?? []);
  const time = usePlayback((s) => s.time);
  const selected = useSelection((s) => s.selected);
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);

  const currentId = useMemo(
    () => captions.find((c) => time >= c.start && time < c.start + c.duration)?.id ?? null,
    [captions, time],
  );
  const currentRowRef = useRef<HTMLDivElement>(null);

  // 播放時當前句自動捲進視野（reduced-motion 時不做平滑捲動）
  useEffect(() => {
    currentRowRef.current?.scrollIntoView({
      block: 'nearest',
      behavior: motionOK() ? 'smooth' : 'auto',
    });
  }, [currentId]);

  const commit = (cap: CaptionItem) => {
    if (!draft || draft.id !== cap.id) return;
    const text = draft.text.trim();
    setDraft(null);
    if (text === '' || text === cap.text) return;
    sendCommand({
      name: 'updateCaption',
      id: cap.id,
      // 文字換了，舊的詞邊界就失效——空陣列＝清掉 tokens（見上方註解）
      patch: { text, tokens: [] },
    });
  };

  const applyStyleToAll = (style: CaptionStyle) => {
    sendCommand({ name: 'setCaptions', captions: captions.map((c) => ({ ...c, style })) });
  };

  const toggleKaraoke = () => {
    const anyTokens = captions.some((c) => c.tokens && c.tokens.length > 0);
    if (anyTokens) {
      sendCommand({
        name: 'setCaptions',
        captions: captions.map(({ tokens: _drop, ...rest }) => rest),
      });
    }
  };

  const hasTokens = captions.some((c) => c.tokens && c.tokens.length > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
      {captions.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: 8,
            borderBottom: '1px solid var(--line)',
            flexWrap: 'wrap',
          }}
        >
          <button
            onClick={() => applyStyleToAll(captions[0]!.style)}
            title="把第一句的樣式套用到全部"
          >
            樣式套全部
          </button>
          {hasTokens && (
            <button onClick={toggleKaraoke} title="移除逐詞時間戳（改回整句顯示）">
              關閉逐詞高亮
            </button>
          )}
        </div>
      )}

      <div style={{ overflowY: 'auto', flex: 1, fontSize: 12 }}>
        {captions.length === 0 && (
          <div style={{ padding: 10, color: 'var(--text-3)' }}>
            尚無字幕。請 AI 跑 <code>auto_caption</code>（whisper 辨識 → 自動斷句 → 逐詞高亮）。
          </div>
        )}
        {captions.map((cap) => {
          const isCurrent = cap.id === currentId;
          const isSelected = selected?.kind === 'caption' && selected.id === cap.id;
          const active = activeTokenIndex(cap, time);
          return (
            <div
              key={cap.id}
              ref={isCurrent ? currentRowRef : undefined}
              className="rowline"
              onClick={() => useSelection.getState().select({ kind: 'caption', id: cap.id })}
              style={{
                display: 'flex',
                gap: 8,
                padding: '4px 8px',
                borderBottom: '1px solid var(--line)',
                background: isSelected
                  ? 'var(--accent-soft)'
                  : isCurrent
                    ? 'rgba(139, 92, 246, 0.08)'
                    : undefined,
                cursor: 'pointer',
              }}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  usePlayback.getState().seek(cap.start);
                }}
                title="跳到這句"
                className="mono"
                style={{ minWidth: 54 }}
              >
                {fmt(cap.start)}
              </button>
              {draft?.id === cap.id ? (
                <input
                  autoFocus
                  value={draft.text}
                  onChange={(e) => setDraft({ id: cap.id, text: e.target.value })}
                  onBlur={() => commit(cap)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit(cap);
                    if (e.key === 'Escape') setDraft(null);
                  }}
                  style={{ flex: 1, minWidth: 0 }}
                />
              ) : (
                <div
                  onDoubleClick={() => setDraft({ id: cap.id, text: cap.text })}
                  title="雙擊改字"
                  style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}
                >
                  {cap.tokens && cap.tokens.length > 0 && isCurrent
                    ? cap.tokens.map((tok, i) => (
                        <span
                          key={i}
                          style={{
                            color:
                              i <= active ? (cap.style.highlight ?? cap.style.fill) : undefined,
                          }}
                        >
                          {tok.text}
                        </span>
                      ))
                    : cap.text}
                </div>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  sendCommand({
                    name: 'setCaptions',
                    captions: captions.filter((c) => c.id !== cap.id),
                  });
                }}
                title="刪除這句"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
