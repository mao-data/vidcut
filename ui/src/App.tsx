import { useEffect } from 'react';
import { useProject } from './stores/project.js';
import { useToast } from './stores/toast.js';
import { useSelection } from './stores/selection.js';
import { usePlayback } from './stores/playback.js';
import { Player } from './player/Player.js';
import { Timeline } from './timeline/Timeline.js';
import { Inspector } from './panels/Inspector.js';
import { Activity } from './panels/Activity.js';
import { ReviewBar } from './panels/ReviewBar.js';
import { sendCommand, sendContext } from './ws.js';

function Toast() {
  const message = useToast((s) => s.message);
  const clear = useToast((s) => s.clear);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(clear, 3500);
    return () => clearTimeout(t);
  }, [message, clear]);
  if (!message) return null;
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        background: '#832',
        color: '#fff',
        padding: '8px 16px',
        borderRadius: 6,
        zIndex: 100,
      }}
    >
      {message}
    </div>
  );
}

export function App() {
  const doc = useProject((s) => s.doc);
  const version = useProject((s) => s.version);
  const connected = useProject((s) => s.connected);
  const selection = useSelection((s) => s.selected);
  const playhead = usePlayback((s) => s.time);

  // Cmd/Ctrl+Z → undo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        sendCommand({ name: 'undo', steps: 1 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 回報編輯脈絡給 AI（get_editor_context）。playhead 用防抖避免洗頻。
  useEffect(() => {
    const t = setTimeout(() => sendContext({ selection, playhead, range: null }), 150);
    return () => clearTimeout(t);
  }, [selection, playhead]);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '6px 12px', borderBottom: '1px solid #333', fontSize: 13 }}>
        {connected ? '🟢' : '🔴'} {doc?.name ?? '—'} v{version}
      </div>
      <ReviewBar />
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '260px 1fr 300px', minHeight: 0 }}>
        {/* 左：Inspector */}
        <div style={{ borderRight: '1px solid #333', overflowY: 'auto' }}>
          <Inspector />
        </div>
        {/* 中：預覽 */}
        <div style={{ overflowY: 'auto', padding: 12 }}>
          <Player />
        </div>
        {/* 右：活動 */}
        <div style={{ borderLeft: '1px solid #333' }}>
          <Activity />
        </div>
      </div>
      {/* 底：時間軸 */}
      <div style={{ borderTop: '1px solid #333', padding: 8 }}>
        <Timeline />
      </div>
      <Toast />
    </div>
  );
}
