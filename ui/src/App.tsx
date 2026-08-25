import { useEffect, useRef, useState } from 'react';
import { PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { clipStartTimes, overlayWindow } from '@vidcut/shared';
import { gsap, useGSAP, motionOK } from './motion.js';
import { useProject } from './stores/project.js';
import { useToast } from './stores/toast.js';
import { useSelection } from './stores/selection.js';
import { usePlayback } from './stores/playback.js';
import { useView } from './stores/view.js';
import { Player } from './player/Player.js';
import { Timeline } from './timeline/Timeline.js';
import { Inspector } from './panels/Inspector.js';
import { AgentPanel } from './panels/AgentPanel.js';
import { CaptionList } from './panels/CaptionList.js';
import { MediaPanel } from './panels/MediaPanel.js';
import { ReviewBar } from './panels/ReviewBar.js';
import { ExportMenu } from './panels/ExportMenu.js';
import { ThemeToggle } from './ThemeToggle.js';
import { PanelResizer } from './PanelResizer.js';
import { AgentStrip } from './AgentStrip.js';
import { trimIn, trimOut, trimSpanIn, trimSpanOut, trimAudioIn } from './timeline/dragMath.js';
import { sendCommand, sendContext } from './ws.js';

/**
 * Plan 11 Task 3（裁決 6）：`[`/`]` 鍵盤 trim 的實際邏輯——把目前選取項的 in/out
 * 邊修到 `playhead`，四種軌道各自的語意與拖曳把手放手時送出的命令完全一致（同一套
 * `dragMath` 純函數、同一種 clamp），只是**一次性**：不像拖曳要先算 `deltaSec =
 * pointerX 位移`，這裡直接用「playhead 相對邊界的絕對時間差」當 `deltaSec` 餵給
 * 同一批 `trimIn`/`trimOut`/`trimSpanIn`/`trimSpanOut`/`trimAudioIn`。
 *
 * 沒有選取項時整個函式是 no-op（呼叫端的四個分支各自的 `find` 落空就直接 return，
 * 不送任何命令）。
 */
function trimSelectedToPlayhead(edge: 'in' | 'out', playhead: number): void {
  const sel = useSelection.getState().selected;
  const doc = useProject.getState().doc;
  if (!sel || !doc) return;

  if (sel.kind === 'clip') {
    const index = doc.tracks.video.findIndex((c) => c.id === sel.id);
    const clip = doc.tracks.video[index];
    if (!clip) return;
    const clipStart = clipStartTimes(doc)[index]!;
    if (edge === 'in') {
      const deltaSec = playhead - clipStart;
      const { in: inSec, duration } = trimIn(clip, deltaSec);
      sendCommand({
        name: 'updateClip',
        clipId: clip.id,
        patch: { in: Number(inSec.toFixed(3)), duration: Number(duration.toFixed(3)) },
      });
    } else {
      const media = doc.media.find((m) => m.id === clip.mediaId);
      const mediaDur = media?.probe.duration ?? Infinity;
      const deltaSec = playhead - (clipStart + clip.duration);
      const { duration } = trimOut(clip, deltaSec, mediaDur);
      sendCommand({
        name: 'updateClip',
        clipId: clip.id,
        patch: { duration: Number(duration.toFixed(3)) },
      });
    }
    return;
  }

  if (sel.kind === 'caption') {
    const cap = doc.tracks.captions.find((c) => c.id === sel.id);
    if (!cap) return;
    if (edge === 'in') {
      const deltaSec = playhead - cap.start;
      const { start, duration } = trimSpanIn(cap, deltaSec);
      sendCommand({
        name: 'updateCaption',
        id: cap.id,
        patch: { start: Number(start.toFixed(3)), duration: Number(duration.toFixed(3)) },
      });
    } else {
      const deltaSec = playhead - (cap.start + cap.duration);
      const { duration } = trimSpanOut(cap, deltaSec);
      sendCommand({
        name: 'updateCaption',
        id: cap.id,
        patch: { duration: Number(duration.toFixed(3)) },
      });
    }
    return;
  }

  if (sel.kind === 'audio') {
    const a = doc.tracks.audio.find((x) => x.id === sel.id);
    if (!a) return;
    const media = doc.media.find((m) => m.id === a.mediaId);
    const mediaDur = media?.probe.duration ?? Infinity;
    if (edge === 'in') {
      const deltaSec = playhead - a.start;
      const { start, in: inSec, duration } = trimAudioIn(a, deltaSec);
      sendCommand({
        name: 'updateAudio',
        id: a.id,
        patch: {
          start: Number(start.toFixed(3)),
          in: Number(inSec.toFixed(3)),
          duration: Number(duration.toFixed(3)),
        },
      });
    } else {
      const deltaSec = playhead - (a.start + a.duration);
      const { duration } = trimSpanOut(a, deltaSec, mediaDur - a.in);
      sendCommand({
        name: 'updateAudio',
        id: a.id,
        patch: { duration: Number(duration.toFixed(3)) },
      });
    }
    return;
  }

  // overlay：與 Timeline.tsx 的 onPointerUp 'ov' 分支同款——絕對時間軌走 trimSpan
  // 系，anchor 模式的 in 把手要把結果換算回 offset（out 把手只改 duration，
  // anchor/offset 完全不動，語意見該處註解）。
  const o = doc.tracks.overlays.find((x) => x.id === sel.id);
  const win = o && overlayWindow(doc, o);
  if (!o || !win) return;
  const effectiveSpan = o.duration ?? win.end - win.start;
  if (edge === 'in') {
    const deltaSec = playhead - win.start;
    const { start: absStart, duration: span } = trimSpanIn(
      { start: win.start, duration: effectiveSpan },
      deltaSec,
    );
    const duration = o.duration === null ? null : Number(span.toFixed(3));
    if (o.anchor) {
      const idx = doc.tracks.video.findIndex((c) => c.id === o.anchor!.clipId);
      const clipStart = idx >= 0 ? clipStartTimes(doc)[idx]! : 0;
      const offset = Number((absStart - clipStart).toFixed(3));
      sendCommand({
        name: 'updateOverlay',
        id: o.id,
        patch:
          duration === null
            ? { anchor: { clipId: o.anchor.clipId, offset } }
            : { anchor: { clipId: o.anchor.clipId, offset }, duration },
      });
    } else {
      const start = Number(absStart.toFixed(3));
      sendCommand({
        name: 'updateOverlay',
        id: o.id,
        patch: duration === null ? { start } : { start, duration },
      });
    }
  } else {
    // out 緣：與 in 緣不對稱（範圍裁決 4，鏡射 Timeline.tsx onPointerUp 'ov'/'out'
    // 分支）——to-end overlay（o.duration===null）在這裡永遠**材料化**成具體數字，
    // 不是保持 null。review round 1 Important 1 抓到的錯誤：先前這裡沿用了 in 緣
    // 的「null 保護」，讓 `patch: { duration: null }` 送出去變成保證的 no-op
    // （updateOverlay 對 `undefined` 才是「不改」，`null` 是合法值、真的會把
    // duration 寫成 null——但既然算出來的 span 本來就是具體數字，寫 null 純粹是
    // 丟掉這次修剪結果，不是「維持 to-end」）。
    const deltaSec = playhead - (win.start + effectiveSpan);
    const { duration: span } = trimSpanOut({ duration: effectiveSpan }, deltaSec);
    sendCommand({ name: 'updateOverlay', id: o.id, patch: { duration: Number(span.toFixed(3)) } });
  }
}

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
      className="toast"
      style={{
        position: 'fixed',
        bottom: 16,
        left: '50%',
        background: 'var(--toast-danger-bg)',
        border: '1px solid rgba(248,113,113,0.4)',
        color: 'var(--text-1)',
        padding: '8px 16px',
        borderRadius: 'var(--r-ctl)',
        boxShadow: 'var(--shadow-toast)',
        zIndex: 100,
      }}
    >
      {message}
    </div>
  );
}

export function App() {
  const doc = useProject((s) => s.doc);
  const leftOpen = useView((s) => s.leftOpen);
  const rightOpen = useView((s) => s.rightOpen);
  const leftWidth = useView((s) => s.leftWidth);
  const rightWidth = useView((s) => s.rightWidth);
  const gridRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);
  const [tab, setTab] = useState<'media' | 'captions' | 'properties'>('captions');
  const selected = useSelection((s) => s.selected);
  const captionCount = doc?.tracks.captions.length ?? 0;
  const mediaCount = doc?.media.length ?? 0;
  const tabBodyRef = useRef<HTMLDivElement>(null);

  /**
   * 選了東西就跳到 Properties 分頁（2026-08-16 版面定案）。
   *
   * 這是舊版面「點一個 clip → 左欄自己變成那個東西的表單」那條反射的直譯：
   * 表單搬進右欄的分頁之後，沒有這一跳的話使用者點了 clip 卻停在 Captions 上，
   * 看起來像「點了沒反應」。連帶把右欄展開——跳到一個收合起來的分頁等於沒跳。
   *
   * **取消選取不自動跳走**（`selected` 變 null 時什麼都不做）：那是使用者按 Esc
   * 或點時間軸空白處的結果，把他從正在看的分頁上彈開是第二次沒要求的動作。
   * Properties 分頁自己會顯示閒置提示。
   */
  useEffect(() => {
    if (!selected) return;
    setTab('properties');
    useView.getState().openRight();
  }, [selected]);

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
  // 顯示用的鍵位表在 `shortcuts.ts`（Inspector 的 Shortcuts 彈出層由它生成）。
  // 這裡是行為的唯一來源，那裡是說明的唯一來源，兩者沒有程式上的連結：
  // **動到下面任何一個 case，必須同步更新 `shortcuts.ts`**。
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
        sendCommand({ name: e.shiftKey ? 'redo' : 'undo', steps: 1 });
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
        // 取消選取。**設定選取有九條路徑，清除以前只有三顆刪除鈕**——選過任何東西
        // 之後就永遠回不到 Inspector 的閒置區（AI 索引卡住在那裡）。這條與時間軸
        // 空白處點擊（`timeline/Timeline.tsx` 的 `data-tl-blank`）是唯二的回頭路。
        // 打字中不作用由這顆 handler 開頭的 INPUT/TEXTAREA/contentEditable 守衛涵蓋：
        // 欄位裡按 Escape 是「取消輸入法候選字」，不該把被編輯的物件整個取消掉。
        case 'escape':
          e.preventDefault();
          useSelection.getState().select(null);
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
        // Plan 11 Task 3（裁決 6）：把選取項的 in/out 修到 playhead，四種軌道通用
        // （主軌 trimIn/trimOut 語意、其餘 trimSpan 系語意）。與 Q/W 語意區隔清楚：
        // Q/W 是 ripple 刪除、動全時間軸；[/] 只動選取項本身，是一次性命令
        // （不像拖曳把手要跑 startTrimFollow/teardownDrag 那套 rAF 跟隨機制——
        // playhead 已經停在修剪點上，trim 完不必再 seek）。無選取時 no-op。
        // final-review Fix 2：Timeline 的 `drag` ref 是 component-local，App 沒有
        // 別的管道知道使用者手上正抓著把手——若不擋，拖曳進行中按 `[`/`]` 會在同一
        // 手勢中間再送一次衝突的命令（例如拖著 out 把手時按 `]`，兩個 updateClip
        // 前後夾擊同一個 clip）。`usePlayback.dragActive` 由 Timeline 的每個拖曳
        // 啟動 handler 設 true，`teardownDrag`（pointerup/pointercancel 共用）清回
        // false，這裡讀它決定要不要 no-op。
        case '[':
        case ']':
          e.preventDefault();
          if (usePlayback.getState().dragActive) break;
          trimSelectedToPlayhead(key === '[' ? 'in' : 'out', at);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 字卡同源字型：注入 @font-face,近似預覽(ApproxCaption)才會用伺服器那顆字型檔渲染,
  // 跟真的字卡看起來一致。只在掛載時做一次；用 id 檢查擋掉 StrictMode 雙掛載/重複執行
  // 造成同一批 @font-face 被插入兩次(那樣後面字型會覆蓋前面,浪費且脆弱)。
  useEffect(() => {
    if (document.getElementById('server-fonts')) return;
    void fetch('/api/fonts')
      .then((r) => (r.ok ? (r.json() as Promise<Array<{ id: string; family: string }>>) : []))
      .then((fonts) => {
        if (document.getElementById('server-fonts')) return;
        const css = fonts
          .map((f) => `@font-face { font-family: '${f.family}'; src: url('/fonts/${f.id}'); }`)
          .join('\n');
        const el = document.createElement('style');
        el.id = 'server-fonts';
        el.textContent = css;
        document.head.appendChild(el);
      })
      // 網路層真的失敗(不是 non-2xx,是 fetch 本身 reject——離線、DNS、server 還沒起來)
      // 不能讓它變成 unhandled rejection：近似預覽退回瀏覽器預設字體就好,不是致命錯誤。
      .catch(() => {});
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
          padding: '8px 16px',
          position: 'relative',
          zIndex: 30,
        }}
      >
        <b
          style={{
            fontSize: 15,
            // 起點改吃專屬 token：--accent-bright 在暗版已專用於 playhead 的紅蠟筆，
            // 品牌字樣不是標記層。paper 下 --brand-gradient-start = #c0392b
            // （＝該主題 --accent-bright 的字面值），紙上 computed 不變。
            background:
              'linear-gradient(90deg, var(--brand-gradient-start), var(--brand-gradient-end))',
            WebkitBackgroundClip: 'text',
            color: 'transparent',
          }}
        >
          vidcut
        </b>
        {/* `v{版本} · {專案名}` 字樣 2026-08-16 使用者定案移除——版本語境活動流
            裡本來就有(v{n} 修訂號),header 只留品牌。 */}
        {/* 紙條取代了原本的「● Connected / Offline」：連線與否只是它三態中的一態
            （offline），另外兩態（idle / working）是這裡以前完全看不到的東西。
            點它＝去看活動流。活動流 2026-08-16 從右欄分頁搬進左邊的 AI 專區，
            所以這個 callback 現在展開的是左欄（紙條自己也會 `openLeft()`，
            兩邊都冪等；prop 留著是為了讓版面知識留在 App 這一層）。 */}
        <AgentStrip onOpenActivity={() => useView.getState().openLeft()} />
        <ThemeToggle />
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
        {/*
         * 版面骨架（使用者 2026-08-16 定案）。**先縱切一刀**：左邊是全高的 AI 專區，
         * 右邊那一整塊（預覽＋右欄＋時間軸）是它的鄰居。時間軸因此從 AI 欄的右緣
         * 開始，不再橫貫整個視窗。
         *
         * 實作上仍然是**一個** grid 容器，不是「左欄 flex + 右邊再一個 grid」：
         * `PanelResizer` 的座標換算吃的就是這顆容器的 `getBoundingClientRect()`
         * （left 是 `clientX - rect.left`、right 是 `rect.right - clientX`），
         * 把左欄拆出去會讓那兩條式子各自對到不同的基準。所以三欄照舊，
         * 改的是**列**：加一條時間軸列，用 `gridColumn: '2 / 4'` 讓它從第二欄
         * （預覽）起跳，第一欄（AI）在那一列沒有格子——這就是「時間軸右移」。
         *
         * `gridTemplateRows: '1fr auto'`：上排吃掉剩餘高度，時間軸列由內容決定高。
         */}
        <div
          ref={gridRef}
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: `${leftOpen ? `${leftWidth}px` : '0px'} 1fr ${rightOpen ? `${rightWidth}px` : '0px'}`,
            gridTemplateRows: '1fr auto',
            minHeight: 0,
            // 拖曳伸縮中關掉過渡（不然黏手）；收合/展開仍有動畫
            transition: resizing ? 'none' : 'grid-template-columns 0.25s ease',
          }}
        >
          {/* 左：AI 專區（外層 hidden、內層固定寬 → 收合時內容不變形）。**全高**：
              `gridRow: '1 / 3'` 讓它跨過時間軸那一列，所以時間軸從它的右緣開始。
              `panel-surface` = --panel 實底（亮度樓梯第二階，theme.css 檔頭）。 */}
          {/* 分界線交給 CSS（`.panel-edge-r`）而不是 inline style：紙主題要把這條
              結構性大分界換成 1.5px dashed（DESIGN.md 的 dashed rules），而 inline
              style 贏過任何 author 規則，scoped 覆寫只能靠 !important——那會連
              「收合時不畫線」一起蓋掉。改用 class + `data-edge` 屬性表達開合狀態。 */}
          <div
            className="panel-surface panel-edge-r"
            data-edge={leftOpen ? 'on' : 'off'}
            style={{ overflow: 'hidden', gridRow: '1 / 3' }}
          >
            <div
              style={{
                width: leftWidth,
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {/* 「AI」頭列 2026-08-18 使用者定案移除(空間上收)——收合鈕搬進
                  AgentPanel 的分頁列右端(title 不變,verify:panels 免改)。
                  索引卡在上、活動流在下，兩段共用一根全高的欄（見 AgentPanel）。
                  `minHeight: 0` 是活動流捲得起來的前提——flex 子項預設
                  `min-height: auto` 會被內容撐開，整欄一起長高而不是內部捲動。 */}
              <div style={{ flex: 1, minHeight: 0 }}>
                <AgentPanel />
              </div>
            </div>
          </div>

          {/* 中：預覽。外層不捲動、只當定位基準；捲動交給內層。
              展開鈕與伸縮把手掛在外層——放進捲動容器的話會跟著內容捲走。
              展開鈕與面板 header 裡的收合鈕齊高，收合前後位置幾乎不動。
              它的 z 要壓過頂欄的 Export 下拉（z 50）：兩者都貼右緣、水平必然重疊，
              靠位置錯開會隨視窗高度失效。點它會同時關掉下拉（ExportMenu 監聽外部 pointerdown）。 */}
          <div className="stage-surface" style={{ position: 'relative', minHeight: 0 }}>
            {leftOpen && (
              <PanelResizer side="left" gridRef={gridRef} onResizingChange={setResizing} />
            )}
            {rightOpen && (
              <PanelResizer side="right" gridRef={gridRef} onResizingChange={setResizing} />
            )}
            {!leftOpen && (
              <button
                className="icon-btn panel-handle"
                onClick={() => useView.getState().toggleLeft()}
                title="Expand AI panel"
                style={{ left: 6 }}
              >
                <PanelLeftOpen size={13} />
              </button>
            )}
            {!rightOpen && (
              <button
                className="icon-btn panel-handle"
                onClick={() => useView.getState().toggleRight()}
                title="Expand captions/properties panel"
                style={{ right: 6 }}
              >
                <PanelRightOpen size={13} />
              </button>
            )}
            <div style={{ height: '100%', overflowY: 'auto', padding: 12 }}>
              <Player />
            </div>
          </div>

          {/* 右：字幕 ⇄ 屬性分頁（同左欄，--panel 實底）。
              Activity 分頁 2026-08-16 退役——活動流整組搬進左邊的 AI 專區。 */}
          <div
            className="panel-surface panel-edge-l"
            data-edge={rightOpen ? 'on' : 'off'}
            style={{ overflow: 'hidden' }}
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
                className="panel-bar"
                style={{
                  gap: 4,
                  padding: '8px 12px',
                }}
              >
                <button
                  className={`seg${tab === 'media' ? ' on' : ''}`}
                  title="Media"
                  onClick={() => setTab('media')}
                >
                  Media {mediaCount > 0 && <span className="badge">{mediaCount}</span>}
                </button>
                <button
                  className={`seg${tab === 'captions' ? ' on' : ''}`}
                  onClick={() => setTab('captions')}
                >
                  Captions {captionCount > 0 && <span className="badge">{captionCount}</span>}
                </button>
                <button
                  className={`seg${tab === 'properties' ? ' on' : ''}`}
                  onClick={() => setTab('properties')}
                >
                  Properties
                </button>
                <button
                  className="icon-btn panel-collapse"
                  onClick={() => useView.getState().toggleRight()}
                  title="Collapse"
                >
                  <PanelRightClose size={13} />
                </button>
              </div>
              {/* Properties 分頁自己捲：Inspector 是一長條表單，而分頁殼是 flex 直向。
                  Media／Captions 分頁的元件內部已是 `.panel-col` + `.panel-body`，
                  自己處理捲動，所以只有 Inspector 這條路需要外面補一層 overflow。 */}
              <div ref={tabBodyRef} style={{ flex: 1, minHeight: 0 }}>
                {tab === 'media' ? (
                  <MediaPanel />
                ) : tab === 'captions' ? (
                  <CaptionList />
                ) : (
                  <div style={{ height: '100%', overflowY: 'auto' }}>
                    <Inspector />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 底：時間軸（同左右面板，--panel 實底）。
              `gridColumn: '2 / 4'`＝從預覽欄起跳、吃到最右——AI 欄那一格不屬於這一列，
              所以時間軸的左緣就是 AI 欄的右緣。AI 欄收合時第一欄寬度歸零，
              時間軸自然變寬；`Timeline.tsx` 量的是自己容器的寬，不必知道這件事。 */}
          <div
            className="panel-surface panel-edge-t"
            style={{ padding: 8, gridColumn: '2 / 4', minWidth: 0 }}
          >
            <Timeline />
          </div>
        </div>
      </div>

      <Toast />
    </div>
  );
}
