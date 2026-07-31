import { useState, type ChangeEvent } from 'react';
import { AudioWaveform, CircleHelp, Scissors, Snowflake, Trash2 } from 'lucide-react';
import type { AudioItem, Command } from '@vidcut/shared';

type AudioPatch = Partial<
  Pick<AudioItem, 'start' | 'in' | 'duration' | 'volume' | 'fadeIn' | 'fadeOut' | 'ducking'>
>;
import { useProject } from '../stores/project.js';
import { useSelection } from '../stores/selection.js';
import { usePlayback } from '../stores/playback.js';
import { sendCommand } from '../ws.js';

function num(e: ChangeEvent<HTMLInputElement>): number {
  return Number(e.target.value);
}

/** 畫布填充模式切換（9:16 放橫素材時 blur 比黑邊好看）。 */
function CanvasFitRow() {
  const fit = useProject((s) => s.doc?.canvas.fit ?? 'contain');
  return (
    <div style={{ padding: 12, borderBottom: '1px solid var(--line)' }}>
      <label className="field" style={{ marginTop: 0 }}>
        畫布填充（未填滿時）
      </label>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        {(['contain', 'blur'] as const).map((f) => (
          <button
            key={f}
            className={`seg${fit === f ? ' on' : ''}`}
            onClick={() => sendCommand({ name: 'setCanvasFit', fit: f })}
            style={{ flex: 1 }}
          >
            {f === 'contain' ? '黑邊' : '模糊填充'}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 快捷鍵表：收進「?」彈出層，省 Inspector 高度。 */
function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 12, position: 'relative' }}>
      <button className="icon-btn" onClick={() => setOpen((o) => !o)}>
        <CircleHelp size={14} /> 快捷鍵
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            zIndex: 20,
            width: 216,
            padding: 10,
            borderRadius: 'var(--r-ctl)',
            background: '#1a1d2e',
            border: '1px solid var(--line-strong)',
            boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
            lineHeight: 1.9,
            fontSize: 12,
            color: 'var(--text-2)',
          }}
        >
          空白 播放/暫停 · S 分割
          <br />Q 刪左 · W 刪右 · F 定格
          <br />N 吸附 · Shift+Z 全覽 · ←/→ 逐幀
          <br />
          Ctrl+滾輪 縮放 · Cmd+Z 復原
        </div>
      )}
    </div>
  );
}

export function Inspector() {
  const doc = useProject((s) => s.doc);
  const selected = useSelection((s) => s.selected);
  if (!doc) return null;
  if (!selected) {
    return (
      <div className="form">
        <CanvasFitRow />
        <div style={{ padding: 12, color: 'var(--text-3)', fontSize: 12 }}>
          選一個片段 / 字幕 / overlay / 音訊來編輯
          <ShortcutHelp />
        </div>
      </div>
    );
  }

  const send = (cmd: Command) => sendCommand(cmd);

  if (selected.kind === 'clip') {
    const clip = doc.tracks.video.find((c) => c.id === selected.id);
    if (!clip) return null;
    return (
      <div className="form" style={{ padding: 12 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>片段 {clip.label ?? clip.id}</h3>
        <label className="field">標題</label>
        <input
          value={clip.label ?? ''}
          onChange={(e) =>
            send({ name: 'updateClip', clipId: clip.id, patch: { label: e.target.value } })
          }
        />
        <label className="field">起點 in（秒）</label>
        <input
          type="number"
          step="0.1"
          value={clip.in}
          onChange={(e) => send({ name: 'updateClip', clipId: clip.id, patch: { in: num(e) } })}
        />
        <label className="field">長度 duration（秒）</label>
        <input
          type="number"
          step="0.1"
          value={clip.duration}
          onChange={(e) =>
            send({ name: 'updateClip', clipId: clip.id, patch: { duration: num(e) } })
          }
        />
        <label className="field">音量（0–2）</label>
        <input
          type="number"
          step="0.1"
          min="0"
          max="2"
          value={clip.volume}
          onChange={(e) => send({ name: 'updateClip', clipId: clip.id, patch: { volume: num(e) } })}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
          <button
            className="icon-btn"
            onClick={() => send({ name: 'splitAt', time: usePlayback.getState().time })}
            title="S"
          >
            <Scissors size={13} /> 分割
          </button>
          <button
            className="icon-btn"
            onClick={() => send({ name: 'freezeFrame', time: usePlayback.getState().time })}
            title="F"
          >
            <Snowflake size={13} /> 定格
          </button>
          <button
            className="icon-btn"
            onClick={() => send({ name: 'extractAudio', clipId: clip.id })}
          >
            <AudioWaveform size={13} /> 抽出聲音
          </button>
          <button
            className="btn-danger icon-btn"
            onClick={() => {
              send({ name: 'removeClip', clipId: clip.id });
              useSelection.getState().select(null);
            }}
          >
            <Trash2 size={13} /> 刪除片段
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
      <div className="form" style={{ padding: 12 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>音訊 {a.label ?? a.mediaId}</h3>
        <label className="field">時間軸起點（秒）</label>
        <input type="number" step="0.1" value={a.start} onChange={(e) => upd({ start: num(e) })} />
        <label className="field">來源起點 in（秒）</label>
        <input type="number" step="0.1" value={a.in} onChange={(e) => upd({ in: num(e) })} />
        <label className="field">長度（秒）</label>
        <input
          type="number"
          step="0.1"
          value={a.duration}
          onChange={(e) => upd({ duration: num(e) })}
        />
        <label className="field">音量（0–2）</label>
        <input
          type="number"
          step="0.1"
          min="0"
          max="2"
          value={a.volume}
          onChange={(e) => upd({ volume: num(e) })}
        />
        <label className="field">淡入（秒）</label>
        <input
          type="number"
          step="0.1"
          min="0"
          value={a.fadeIn ?? 0}
          onChange={(e) => upd({ fadeIn: num(e) })}
        />
        <label className="field">淡出（秒）</label>
        <input
          type="number"
          step="0.1"
          min="0"
          value={a.fadeOut ?? 0}
          onChange={(e) => upd({ fadeOut: num(e) })}
        />
        <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={a.ducking === true}
            onChange={(e) => upd({ ducking: e.target.checked })}
          />
          播放時壓低影片原聲（ducking）
        </label>
        <button
          className="btn-danger icon-btn"
          style={{ marginTop: 12 }}
          onClick={() => {
            send({ name: 'removeAudio', id: a.id });
            useSelection.getState().select(null);
          }}
        >
          <Trash2 size={13} /> 刪除音訊
        </button>
      </div>
    );
  }

  if (selected.kind === 'caption') {
    const cap = doc.tracks.captions.find((c) => c.id === selected.id);
    if (!cap) return null;
    return (
      <div className="form" style={{ padding: 12 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>字幕</h3>
        <label className="field">文字</label>
        <textarea
          style={{ minHeight: 48 }}
          value={cap.text}
          onChange={(e) =>
            send({ name: 'updateCaption', id: cap.id, patch: { text: e.target.value } })
          }
        />
        <label className="field">起點（秒）</label>
        <input
          type="number"
          step="0.1"
          value={cap.start}
          onChange={(e) => send({ name: 'updateCaption', id: cap.id, patch: { start: num(e) } })}
        />
        <label className="field">長度（秒）</label>
        <input
          type="number"
          step="0.1"
          value={cap.duration}
          onChange={(e) => send({ name: 'updateCaption', id: cap.id, patch: { duration: num(e) } })}
        />
        <label className="field">字級</label>
        <input
          type="number"
          value={cap.style.fontSize}
          onChange={(e) =>
            send({
              name: 'updateCaption',
              id: cap.id,
              patch: { style: { ...cap.style, fontSize: num(e) } },
            })
          }
        />
        <label className="field">顏色</label>
        <input
          type="color"
          value={cap.style.fill}
          onChange={(e) =>
            send({
              name: 'updateCaption',
              id: cap.id,
              patch: { style: { ...cap.style, fill: e.target.value } },
            })
          }
        />
        <label className="field">垂直位置 y（0–1）</label>
        <input
          type="number"
          step="0.05"
          min="0"
          max="1"
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
    <div className="form" style={{ padding: 12 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>Overlay {ov.imagePath.split('/').pop()}</h3>
      {ov.anchor ? (
        <>
          <label className="field">
            錨定於片段（offset 秒，跟著片段走）：
            {doc.tracks.video.find((c) => c.id === ov.anchor!.clipId)?.label ?? ov.anchor.clipId}
          </label>
          <input
            type="number"
            step="0.1"
            min="0"
            value={ov.anchor.offset}
            onChange={(e) =>
              send({
                name: 'updateOverlay',
                id: ov.id,
                patch: { anchor: { clipId: ov.anchor!.clipId, offset: num(e) } },
              })
            }
          />
        </>
      ) : (
        <>
          <label className="field">開始時間（秒）</label>
          <input
            type="number"
            step="0.1"
            min="0"
            value={ov.start ?? 0}
            onChange={(e) => send({ name: 'updateOverlay', id: ov.id, patch: { start: num(e) } })}
          />
        </>
      )}
      <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="checkbox"
          checked={ov.duration === null}
          onChange={(e) =>
            send({
              name: 'updateOverlay',
              id: ov.id,
              patch: { duration: e.target.checked ? null : 3 },
            })
          }
        />
        顯示到片尾
      </label>
      {ov.duration !== null && (
        <>
          <label className="field">長度（秒）</label>
          <input
            type="number"
            step="0.1"
            min="0.1"
            value={ov.duration}
            onChange={(e) =>
              send({ name: 'updateOverlay', id: ov.id, patch: { duration: num(e) } })
            }
          />
        </>
      )}
      <label className="field">x（0–1）</label>
      <input
        type="number"
        step="0.05"
        value={ov.position.x}
        onChange={(e) =>
          send({
            name: 'updateOverlay',
            id: ov.id,
            patch: { position: { ...ov.position, x: num(e) } },
          })
        }
      />
      <label className="field">y（0–1）</label>
      <input
        type="number"
        step="0.05"
        value={ov.position.y}
        onChange={(e) =>
          send({
            name: 'updateOverlay',
            id: ov.id,
            patch: { position: { ...ov.position, y: num(e) } },
          })
        }
      />
      <label className="field">縮放</label>
      <input
        type="number"
        step="0.1"
        value={ov.position.scale}
        onChange={(e) =>
          send({
            name: 'updateOverlay',
            id: ov.id,
            patch: { position: { ...ov.position, scale: num(e) } },
          })
        }
      />
      <button
        className="btn-danger icon-btn"
        style={{ marginTop: 12 }}
        onClick={() => {
          send({ name: 'removeOverlay', id: ov.id });
          useSelection.getState().select(null);
        }}
      >
        <Trash2 size={13} /> 刪除疊圖
      </button>
    </div>
  );
}
