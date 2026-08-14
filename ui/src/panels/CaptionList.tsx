import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { motionOK } from '../motion.js';
import { activeTokenIndex, type CaptionItem, type CaptionStyle } from '@vidcut/shared';
import { useProject } from '../stores/project.js';
import { usePlayback } from '../stores/playback.js';
import { useSelection } from '../stores/selection.js';
import { useEditDraft } from '../stores/editDraft.js';
import { sendCommand } from '../ws.js';

/**
 * 打字第二段:80ms debounce 後打去 read-only 的 /text-card/preview 拿字卡 hash——
 * 不進 project doc/history/WS broadcast(那是第三段 commit 才做的事)。
 * 模組級(非 per-instance)計時器:面板通常只掛一份,commit/Escape/unmount 都要能取消,
 * 否則使用者已經放棄編輯、元件都卸載了,還會有一發遲到的 fetch 打出去(見任務要求)。
 */
let previewTimer: ReturnType<typeof setTimeout> | null = null;
function cancelPreview(): void {
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
}
function schedulePreview(cap: CaptionItem, text: string): void {
  cancelPreview();
  previewTimer = setTimeout(() => {
    previewTimer = null;
    void fetch('/text-card/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 故意不帶 tokens:草稿文字的詞邊界屬於舊文字,帶著送只會讓卡片照舊時間戳切詞——
      // 沒有 tokens,server 就不產生 karaoke 分割,近似預覽自然不會顯示錯的高亮(見任務要求)。
      body: JSON.stringify({ text, style: cap.style, width: 1080 }),
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ hash: string }>) : null))
      .then((res) => {
        if (!res) return;
        // id 相同不夠:同一句在這次回應飛行途中可能又被改過一次字——
        // 那種情況目前 draft.text 已經跟這次請求送出去的 text 對不上,
        // 用回應把 previewHash 蓋上去畫面會「跳回舊字」,所以連 text 也要比對過期即丟棄。
        const cur = useEditDraft.getState().caption;
        if (cur?.id === cap.id && cur.text === text) {
          useEditDraft.getState().setPreview(cap.id, res.hash);
        }
      });
  }, 80);
}

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
/**
 * selector 的 fallback 必須是模組級常數：zustand v5 直接用 useSyncExternalStore，
 * selector 每次回傳新 reference（如 `?? []`）會被判定 snapshot 不穩定 →
 * 同步無限重渲染 → React #185，整個 app 在 doc 尚未載入時（每次冷載入）白屏。
 */
const NO_CAPTIONS: CaptionItem[] = [];

export function CaptionList() {
  const captions = useProject((s) => s.doc?.tracks.captions ?? NO_CAPTIONS);
  const selected = useSelection((s) => s.selected);
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);

  // 播放中 time 每幀更新——selector 只回傳 primitive（換句/換詞才變），
  // 列表就只在高亮真的要動時重渲染，而不是每幀一次。
  const currentId = usePlayback(
    (s) => captions.find((c) => s.time >= c.start && s.time < c.start + c.duration)?.id ?? null,
  );
  const activeTok = usePlayback((s) => {
    const cap = captions.find((c) => c.id === currentId);
    return cap ? activeTokenIndex(cap, s.time) : -1;
  });
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
    cancelPreview();
    useEditDraft.getState().clear();
    if (text === '' || text === cap.text) return;
    sendCommand({
      name: 'updateCaption',
      id: cap.id,
      // 文字換了，舊的詞邊界就失效——空陣列＝清掉 tokens（見上方註解）
      patch: { text, tokens: [] },
    });
  };

  // 保險絲:選取換到別句字幕時(通常會先觸發 input 的 blur→commit,但時間軸點擊等路徑
  // 未必經過那個 DOM 事件),丟掉還沒送出的草稿——留著會讓預覽卡繼續顯示已經不在編輯的舊文字。
  // 用 ref 讀最新 draft:subscribe 的回呼跑在 React render 之外,不能直接閉包到 state。
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    const unsub = useSelection.subscribe((s) => {
      const d = draftRef.current;
      if (!d) return;
      if (s.selected?.kind === 'caption' && s.selected.id === d.id) return;
      cancelPreview();
      useEditDraft.getState().clear();
      setDraft(null);
    });
    return () => {
      unsub();
      cancelPreview();
    };
  }, []);

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
    <div className="panel-col" style={{ minWidth: 0 }}>
      {captions.length > 0 && (
        <div className="panel-bar" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={() => applyStyleToAll(captions[0]!.style)}
            title="Apply the first caption's style to all"
          >
            Style to all
          </button>
          {hasTokens && (
            <button onClick={toggleKaraoke} title="Remove word timestamps (show whole sentences)">
              Disable karaoke
            </button>
          )}
        </div>
      )}

      <div className="panel-body">
        {captions.length === 0 && (
          <div style={{ padding: 12, color: 'var(--text-3)' }}>
            No captions yet. Ask the AI to run <code>auto_caption</code> (whisper → auto split →
            word highlight).
          </div>
        )}
        {captions.map((cap) => {
          const isCurrent = cap.id === currentId;
          const isSelected = selected?.kind === 'caption' && selected.id === cap.id;
          const active = isCurrent ? activeTok : -1;
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
                title="Jump to this caption"
                className="mono"
                style={{ minWidth: 54 }}
              >
                {fmt(cap.start)}
              </button>
              {draft?.id === cap.id ? (
                <input
                  autoFocus
                  value={draft.text}
                  onChange={(e) => {
                    const text = e.target.value;
                    // 第一段:純本地 state,零延遲——CaptionLayer 讀 useEditDraft 立刻用
                    // DOM 近似文字覆蓋預覽。第二段(schedulePreview)才會真的打伺服器。
                    setDraft({ id: cap.id, text });
                    useEditDraft.getState().setText(cap.id, text);
                    schedulePreview(cap, text);
                  }}
                  onBlur={() => commit(cap)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commit(cap);
                    if (e.key === 'Escape') {
                      setDraft(null);
                      cancelPreview();
                      useEditDraft.getState().clear();
                    }
                  }}
                  style={{ flex: 1, minWidth: 0 }}
                />
              ) : (
                <div
                  onDoubleClick={() => setDraft({ id: cap.id, text: cap.text })}
                  title="Double-click to edit"
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
                className="icon-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  sendCommand({
                    name: 'setCaptions',
                    captions: captions.filter((c) => c.id !== cap.id),
                  });
                }}
                title="Delete this caption"
                aria-label="Delete this caption"
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
