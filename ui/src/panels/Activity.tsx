import { Undo2 } from 'lucide-react';
import { useActivity } from '../stores/activity.js';
import { sendCommand } from '../ws.js';

/** 活動記錄面板：每筆 mutation（AI/人分色）+ undo 按鈕。這是「human watches」的主介面。 */
export function Activity() {
  const entries = useActivity((s) => s.entries);
  const recent = [...entries].reverse().slice(0, 40);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: 8,
          borderBottom: '1px solid var(--line)',
        }}
      >
        <button
          className="icon-btn"
          onClick={() => sendCommand({ name: 'undo', steps: 1 })}
          title="Cmd+Z"
        >
          <Undo2 size={13} /> Undo
        </button>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, padding: 8, fontSize: 12 }}>
        {recent.length === 0 && <div style={{ color: 'var(--text-3)' }}>No changes yet</div>}
        {recent.map((e) => (
          <div
            key={e.version}
            className={Date.now() - Date.parse(e.ts) < 3000 ? 'fx-slidein' : undefined}
            style={{
              display: 'flex',
              gap: 6,
              padding: '2px 0',
              color: e.source === 'ai' ? '#c4b5fd' : 'var(--audio-bright)',
            }}
          >
            <span style={{ opacity: 0.6, minWidth: 28 }}>v{e.version}</span>
            <span style={{ minWidth: 30, opacity: 0.7 }}>{e.source === 'ai' ? 'AI' : 'You'}</span>
            <span>{e.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
