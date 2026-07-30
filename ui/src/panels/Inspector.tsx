import { type ChangeEvent } from 'react';
import type { AudioItem, Command } from '@vidcut/shared';

type AudioPatch = Partial<
  Pick<AudioItem, 'start' | 'in' | 'duration' | 'volume' | 'fadeIn' | 'fadeOut' | 'ducking'>
>;
import { useProject } from '../stores/project.js';
import { useSelection } from '../stores/selection.js';
import { usePlayback } from '../stores/playback.js';
import { sendCommand } from '../ws.js';

const labelStyle = { display: 'block', fontSize: 12, color: '#aaa', marginTop: 8 };
const inputStyle = {
  width: '100%',
  padding: 4,
  background: '#222',
  color: '#eee',
  border: '1px solid #444',
  borderRadius: 3,
};

function num(e: ChangeEvent<HTMLInputElement>): number {
  return Number(e.target.value);
}

/** 畫布填充模式切換（9:16 放橫素材時 blur 比黑邊好看）。 */
function CanvasFitRow() {
  const fit = useProject((s) => s.doc?.canvas.fit ?? 'contain');
  return (
    <div style={{ padding: 12, borderBottom: '1px solid #333' }}>
      <label style={{ ...labelStyle, marginTop: 0 }}>畫布填充（未填滿時）</label>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        {(['contain', 'blur'] as const).map((f) => (
          <button
            key={f}
            onClick={() => sendCommand({ name: 'setCanvasFit', fit: f })}
            style={{
              flex: 1,
              padding: '4px 6px',
              background: fit === f ? '#4af' : '#222',
              color: fit === f ? '#000' : '#ccc',
              border: '1px solid #444',
              borderRadius: 3,
            }}
          >
            {f === 'contain' ? '黑邊' : '模糊填充'}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Inspector() {
  const doc = useProject((s) => s.doc);
  const selected = useSelection((s) => s.selected);
  if (!doc) return null;
  if (!selected) {
    return (
      <div>
        <CanvasFitRow />
        <div style={{ padding: 12, color: '#777', fontSize: 13 }}>
          選一個片段 / 字幕 / overlay / 音訊來編輯
          <div style={{ marginTop: 12, lineHeight: 1.8, fontSize: 12 }}>
            <div style={{ color: '#999' }}>快捷鍵</div>
            空白 播放/暫停 · S 分割 · Q 刪左 · W 刪右
            <br />F 定格 · N 吸附 · Shift+Z 全覽 · ←/→ 逐幀
            <br />
            Ctrl+滾輪 縮放 · Cmd+Z 復原
          </div>
        </div>
      </div>
    );
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
          onChange={(e) =>
            send({ name: 'updateClip', clipId: clip.id, patch: { label: e.target.value } })
          }
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
          onChange={(e) =>
            send({ name: 'updateClip', clipId: clip.id, patch: { duration: num(e) } })
          }
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
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
          <button
            onClick={() => send({ name: 'splitAt', time: usePlayback.getState().time })}
            title="S"
          >
            ✂ 分割
          </button>
          <button
            onClick={() => send({ name: 'freezeFrame', time: usePlayback.getState().time })}
            title="F"
          >
            ❄ 定格
          </button>
          <button onClick={() => send({ name: 'extractAudio', clipId: clip.id })}>
            🔊 抽出聲音
          </button>
          <button
            style={{ color: '#f66' }}
            onClick={() => {
              send({ name: 'removeClip', clipId: clip.id });
              useSelection.getState().select(null);
            }}
          >
            刪除片段
          </button>
        </div>
      </div>
    );
  }

  if (selected.kind === 'audio') {
    const a = doc.tracks.audio.find((x) => x.id === selected.id);
    if (!a) return null;
    const upd = (patch: AudioPatch) => send({ name: 'updateAudio', id: a.id, patch });
    return (
      <div style={{ padding: 12 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>音訊 {a.label ?? a.mediaId}</h3>
        <label style={labelStyle}>時間軸起點（秒）</label>
        <input
          type="number"
          step="0.1"
          style={inputStyle}
          value={a.start}
          onChange={(e) => upd({ start: num(e) })}
        />
        <label style={labelStyle}>來源起點 in（秒）</label>
        <input
          type="number"
          step="0.1"
          style={inputStyle}
          value={a.in}
          onChange={(e) => upd({ in: num(e) })}
        />
        <label style={labelStyle}>長度（秒）</label>
        <input
          type="number"
          step="0.1"
          style={inputStyle}
          value={a.duration}
          onChange={(e) => upd({ duration: num(e) })}
        />
        <label style={labelStyle}>音量（0–2）</label>
        <input
          type="number"
          step="0.1"
          min="0"
          max="2"
          style={inputStyle}
          value={a.volume}
          onChange={(e) => upd({ volume: num(e) })}
        />
        <label style={labelStyle}>淡入（秒）</label>
        <input
          type="number"
          step="0.1"
          min="0"
          style={inputStyle}
          value={a.fadeIn ?? 0}
          onChange={(e) => upd({ fadeIn: num(e) })}
        />
        <label style={labelStyle}>淡出（秒）</label>
        <input
          type="number"
          step="0.1"
          min="0"
          style={inputStyle}
          value={a.fadeOut ?? 0}
          onChange={(e) => upd({ fadeOut: num(e) })}
        />
        <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={a.ducking === true}
            onChange={(e) => upd({ ducking: e.target.checked })}
          />
          播放時壓低影片原聲（ducking）
        </label>
        <button
          style={{ marginTop: 12, color: '#f66' }}
          onClick={() => {
            send({ name: 'removeAudio', id: a.id });
            useSelection.getState().select(null);
          }}
        >
          刪除音訊
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
          onChange={(e) =>
            send({ name: 'updateCaption', id: cap.id, patch: { text: e.target.value } })
          }
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
            send({
              name: 'updateCaption',
              id: cap.id,
              patch: { style: { ...cap.style, fontSize: num(e) } },
            })
          }
        />
        <label style={labelStyle}>顏色</label>
        <input
          type="color"
          style={inputStyle}
          value={cap.style.fill}
          onChange={(e) =>
            send({
              name: 'updateCaption',
              id: cap.id,
              patch: { style: { ...cap.style, fill: e.target.value } },
            })
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
            send({
              name: 'updateCaption',
              id: cap.id,
              patch: { style: { ...cap.style, y: num(e) } },
            })
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
          send({
            name: 'updateOverlay',
            id: ov.id,
            patch: { position: { ...ov.position, x: num(e) } },
          })
        }
      />
      <label style={labelStyle}>y（0–1）</label>
      <input
        type="number"
        step="0.05"
        style={inputStyle}
        value={ov.position.y}
        onChange={(e) =>
          send({
            name: 'updateOverlay',
            id: ov.id,
            patch: { position: { ...ov.position, y: num(e) } },
          })
        }
      />
      <label style={labelStyle}>縮放</label>
      <input
        type="number"
        step="0.1"
        style={inputStyle}
        value={ov.position.scale}
        onChange={(e) =>
          send({
            name: 'updateOverlay',
            id: ov.id,
            patch: { position: { ...ov.position, scale: num(e) } },
          })
        }
      />
    </div>
  );
}
