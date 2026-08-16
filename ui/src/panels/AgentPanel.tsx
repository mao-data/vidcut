import { useEffect, useState } from 'react';
import { useProject } from '../stores/project.js';
import { useActivity } from '../stores/activity.js';
import { useAgent, agentPhase, currentCall, sessionCounts } from '../stores/agent.js';
// 索引卡與 header 標籤共用同一隻手（`RING_PATH`）與同一份格式化（`formatElapsed`）。
// 複製一份的話有人改了其中一份就會分岔，而分岔沒有任何測試抓得到。
import { RING_PATH, formatElapsed } from '../AgentStrip.js';
import { Activity } from './Activity.js';

/**
 * AI 專區的索引卡——**大使館在編輯器裡的第二件實體**
 * （spec `docs/superpowers/specs/2026-08-14-agent-presence-design.md` §3.4
 *  與其 2026-08-16 修訂）。
 *
 * 2026-08-16 版面重構前它住在 Inspector 的「未選取」分支，只有沒選東西時才看得到；
 * 現在它住在自己的全高左欄，選取狀態不再影響它——AI 在不在、剛做了什麼，
 * 是這個產品的核心迴路，不該被「使用者剛好點了一個 clip」蓋掉。
 *
 * **三態與 header 標籤共用同一份 store 推導**（`stores/agent.ts` 的 `agentPhase`），
 * 不重寫第二套：
 *
 *   offline  灰調卡、虛線手繪圈、`NO AGENT` + `claude mcp add …` 接回指令
 *   idle     圈畫滿、`AGENT READY` + session 讀數列
 *   working  `▸ {tool} mm:ss` 實時行（圈持續重畫）+ session 讀數列
 *
 * ⚠️ **載體＝琥珀終端卡**（使用者 2026-08-16 定案，A 案）：跟 AgentStrip 同族的
 * slate 底 + 琥珀讀數，不是紙。識別仍然是「那隻手」——手繪圈與 `#ap-pencil`
 * 濁度濾鏡，`RING_PATH` 直接從 AgentStrip import，同一支筆同一個圈。
 * **卡本體擺正**（app ≠ landing 體例；DESIGN.md 的「Don't rotate a UI element」）。
 * **署名不用手寫體**（同一條規則的第二半：Caveat 仍然零消費者）。
 *
 * **經過秒數在元件層算**（照 AgentStrip 的既有寫法）：store 只存 `startedAt`，
 * 每秒 set 一次 state 會把整棵樹重繪。`setInterval` 只在 working 掛、卸載即清。
 */
export function AgentStatus() {
  const connected = useProject((s) => s.connected);
  const version = useProject((s) => s.version);
  const entries = useActivity((s) => s.entries);
  const calls = useAgent((s) => s.calls);
  const phase = agentPhase(connected, calls);
  const call = currentCall(calls);
  const working = phase === 'working' && call !== null;
  const counts = sessionCounts(entries);
  const recent = [...entries].reverse().slice(0, 3);

  // 經過秒數：只在 working 掛 interval（同 AgentStrip）。`now` 每秒推進一次，
  // 重繪的只有這張卡。掛上的當下先對一次時，否則上一次卸載到現在的空窗會讓
  // 第一秒顯示舊值。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!working) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [working]);

  return (
    <div className="panel-section">
      <div className="panel-head" style={{ marginBottom: 8 }}>
        AI agent
      </div>
      <div className={`ap-card${phase === 'offline' ? ' offline' : ''}`}>
        {/* 手繪圈：`#ap-pencil` 濁度濾鏡的 defs 由 header 的 AgentStrip 內嵌，
            SVG filter id 是 **document 級**可及的，所以這裡直接 url(#ap-pencil)
            引用即可，不需要（也不該）再宣告一份同 id 的 defs。 */}
        <div className="ap-card-head">
          <svg
            className={`ap-ring${phase === 'offline' ? ' dashed' : ''}${working ? ' drawing' : ''}`}
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
          >
            <path pathLength="1" d={RING_PATH} />
          </svg>
          {/* 三態文字與 header 標籤逐字相同（同一份 store 推導的同一組字串）：
              兩件大使館物件在同一個時刻說不同的話，使用者會以為是兩個 agent。 */}
          <span className="ap-cap">
            {phase === 'offline' ? 'No agent' : working ? 'Working' : 'Agent ready'}
          </span>
        </div>
        {working && (
          // working 的實時行。`▸` 是靜態字元不是圖示：transcribe 可跑數分鐘，
          // 這一行要有「還活著」的感覺，而活著的證據是秒數在動，不是三角形在轉。
          <div className="ap-card-live">
            <span aria-hidden="true">▸</span>
            <span className="ap-card-tool">{call.tool}</span>
            <span className="ap-card-secs">{formatElapsed(now - call.startedAt)}</span>
          </div>
        )}
        {!connected && (
          // 離線時給的是「怎麼接回來」，不是「你離線了」。**換皮不換行為**：
          // 指令內容與 code block 形態都是既有的，只有配色跟著卡走。
          <code className="ap-card-cmd">
            claude mcp add --transport http vidcut http://127.0.0.1:3845/mcp
          </code>
        )}
        {connected && (
          // session 讀數列（spec §3.4）：`v{version} · AI {n} · you {m}`。
          // version 是**專案修訂號**（`stores/project.ts` 的 version，server echo
          // 每次 +1），不是 header 那個 `__APP_VERSION__` 軟體版本——語境在這張卡裡
          // 很清楚（旁邊就是 AI/人的編輯計數），跟 Activity 面板同一套語意。
          <div className="ap-card-counts">
            v{version} · AI {counts.ai} · you {counts.human}
          </div>
        )}
      </div>
      {/* `empty-note` 掛在**外層**而不是下面那個 `.tag` 上：`scripts/mutants.json` 的
          `inspector-agent-empty` 錨在那一整行的字面值上（含 className 與文字），
          動它會讓突變測試的 find 落空。這段註解也刻意不複述那串字面值——
          複述會讓 find 命中兩次，`mutate --check` 同樣會紅。 */}
      <div className={recent.length === 0 ? 'empty-note' : undefined} style={{ marginTop: 12 }}>
        {recent.length === 0 ? (
          <div className="tag">No edits yet.</div>
        ) : (
          recent.map((e) => (
            <div
              key={e.version}
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'baseline',
                padding: '2px 0',
                fontSize: 11,
              }}
            >
              {/* 署名分色走 --who-* token（暗版紫/藍、紙版 graphite/紅鉛筆）：
                  與 Activity 面板同一條規則 */}
              <span
                style={{
                  flex: 'none',
                  width: 26,
                  color: e.source === 'ai' ? 'var(--who-ai)' : 'var(--who-you)',
                }}
              >
                {e.source === 'ai' ? 'AI' : 'you'}
              </span>
              <span
                style={{
                  color: 'var(--text-2)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {e.label}
              </span>
              {/* 尾端署名。**同色不同階**：跟左邊那格吃同一個 --who-* token，
                  靠 CSS 的 opacity 退階，不另立第三種顏色也不用手寫體
                  （DESIGN.md 的 No-Handwriting-In-App 規則）。 */}
              <span
                className="ap-card-sign"
                style={{
                  marginLeft: 'auto',
                  flex: 'none',
                  color: e.source === 'ai' ? 'var(--who-ai)' : 'var(--who-you)',
                }}
              >
                {e.source === 'ai' ? '—AI' : '—you'}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * AI 專區（左欄全高，使用者 2026-08-16 版面定案）。
 *
 * 上＝三態索引卡＋最近三筆署名列＋session 讀數（`AgentStatus`，原本住在 Inspector
 * 的未選取分支）；下＝完整活動流（`Activity`，原本是右欄的一個分頁）。
 * 兩者是同一件事的兩個尺度：卡回答「現在怎樣」，流回答「到目前為止做了什麼」，
 * 分在兩根欄裡的時候使用者得自己在腦裡把它們接起來。
 *
 * 版面用 flex 直向：`AgentStatus` 是固定高度的頭（`flex: none`），活動流吃掉剩餘
 * 高度並自己捲（`Activity` 內部已是 `.panel-col` + `.panel-body`，給它 `minHeight: 0`
 * 才捲得起來——flex 子項的預設 `min-height: auto` 會被內容撐開、整欄一起長高）。
 */
export function AgentPanel() {
  return (
    <div className="panel-col">
      <div style={{ flex: 'none' }}>
        <AgentStatus />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Activity />
      </div>
    </div>
  );
}
