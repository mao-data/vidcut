import { type CSSProperties } from 'react';
import { Music, Plus, Library } from 'lucide-react';
import type { AudioItem, MediaAsset } from '@vidcut/shared';
import { useProject } from '../../stores/project.js';
import { usePlayback } from '../../stores/playback.js';
import { useToast } from '../../stores/toast.js';
import { sendCommand } from '../../ws.js';

/**
 * zustand v5 selector fallback 一律模組級常數——見 CaptionList.tsx 同一條註解、
 * CLAUDE.md 鐵則：`?? []` 每次回傳新 reference 會被判定 snapshot 不穩定，
 * 在 doc 尚未載入時（每次冷載入）造成同步無限重渲染（React #185）。
 */
const NO_MEDIA: MediaAsset[] = [];
const NO_AUDIO: AudioItem[] = [];

function fmtDuration(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t - m * 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** filmstrip sprite 首格縮圖的 background-position/size（見 shared MediaAsset.filmstripTiles 註解）。 */
function firstTileStyle(m: MediaAsset): CSSProperties {
  const tiles = m.filmstripTiles ?? Math.max(1, Math.ceil(m.probe.duration));
  return {
    backgroundImage: `url(/media/${m.filmstripPath})`,
    backgroundSize: `${tiles * 100}% 100%`,
    backgroundPosition: '0% 0%',
    backgroundRepeat: 'no-repeat',
  };
}

/**
 * 專案媒體區：列出 doc.media，兩個動作——加到時間軸（video→addClip／audio-only→setAudio）
 * 與反向沉澱入庫（POST /api/library/from-media）。兩者都不呼叫 useSelection.select()
 * （MediaPanel 頭部鐵則）；加到時間軸走 sendCommand，不做樂觀更新，等 server echo。
 */
export function ProjectMediaZone() {
  const media = useProject((s) => s.doc?.media ?? NO_MEDIA);
  const audio = useProject((s) => s.doc?.tracks.audio ?? NO_AUDIO);

  const addToTimeline = (m: MediaAsset) => {
    const audioOnly = m.probe.hasVideo === false;
    if (audioOnly) {
      const item: AudioItem = {
        // id 產生慣例照 Toolbar.tsx 的 addOverlayFile（見任務要求，不抄它的 select() 呼叫）
        id: `au_${Math.random().toString(36).slice(2, 10)}`,
        mediaId: m.id,
        start: usePlayback.getState().time,
        in: 0,
        duration: m.probe.duration,
        volume: 1,
      };
      sendCommand({ name: 'setAudio', audio: [...audio, item] });
    } else {
      sendCommand({ name: 'addClip', mediaId: m.id, in: 0, duration: m.probe.duration });
    }
  };

  const saveToLibrary = (m: MediaAsset) => {
    void fetch('/api/library/from-media', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaId: m.id }),
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ existing: boolean }>) : null))
      .then((res) => {
        if (!res) return;
        useToast.getState().show(res.existing ? 'Already in library' : 'Saved to library');
      });
  };

  return (
    <div className="panel-body">
      {media.length === 0 && (
        <div className="empty-note" style={{ padding: 12, color: 'var(--text-3)' }}>
          No media yet. Import from the Folder tab or ask the AI.
        </div>
      )}
      {media.map((m) => {
        const audioOnly = m.probe.hasVideo === false;
        const inLibrary = m.meta?.libraryId != null;
        return (
          <div
            key={m.id}
            className="rowline"
            style={{ display: 'flex', gap: 8, padding: '4px 8px' }}
          >
            <div
              style={{
                width: 48,
                height: 27,
                flexShrink: 0,
                background: 'var(--card)',
                border: '1px solid var(--line)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                ...(!audioOnly && m.filmstripPath ? firstTileStyle(m) : {}),
              }}
            >
              {audioOnly && <Music size={13} />}
            </div>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.label ?? m.path}
              </span>
              {inLibrary && <span className="tag">lib</span>}
            </div>
            <span className="mono" style={{ color: 'var(--text-3)' }}>
              {fmtDuration(m.probe.duration)}
            </span>
            <button
              className="icon-btn"
              title="Add"
              aria-label="Add"
              onClick={() => addToTimeline(m)}
            >
              <Plus size={13} />
            </button>
            <button
              className="icon-btn"
              title="Save to library"
              aria-label="Save to library"
              onClick={() => saveToLibrary(m)}
            >
              <Library size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
