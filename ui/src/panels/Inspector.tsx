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
        Canvas fill (when not covered)
      </label>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        {(['contain', 'blur'] as const).map((f) => (
          <button
            key={f}
            className={`seg${fit === f ? ' on' : ''}`}
            onClick={() => sendCommand({ name: 'setCanvasFit', fit: f })}
            style={{ flex: 1 }}
          >
            {f === 'contain' ? 'Letterbox' : 'Blur fill'}
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
        <CircleHelp size={14} /> Shortcuts
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
          Space Play/Pause · S Split
          <br />Q Delete left · W Delete right · F Freeze
          <br />N Snap · Shift+Z Fit · ←/→ Frame step
          <br />
          Ctrl+wheel Zoom · Cmd+Z Undo
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
          Select a clip / caption / overlay / audio to edit
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
        <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>Clip {clip.label ?? clip.id}</h3>
        <label className="field">Label</label>
        <input
          value={clip.label ?? ''}
          onChange={(e) =>
            send({ name: 'updateClip', clipId: clip.id, patch: { label: e.target.value } })
          }
        />
        <label className="field">Source in (s)</label>
        <input
          type="number"
          step="0.1"
          value={clip.in}
          onChange={(e) => send({ name: 'updateClip', clipId: clip.id, patch: { in: num(e) } })}
        />
        <label className="field">Duration (s)</label>
        <input
          type="number"
          step="0.1"
          value={clip.duration}
          onChange={(e) =>
            send({ name: 'updateClip', clipId: clip.id, patch: { duration: num(e) } })
          }
        />
        <label className="field">Volume (0–2)</label>
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
            <Scissors size={13} /> Split
          </button>
          <button
            className="icon-btn"
            onClick={() => send({ name: 'freezeFrame', time: usePlayback.getState().time })}
            title="F"
          >
            <Snowflake size={13} /> Freeze
          </button>
          <button
            className="icon-btn"
            onClick={() => send({ name: 'extractAudio', clipId: clip.id })}
          >
            <AudioWaveform size={13} /> Extract audio
          </button>
          <button
            className="btn-danger icon-btn"
            onClick={() => {
              send({ name: 'removeClip', clipId: clip.id });
              useSelection.getState().select(null);
            }}
          >
            <Trash2 size={13} /> Delete clip
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
        <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>Audio {a.label ?? a.mediaId}</h3>
        <label className="field">Timeline start (s)</label>
        <input type="number" step="0.1" value={a.start} onChange={(e) => upd({ start: num(e) })} />
        <label className="field">Source in (s)</label>
        <input type="number" step="0.1" value={a.in} onChange={(e) => upd({ in: num(e) })} />
        <label className="field">Duration (s)</label>
        <input
          type="number"
          step="0.1"
          value={a.duration}
          onChange={(e) => upd({ duration: num(e) })}
        />
        <label className="field">Volume (0–2)</label>
        <input
          type="number"
          step="0.1"
          min="0"
          max="2"
          value={a.volume}
          onChange={(e) => upd({ volume: num(e) })}
        />
        <label className="field">Fade in (s)</label>
        <input
          type="number"
          step="0.1"
          min="0"
          value={a.fadeIn ?? 0}
          onChange={(e) => upd({ fadeIn: num(e) })}
        />
        <label className="field">Fade out (s)</label>
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
          Duck the video track while this plays
        </label>
        <button
          className="btn-danger icon-btn"
          style={{ marginTop: 12 }}
          onClick={() => {
            send({ name: 'removeAudio', id: a.id });
            useSelection.getState().select(null);
          }}
        >
          <Trash2 size={13} /> Delete audio
        </button>
      </div>
    );
  }

  if (selected.kind === 'caption') {
    const cap = doc.tracks.captions.find((c) => c.id === selected.id);
    if (!cap) return null;
    return (
      <div className="form" style={{ padding: 12 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>Caption</h3>
        <label className="field">Text</label>
        <textarea
          style={{ minHeight: 48 }}
          value={cap.text}
          onChange={(e) =>
            send({ name: 'updateCaption', id: cap.id, patch: { text: e.target.value } })
          }
        />
        <label className="field">Start (s)</label>
        <input
          type="number"
          step="0.1"
          value={cap.start}
          onChange={(e) => send({ name: 'updateCaption', id: cap.id, patch: { start: num(e) } })}
        />
        <label className="field">Duration (s)</label>
        <input
          type="number"
          step="0.1"
          value={cap.duration}
          onChange={(e) => send({ name: 'updateCaption', id: cap.id, patch: { duration: num(e) } })}
        />
        <label className="field">Font size</label>
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
        <label className="field">Color</label>
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
        <label className="field">Vertical position y (0–1)</label>
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
            Anchored to clip (offset in s; follows the clip):
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
          <label className="field">Start time (s)</label>
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
        Show until end
      </label>
      {ov.duration !== null && (
        <>
          <label className="field">Duration (s)</label>
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
      <label className="field">Scale</label>
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
        <Trash2 size={13} /> Delete overlay
      </button>
    </div>
  );
}
