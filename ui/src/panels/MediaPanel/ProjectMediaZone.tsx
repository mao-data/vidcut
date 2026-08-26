import { useRef, useState, type CSSProperties } from 'react';
import { Music, Plus, Library, Upload, FolderUp } from 'lucide-react';
import type { AudioItem, MediaAsset } from '@vidcut/shared';
import { useProject } from '../../stores/project.js';
import { usePlayback } from '../../stores/playback.js';
import { useToast } from '../../stores/toast.js';
import { sendCommand } from '../../ws.js';

/**
 * 可上傳進專案的影音副檔名——**手抄自 server `sourceFolder.ts` 的 MEDIA_EXTENSIONS**
 * （UI 不 import server workspace，同 LibraryZone 的最小型別慣例；server 端會再驗一次，
 * 這份只是前端預過濾）。刻意不含圖片：圖片是 overlay 素材不是 clip，入庫走 Library。
 * 資料夾上傳（webkitdirectory）拿到整夾檔案（.DS_Store、字幕檔全在內），靠這份過濾。
 */
const UPLOAD_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.mp3', '.m4a', '.wav', '.aac'];

function isMediaFile(name: string): boolean {
  const i = name.lastIndexOf('.');
  return i !== -1 && UPLOAD_EXTENSIONS.includes(name.slice(i).toLowerCase());
}

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

/**
 * filmstrip sprite 首格縮圖：回傳**等比 contain** 的內層樣式（不是鋪滿卡片）——
 * 直式素材在 16:9 卡裡左右補黑（.thumb.letterbox 給黑底），不拉伸不裁切。
 * 做法：內層 div 撐出素材自己的長寬比（rotation 90/270 要對調），sprite 背景
 * 鋪滿內層；比卡片寬（>16:9）就吃滿寬、比卡片窄就吃滿高，flex 置中補邊。
 */
function containedTileStyle(
  probe: { width: number; height: number; rotation?: number },
  bgUrl: string,
  tiles: number,
): CSSProperties {
  const swap = (((probe.rotation ?? 0) % 180) + 180) % 180 !== 0;
  const w = swap ? probe.height : probe.width;
  const h = swap ? probe.width : probe.height;
  const aspect = w > 0 && h > 0 ? w / h : 16 / 9;
  const wide = aspect >= 16 / 9;
  return {
    ...(wide ? { width: '100%' } : { height: '100%' }),
    aspectRatio: String(aspect),
    backgroundImage: `url(${bgUrl})`,
    backgroundSize: `${tiles * 100}% 100%`,
    backgroundPosition: '0% 0%',
    backgroundRepeat: 'no-repeat',
  };
}

function firstTileStyle(m: MediaAsset): CSSProperties {
  const tiles = m.filmstripTiles ?? Math.max(1, Math.ceil(m.probe.duration));
  return containedTileStyle(m.probe, `/media/${m.filmstripPath}`, tiles);
}

/**
 * 專案媒體區：列出 doc.media，兩個動作——加到時間軸（video→addClip／audio-only→setAudio）
 * 與反向沉澱入庫（POST /api/library/from-media）。兩者都不呼叫 useSelection.select()
 * （MediaPanel 頭部鐵則）；加到時間軸走 sendCommand，不做樂觀更新，等 server echo。
 */
export function ProjectMediaZone() {
  const media = useProject((s) => s.doc?.media ?? NO_MEDIA);
  const audio = useProject((s) => s.doc?.tracks.audio ?? NO_AUDIO);
  const [query, setQuery] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // 前端即時過濾：doc.media 已在記憶體，不打 API 不 debounce（Library 那邊資料在
  // 後端才需要 debounce 重查——刻意的機制差異，不是不一致）。
  const q = query.trim().toLowerCase();
  const visible = q
    ? media.filter((m) => `${m.label ?? ''} ${m.path}`.toLowerCase().includes(q))
    : media;

  const uploadFiles = async (files: FileList): Promise<void> => {
    // 逐檔序列上傳（不並發，同 LibraryZone）：body 直接傳 File 讓瀏覽器串流。
    // 上傳成功**不需要**手動刷新——/api/media 走 registerMedia 命令，WS patch
    // 廣播回來 doc.media 就更新了（zustand selector 自動重渲染）。
    const picked = Array.from(files).filter((f) => isMediaFile(f.name));
    const skipped = files.length - picked.length;
    if (picked.length === 0) {
      useToast.getState().show('No media files to upload');
      return;
    }
    let failed = 0;
    for (const f of picked) {
      useToast.getState().show(`Uploading ${f.name}…`);
      try {
        const res = await fetch(`/api/media?${new URLSearchParams({ name: f.name })}`, {
          method: 'POST',
          body: f,
        });
        if (!res.ok) failed++;
      } catch {
        failed++;
      }
    }
    const parts = [`Uploaded ${picked.length - failed}`];
    if (failed > 0) parts.push(`failed ${failed}`);
    if (skipped > 0) parts.push(`skipped ${skipped} non-media`);
    useToast.getState().show(parts.join(', '));
  };

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
    <div className="panel-col" style={{ minWidth: 0 }}>
      <div className="panel-bar" style={{ gap: 4, padding: '6px 12px' }}>
        <input
          placeholder="Search media"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*,audio/*,.mkv"
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files?.length) void uploadFiles(e.target.files);
            e.target.value = '';
          }}
        />
        {/* webkitdirectory 不在 React 的型別裡（非標準但 Chrome/Safari/Edge 都吃），用 spread 塞 */}
        <input
          ref={folderInputRef}
          type="file"
          style={{ display: 'none' }}
          {...({ webkitdirectory: '' } as object)}
          onChange={(e) => {
            if (e.target.files?.length) void uploadFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          className="icon-btn"
          title="Upload files"
          aria-label="Upload files"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload size={13} />
        </button>
        <button
          className="icon-btn"
          title="Upload folder"
          aria-label="Upload folder"
          onClick={() => folderInputRef.current?.click()}
        >
          <FolderUp size={13} />
        </button>
      </div>
      <div className="panel-body">
        {media.length === 0 && (
          <div className="empty-note" style={{ padding: 12, color: 'var(--text-3)' }}>
            No media yet. Upload files to get started.
          </div>
        )}
        {media.length > 0 && visible.length === 0 && (
          <div className="empty-note" style={{ padding: 12, color: 'var(--text-3)' }}>
            {`No matches for "${query.trim()}".`}
          </div>
        )}
        {visible.length > 0 && (
          <div className="media-grid">
            {visible.map((m) => {
              const audioOnly = m.probe.hasVideo === false;
              const inLibrary = m.meta?.libraryId != null;
              return (
                <div key={m.id} className="media-card">
                  <div className={`thumb${!audioOnly && m.filmstripPath ? ' letterbox' : ''}`}>
                    {!audioOnly && m.filmstripPath && <div style={firstTileStyle(m)} />}
                    {audioOnly && <Music size={20} />}
                    {inLibrary && <span className="mark">lib</span>}
                    <span className="dur mono">{fmtDuration(m.probe.duration)}</span>
                    <div className="card-actions">
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
                  </div>
                  <div className="name" title={m.label ?? m.path}>
                    {m.label ?? m.path}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
