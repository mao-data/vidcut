import {
  ImagePlus,
  Magnet,
  Maximize2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Type,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { usePlayback } from '../stores/playback.js';
import { useSelection } from '../stores/selection.js';
import { useView } from '../stores/view.js';
import { sendCommand } from '../ws.js';

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/**
 * 只有 Timecode 訂閱 playback time：播放中 time 每幀更新（rAF），
 * 若工具列或 Timeline 本體訂閱，整條時間軸會每秒重渲染 ~60 次。
 */
function Timecode({ total }: { total: number }) {
  const time = usePlayback((s) => s.time);
  return (
    <span className="mono" style={{ color: 'var(--accent-text)', marginLeft: 4 }}>
      {fmt(time)} <span className="tag">/ {fmt(total)}</span>
    </span>
  );
}

/** ➕疊圖：選檔 → POST /assets → addOverlay（起點=playhead、3 秒、頂部置中）→ 選取 */
async function addOverlayFile(file: File): Promise<void> {
  const res = await fetch(`/assets?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: await file.arrayBuffer(),
  });
  if (!res.ok) return;
  const { relPath } = (await res.json()) as { relPath: string };
  const id = `ov_${Math.random().toString(36).slice(2, 10)}`;
  sendCommand({
    name: 'addOverlay',
    overlay: {
      id,
      imagePath: relPath,
      start: Number(usePlayback.getState().time.toFixed(3)),
      duration: 3,
      position: { x: 0.5, y: 0.1, scale: 1 },
    },
  });
  useSelection.getState().select({ kind: 'overlay', id });
}

/** 時間軸工具列：transport＋時間碼（左）／疊圖上傳＋縮放＋吸附（右） */
export function TimelineToolbar({ total, onFit }: { total: number; onFit: () => void }) {
  const playing = usePlayback((s) => s.playing);
  const snapEnabled = useView((s) => s.snapEnabled);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 4px 8px',
        fontSize: 11,
        color: 'var(--text-2)',
      }}
    >
      <button
        className="icon-btn"
        onClick={() => usePlayback.getState().seek(0)}
        title="Jump to start"
      >
        <SkipBack size={14} />
      </button>
      <button
        className="icon-btn"
        onClick={() => (playing ? usePlayback.getState().pause() : usePlayback.getState().play())}
        title="Play/Pause (Space)"
        style={{ padding: '6px 12px' }}
      >
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <button
        className="icon-btn"
        onClick={() => usePlayback.getState().seek(total)}
        title="Jump to end"
      >
        <SkipForward size={14} />
      </button>
      <Timecode total={total} />

      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
        <label
          className="icon-btn"
          title="Upload an image onto the overlay track (starts at playhead)"
          style={{ cursor: 'pointer' }}
        >
          <ImagePlus size={14} /> Overlay
          <input
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void addOverlayFile(f);
              e.target.value = '';
            }}
          />
        </label>
        <button
          className="icon-btn"
          title="Add a text overlay at playhead"
          onClick={() => {
            const id = `ovtext_${Math.random().toString(36).slice(2, 8)}`;
            sendCommand({
              name: 'addOverlay',
              overlay: {
                id,
                imagePath: '',
                text: {
                  text: 'New text',
                  fontFamily: 'Heiti TC',
                  fontSize: 64,
                  fill: '#ffffff',
                  stroke: '#000000',
                },
                start: usePlayback.getState().time,
                duration: 3,
                position: { x: 0.5, y: 0.4, scale: 1 },
              },
            });
            useSelection.getState().select({ kind: 'overlay', id });
          }}
        >
          <Type size={14} /> Text
        </button>
        <button
          className="icon-btn"
          onClick={() => useView.getState().zoomBy(1 / 1.4)}
          title="Zoom out (Ctrl+wheel)"
        >
          <ZoomOut size={14} />
        </button>
        <button
          className="icon-btn"
          onClick={() => useView.getState().zoomBy(1.4)}
          title="Zoom in (Ctrl+wheel)"
        >
          <ZoomIn size={14} />
        </button>
        <button className="icon-btn" onClick={onFit} title="Fit timeline (Shift+Z)">
          <Maximize2 size={14} />
        </button>
        <button
          className={`icon-btn seg${snapEnabled ? ' on' : ''}`}
          onClick={() => useView.getState().toggleSnap()}
          title="Toggle snapping (N)"
        >
          <Magnet size={14} /> Snap
        </button>
      </span>
    </div>
  );
}
