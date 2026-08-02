import { useEffect, useRef, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { gsap, useGSAP, motionOK } from './motion.js';
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
import { ExportMenu } from './panels/ExportMenu.js';
import { PanelResizer } from './PanelResizer.js';
import { sendCommand, sendContext } from './ws.js';

function Toast() {
  const message = useToast((s) => s.message);
  const clear = useToast((s) => s.clear);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(clear, 3500);
    return () => clearTimeout(t);
  }, [message, clear]);
  // 每次訊息更換都重播進場（浮起）
  useGSAP(
    () => {
      if (ref.current && motionOK()) {
        gsap.from(ref.current, { y: 12, opacity: 0, duration: 0.3, ease: 'power2.out' });
      }
    },
    { scope: ref, dependencies: [message] },
  );
  if (!message) return null;
  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        background: '#2a1620',
        border: '1px solid rgba(248,113,113,0.4)',
        color: 'var(--text-1)',
        padding: '8px 16px',
        borderRadius: 'var(--r-ctl)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
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
  const leftOpen = useView((s) => s.leftOpen);
  const rightOpen = useView((s) => s.rightOpen);
  const leftWidth = useView((s) => s.leftWidth);
  const rightWidth = useView((s) => s.rightWidth);
  const gridRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);
  const [tab, setTab] = useState<'captions' | 'activity'>('captions');
  const captionCount = doc?.tracks.captions.length ?? 0;
  const tabBodyRef = useRef<HTMLDivElement>(null);

  // 分頁切換：內容 fade + 8px slide
  useGSAP(
    () => {
      if (tabBodyRef.current && motionOK()) {
        gsap.fromTo(
          tabBodyRef.current,
          { opacity: 0, x: 8 },
          { opacity: 1, x: 0, duration: 0.2, ease: 'power2.out' },
        );
      }
    },
    { scope: tabBodyRef, dependencies: [tab] },
  );

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
  // 直接訂 store、不經 React state：playhead 播放中每幀都變，
  // 若用 hook 訂閱會讓整棵 App 樹每幀重渲染。
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (t) clearTimeout(t);
      t = setTimeout(
        () =>
          sendContext({
            selection: useSelection.getState().selected,
            playhead: usePlayback.getState().time,
            range: null,
          }),
        150,
      );
    };
    schedule();
    const unTime = usePlayback.subscribe((s, prev) => {
      if (s.time !== prev.time) schedule();
    });
    const unSel = useSelection.subscribe((s, prev) => {
      if (s.selected !== prev.selected) schedule();
    });
    return () => {
      if (t) clearTimeout(t);
      unTime();
      unSel();
    };
  }, []);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* 頂欄：品牌 / 專案 / 連線 / 匯出 */}
      <header
        className="glass"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '7px 14px',
          position: 'relative',
          zIndex: 30,
        }}
      >
        <b
          style={{
            fontSize: 15,
            background: 'linear-gradient(90deg, #a78bfa, #60a5fa)',
            WebkitBackgroundClip: 'text',
            color: 'transparent',
          }}
        >
          vidcut
        </b>
        <span className="tag">
          {doc?.name ?? '—'} · v{version}
        </span>
        <span className="tag" style={{ marginLeft: 'auto' }}>
          <span style={{ color: connected ? 'var(--ok)' : 'var(--danger)' }}>●</span>{' '}
          {connected ? 'Connected' : 'Offline'}
        </span>
        <ExportMenu />
      </header>

      {/* 內容區：審核條 overlay 蓋在上面，不擠壓版面 */}
      <div
        style={{
          position: 'relative',
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <ReviewBar />
        <div
          ref={gridRef}
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: `${leftOpen ? `${leftWidth}px` : '0px'} 1fr ${rightOpen ? `${rightWidth}px` : '0px'}`,
            minHeight: 0,
            // 拖曳伸縮中關掉過渡（不然黏手）；收合/展開仍有動畫
            transition: resizing ? 'none' : 'grid-template-columns 0.25s ease',
          }}
        >
          {/* 左：屬性（外層 hidden、內層固定寬 → 收合時內容不變形） */}
          <div
            style={{ overflow: 'hidden', borderRight: leftOpen ? '1px solid var(--line)' : 'none' }}
          >
            <div style={{ width: leftWidth, height: '100%', overflowY: 'auto' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '8px 12px 0',
                }}
              >
                <span className="panel-head">Properties</span>
                <button
                  className="icon-btn"
                  onClick={() => useView.getState().toggleLeft()}
                  title="Collapse properties panel"
                  style={{ marginLeft: 'auto', padding: '3px 5px' }}
                >
                  <PanelLeftClose size={14} />
                </button>
              </div>
              <Inspector />
            </div>
          </div>

          {/* 中：預覽。外層不捲動、只當定位基準；捲動交給內層。
              展開鈕與伸縮把手掛在外層——放進捲動容器的話會跟著內容捲走。 */}
          <div style={{ position: 'relative', minHeight: 0 }}>
            {leftOpen && (
              <PanelResizer side="left" gridRef={gridRef} onResizingChange={setResizing} />
            )}
            {rightOpen && (
              <PanelResizer side="right" gridRef={gridRef} onResizingChange={setResizing} />
            )}
            {!leftOpen && (
              <button
                className="icon-btn"
                onClick={() => useView.getState().toggleLeft()}
                title="Expand properties panel"
                style={{
                  position: 'absolute',
                  left: 4,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  zIndex: 5,
                }}
              >
                <PanelLeftOpen size={14} />
              </button>
            )}
            {!rightOpen && (
              <button
                className="icon-btn"
                onClick={() => useView.getState().toggleRight()}
                title="Expand captions/activity panel"
                style={{
                  position: 'absolute',
                  right: 4,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  zIndex: 5,
                }}
              >
                <PanelRightOpen size={14} />
              </button>
            )}
            <div style={{ height: '100%', overflowY: 'auto', padding: 12 }}>
              <Player />
            </div>
          </div>

          {/* 右：字幕 ⇄ 活動分頁 */}
          <div
            style={{ overflow: 'hidden', borderLeft: rightOpen ? '1px solid var(--line)' : 'none' }}
          >
            <div
              style={{
                width: rightWidth,
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '8px 10px',
                  borderBottom: '1px solid var(--line)',
                }}
              >
                <button
                  className={`seg${tab === 'captions' ? ' on' : ''}`}
                  onClick={() => setTab('captions')}
                >
                  Captions {captionCount > 0 && <span className="badge">{captionCount}</span>}
                </button>
                <button
                  className={`seg${tab === 'activity' ? ' on' : ''}`}
                  onClick={() => setTab('activity')}
                >
                  Activity
                </button>
                <button
                  className="icon-btn"
                  onClick={() => useView.getState().toggleRight()}
                  title="Collapse"
                  style={{ marginLeft: 'auto', padding: '3px 5px' }}
                >
                  <PanelRightClose size={14} />
                </button>
              </div>
              <div ref={tabBodyRef} style={{ flex: 1, minHeight: 0 }}>
                {tab === 'captions' ? <CaptionList /> : <Activity />}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 底：時間軸 */}
      <div style={{ borderTop: '1px solid var(--line)', padding: 8 }}>
        <Timeline />
      </div>
      <Toast />
    </div>
  );
}
