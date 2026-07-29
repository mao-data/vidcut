import { type ChangeEvent } from 'react';
import type { Command } from '@vidcut/shared';
import { useProject } from '../stores/project.js';
import { useSelection } from '../stores/selection.js';
import { sendCommand } from '../ws.js';

const labelStyle = { display: 'block', fontSize: 12, color: '#aaa', marginTop: 8 };
const inputStyle = { width: '100%', padding: 4, background: '#222', color: '#eee', border: '1px solid #444', borderRadius: 3 };

function num(e: ChangeEvent<HTMLInputElement>): number {
  return Number(e.target.value);
}

export function Inspector() {
  const doc = useProject((s) => s.doc);
  const selected = useSelection((s) => s.selected);
  if (!doc || !selected) {
    return <div style={{ padding: 12, color: '#777', fontSize: 13 }}>選一個片段 / 字幕 / overlay 來編輯</div>;
  }

  const send = (cmd: Command) => sendCommand(cmd);

  if (selected.kind === 'clip') {
    const clip = doc.tracks.video.find((c) => c.id === selected.id);
    if (!clip) return null;
    return (
      <div style={{ padding: 12 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>片段 {clip.label ?? clip.id}</h3>
        <label style={labelStyle}>標題</label>
        <input
          style={inputStyle}
          value={clip.label ?? ''}
          onChange={(e) => send({ name: 'updateClip', clipId: clip.id, patch: { label: e.target.value } })}
        />
        <label style={labelStyle}>起點 in（秒）</label>
        <input
          type="number"
          step="0.1"
          style={inputStyle}
          value={clip.in}
          onChange={(e) => send({ name: 'updateClip', clipId: clip.id, patch: { in: num(e) } })}
        />
        <label style={labelStyle}>長度 duration（秒）</label>
        <input
          type="number"
          step="0.1"
          style={inputStyle}
          value={clip.duration}
          onChange={(e) => send({ name: 'updateClip', clipId: clip.id, patch: { duration: num(e) } })}
        />
        <label style={labelStyle}>音量（0–2）</label>
        <input
          type="number"
          step="0.1"
          min="0"
          max="2"
          style={inputStyle}
          value={clip.volume}
          onChange={(e) => send({ name: 'updateClip', clipId: clip.id, patch: { volume: num(e) } })}
        />
        <button
          style={{ marginTop: 12, color: '#f66' }}
          onClick={() => {
            send({ name: 'removeClip', clipId: clip.id });
            useSelection.getState().select(null);
          }}
        >
          刪除片段
        </button>
      </div>
    );
  }

  if (selected.kind === 'caption') {
    const cap = doc.tracks.captions.find((c) => c.id === selected.id);
    if (!cap) return null;
    return (
      <div style={{ padding: 12 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>字幕</h3>
        <label style={labelStyle}>文字</label>
        <textarea
          style={{ ...inputStyle, minHeight: 48 }}
          value={cap.text}
          onChange={(e) => send({ name: 'updateCaption', id: cap.id, patch: { text: e.target.value } })}
        />
        <label style={labelStyle}>起點（秒）</label>
        <input
          type="number"
          step="0.1"
          style={inputStyle}
          value={cap.start}
          onChange={(e) => send({ name: 'updateCaption', id: cap.id, patch: { start: num(e) } })}
        />
        <label style={labelStyle}>長度（秒）</label>
        <input
          type="number"
          step="0.1"
          style={inputStyle}
          value={cap.duration}
          onChange={(e) => send({ name: 'updateCaption', id: cap.id, patch: { duration: num(e) } })}
        />
        <label style={labelStyle}>字級</label>
        <input
          type="number"
          style={inputStyle}
          value={cap.style.fontSize}
          onChange={(e) =>
            send({ name: 'updateCaption', id: cap.id, patch: { style: { ...cap.style, fontSize: num(e) } } })
          }
        />
        <label style={labelStyle}>顏色</label>
        <input
          type="color"
          style={inputStyle}
          value={cap.style.fill}
          onChange={(e) =>
            send({ name: 'updateCaption', id: cap.id, patch: { style: { ...cap.style, fill: e.target.value } } })
          }
        />
        <label style={labelStyle}>垂直位置 y（0–1）</label>
        <input
          type="number"
          step="0.05"
          min="0"
          max="1"
          style={inputStyle}
          value={cap.style.y}
          onChange={(e) =>
            send({ name: 'updateCaption', id: cap.id, patch: { style: { ...cap.style, y: num(e) } } })
          }
        />
      </div>
    );
  }

  // overlay
  const ov = doc.tracks.overlays.find((o) => o.id === selected.id);
  if (!ov) return null;
  return (
    <div style={{ padding: 12 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>Overlay {ov.imagePath.split('/').pop()}</h3>
      <label style={labelStyle}>x（0–1）</label>
      <input
        type="number"
        step="0.05"
        style={inputStyle}
        value={ov.position.x}
        onChange={(e) =>
          send({ name: 'updateOverlay', id: ov.id, patch: { position: { ...ov.position, x: num(e) } } })
        }
      />
      <label style={labelStyle}>y（0–1）</label>
      <input
        type="number"
        step="0.05"
        style={inputStyle}
        value={ov.position.y}
        onChange={(e) =>
          send({ name: 'updateOverlay', id: ov.id, patch: { position: { ...ov.position, y: num(e) } } })
        }
      />
      <label style={labelStyle}>縮放</label>
      <input
        type="number"
        step="0.1"
        style={inputStyle}
        value={ov.position.scale}
        onChange={(e) =>
          send({ name: 'updateOverlay', id: ov.id, patch: { position: { ...ov.position, scale: num(e) } } })
        }
      />
    </div>
  );
}
