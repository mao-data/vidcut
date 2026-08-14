import { useEffect, useState } from 'react';
import { useProject } from './stores/project.js';
import { useAgent, agentPhase, currentCall } from './stores/agent.js';
import { useView } from './stores/view.js';

/**
 * Header 的琥珀終端標籤——**大使館在編輯器裡的第一件實體**
 * （spec `docs/superpowers/specs/2026-08-14-agent-presence-design.md` §3.3
 *  與其 2026-08-14 修訂）。
 *
 * 取代原本 header 的「● Connected / Offline」。三態由 `stores/agent.ts` 的
 * `agentPhase` 推導（那是階段 2 的產物，本檔只讀不寫）：
 *
 *   offline  舊黃銅、虛線圈、褪掉的歪框、`NO AGENT`
 *   idle     琥珀實圈 + 實線歪框、`AGENT READY`
 *   working  標籤伸長，mono 工具名 + 經過秒數，圈持續重畫
 *
 * ⚠️ **識別是「那隻手」不是「紙」**（2026-08-14 使用者定案）：暗版載體是
 * 終端標籤，把兩個世界縫起來的是鉛筆筆跡——手繪圈、歪框、`#ap-pencil`
 * 濁度濾鏡。紙與膠帶保留給階段 ③ 的亮版。**這次換裝行為零變更。**
 *
 * **經過秒數在元件層算**：store 只存 `startedAt`，每秒 set 一次 state 會把
 * 整棵樹重繪。這裡的 `setInterval` 只在 working 態掛。
 */

/**
 * 經過毫秒 → `mm:ss`。
 *
 * - 負數（時鐘回撥／startedAt 在未來）夾成 `00:00`，不顯示 `-1:-3` 這種鬼東西。
 * - 超過一小時**不進位到 hh**，繼續累加分鐘（`transcribe` 跑很久時
 *   `72:15` 比 `01:12:15` 更好讀，而且欄寬不會跳）。
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** 手繪圈的路徑：刻意歪的閉合路徑（DESIGN.md：不用 `<circle>`，要手畫的線）。 */
const RING_PATH =
  'M8 1.6c3.6-.3 6.5 2.6 6.3 6.2-.2 3.5-2.9 6.4-6.4 6.3C4.4 14 1.5 11.2 1.7 7.7 1.9 4.3 4.6 1.8 8 1.6z';

/**
 * 歪框的路徑：刻意畫歪的矩形，四邊都在抖（DESIGN.md 的 form language——
 * 框是手畫上去的，不是 CSS border 的直線）。
 *
 * 座標寫死在 `viewBox="0 0 158 29"` 的空間裡，但 SVG 掛
 * `preserveAspectRatio="none"` + `width/height: 100%`，所以這條路徑會跟著標籤
 * 的實際尺寸自由拉伸——working 伸長時框自己跟著長，不必準備第二條路徑。
 */
const FRAME_PATH =
  'M2.5 3.2c50-2 104-1.8 153 .8 1.2 6.8-.6 15.6.3 22-52 2.6-102 2-152.6-.4-1.4-6.6.4-14.8-.7-22.4z';

export interface AgentStripProps {
  /** 點擊時切到 Activity 分頁。分頁 state 是 App 的 local useState，所以由 App 傳進來。 */
  onOpenActivity: () => void;
}

export function AgentStrip({ onOpenActivity }: AgentStripProps) {
  const connected = useProject((s) => s.connected);
  const calls = useAgent((s) => s.calls);
  const phase = agentPhase(connected, calls);
  const call = currentCall(calls);
  const working = phase === 'working' && call !== null;

  // 經過秒數：只在 working 掛 interval。`now` 每秒推進一次，重繪的只有這條紙條。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!working) return;
    // 掛上的當下先對一次時，否則從上一次卸載到現在的空窗會讓第一秒顯示舊值。
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [working]);

  const label = phase === 'offline' ? 'No agent' : working ? 'Working' : 'Agent ready';

  return (
    <button
      type="button"
      className={`ap-strip${phase === 'offline' ? ' offline' : ''}`}
      // 三態文字要能被讀屏幕唸出來。role=status + aria-live=polite：狀態變化時
      // 播報，但不打斷使用者正在聽的內容（這不是警報，是背景狀態）。
      role="status"
      aria-live="polite"
      title="Show agent activity"
      onClick={() => {
        onOpenActivity();
        // 右欄收合時展開——切了分頁卻看不到內容等於沒切。openRight 是冪等的。
        useView.getState().openRight();
      }}
    >
      {/* `#pencil` 濁度濾鏡（DESIGN.md：feTurbulence 0.055 / seed 7 + displacement 2.6）。
          id 前綴 `ap-` 避免跟未來 site 或別處的 `pencil` 撞名——SVG filter id 是全域的。 */}
      <svg width="0" height="0" className="ap-defs" aria-hidden="true" focusable="false">
        <defs>
          <filter id="ap-pencil" x="-20%" y="-20%" width="140%" height="140%">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.055"
              numOctaves="3"
              seed="7"
              result="n"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="n"
              scale="2.6"
              xChannelSelector="R"
              yChannelSelector="G"
            />
          </filter>
        </defs>
      </svg>
      {/* 歪框：暗版的手繪簽名（接替膠帶的位置）。絕對定位鋪滿整個標籤，
          `preserveAspectRatio="none"` 讓路徑跟著寬度拉伸。裝飾性，aria-hidden。
          框色由 `.ap-strip.offline` 的 CSS 控制，不在這裡分支。 */}
      <svg
        className="ap-frame"
        viewBox="0 0 158 29"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <path pathLength="1" d={FRAME_PATH} />
      </svg>
      <svg
        className={`ap-ring${phase === 'offline' ? ' dashed' : ''}${working ? ' drawing' : ''}`}
        viewBox="0 0 16 16"
        aria-hidden="true"
        focusable="false"
      >
        {/* pathLength=1 讓 stroke-dasharray/offset 用 0–1 的比例表示，與實際路徑長脫鉤 */}
        <path pathLength="1" d={RING_PATH} />
      </svg>
      <span className="ap-cap">{label}</span>
      {working && (
        <>
          <span className="ap-tool">{call.tool}</span>
          <span className="ap-secs">{formatElapsed(now - call.startedAt)}</span>
        </>
      )}
    </button>
  );
}
