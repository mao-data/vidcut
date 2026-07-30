import { useEffect } from 'react';
import { useProject } from './stores/project.js';
import { useToast } from './stores/toast.js';
import { useSelection } from './stores/selection.js';
import { usePlayback } from './stores/playback.js';
import { useView } from './stores/view.js';
import { Player } from './player/Player.js';
import { Timeline } from './timeline/Timeline.js';
import { Inspector } from './panels/Inspector.js';
import { Activity } from './panels/Activity.js';
import { CaptionList } from './panels/CaptionList.js';
import { ReviewBar } from './panels/ReviewBar.js';
import { RenderBar } from './panels/RenderBar.js';
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

  // 編輯快捷鍵（CapCut 慣例）。在輸入框內打字時全部不作用。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;

      const mod = e.metaKey || e.ctrlKey;
      const at = usePlayback.getState().time;
      const key = e.key.toLowerCase();

      if (mod && key === 'z') {
        e.preventDefault();
        sendCommand({ name: 'undo', steps: 1 });
        return;
      }
      if (mod && key === 'b') {
        e.preventDefault();
        sendCommand({ name: 'splitAt', time: at });
        return;
      }
      if (mod) return; // 其餘帶修飾鍵的交給瀏覽器

      switch (key) {
        case ' ':
          e.preventDefault();
          if (usePlayback.getState().playing) usePlayback.getState().pause();
          else usePlayback.getState().play();
          break;
        case 's':
          e.preventDefault();
          sendCommand({ name: 'splitAt', time: at });
          break;
        case 'q':
          e.preventDefault();
          sendCommand({ name: 'deleteBefore', time: at });
          break;
        case 'w':
          e.preventDefault();
          sendCommand({ name: 'deleteAfter', time: at });
          break;
        case 'f':
          e.preventDefault();
          sendCommand({ name: 'freezeFrame', time: at });
          break;
        case 'n':
          e.preventDefault();
          useView.getState().toggleSnap();
          break;
        case 'z':
          if (e.shiftKey) {
            e.preventDefault();
            (window as unknown as { __vidcutFit?: () => void }).__vidcutFit?.();
          }
          break;
        case 'arrowleft':
        case 'arrowright': {
          e.preventDefault();
          const fps = useProject.getState().doc?.canvas.fps ?? 30;
          const step = (e.shiftKey ? 10 : 1) / fps;
          usePlayback.getState().seek(at + (key === 'arrowleft' ? -step : step));
          break;
        }
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
      <div
        style={{ flex: 1, display: 'grid', gridTemplateColumns: '260px 1fr 320px', minHeight: 0 }}
      >
        {/* 左：Inspector */}
        <div style={{ borderRight: '1px solid #333', overflowY: 'auto' }}>
          <Inspector />
        </div>
        {/* 中：預覽 */}
        <div style={{ overflowY: 'auto', padding: 12 }}>
          <Player />
        </div>
        {/* 右：字幕列表 + 活動（上下分割，兩者各自捲動） */}
        <div
          style={{
            borderLeft: '1px solid #333',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <div style={{ flex: '1.3 1 0', minHeight: 0, borderBottom: '1px solid #333' }}>
            <CaptionList />
          </div>
          <div style={{ flex: '1 1 0', minHeight: 0 }}>
            <Activity />
          </div>
        </div>
      </div>
      {/* 底：時間軸 + 渲染 */}
      <div style={{ borderTop: '1px solid #333', padding: 8 }}>
        <Timeline />
      </div>
      <RenderBar />
      <Toast />
    </div>
  );
}
