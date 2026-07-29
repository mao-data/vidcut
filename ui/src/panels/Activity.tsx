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
          borderBottom: '1px solid #333',
        }}
      >
        <strong style={{ fontSize: 13 }}>活動</strong>
        <button onClick={() => sendCommand({ name: 'undo', steps: 1 })} title="Cmd+Z">
          ↶ 復原
        </button>
      </div>
      <div style={{ overflowY: 'auto', flex: 1, padding: 8, fontSize: 12 }}>
        {recent.length === 0 && <div style={{ color: '#777' }}>尚無變更</div>}
        {recent.map((e) => (
          <div
            key={e.version}
            style={{
              display: 'flex',
              gap: 6,
              padding: '2px 0',
              color: e.source === 'ai' ? '#8cf' : '#cec',
            }}
          >
            <span style={{ opacity: 0.6, minWidth: 28 }}>v{e.version}</span>
            <span style={{ minWidth: 30, opacity: 0.7 }}>{e.source === 'ai' ? 'AI' : '你'}</span>
            <span>{e.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
