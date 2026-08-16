import { Fragment, useEffect, useState, type ChangeEvent } from 'react';
import {
  AudioWaveform,
  CircleHelp,
  Paperclip,
  Scissors,
  Snowflake,
  Sun,
  Trash2,
} from 'lucide-react';
import type { AudioItem, Command } from '@vidcut/shared';

type AudioPatch = Partial<
  Pick<AudioItem, 'start' | 'in' | 'duration' | 'volume' | 'fadeIn' | 'fadeOut' | 'ducking'>
>;
import { useProject } from '../stores/project.js';
import { useSelection } from '../stores/selection.js';
import { usePlayback } from '../stores/playback.js';
import { useActivity } from '../stores/activity.js';
import { useAgent, agentPhase, currentCall, sessionCounts } from '../stores/agent.js';
import { useTheme } from '../stores/theme.js';
import { sendCommand } from '../ws.js';
import { SHORTCUTS } from '../shortcuts.js';
// 索引卡與 header 標籤共用同一隻手（`RING_PATH`）與同一份格式化（`formatElapsed`）。
// 複製一份的話有人改了其中一份就會分岔，而分岔沒有任何測試抓得到。
import { RING_PATH, formatElapsed } from '../AgentStrip.js';

function num(e: ChangeEvent<HTMLInputElement>): number {
  return Number(e.target.value);
}

/** 畫布填充模式切換（9:16 放橫素材時 blur 比黑邊好看）。 */
function CanvasFitRow() {
  const fit = useProject((s) => s.doc?.canvas.fit ?? 'contain');
  return (
    <div className="panel-section">
      <label className="field" style={{ marginTop: 0 }}>
        Canvas fill (when not covered)
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
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

/**
 * 快捷鍵表：收進「?」彈出層，省 Inspector 高度。
 * 內容一律來自 `shortcuts.ts`（單一來源），不要在這裡硬編按鍵文字。
 * 兩欄網格：鍵在左、動作在右，密度跟原本那份 `<br>` 分行的緊湊表相當。
 */
function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 12, position: 'relative' }}>
      <button className="icon-btn" onClick={() => setOpen((o) => !o)}>
        <CircleHelp size={13} /> Shortcuts
      </button>
      {open && (
        <div
          className="popover"
          style={{
            top: 'calc(100% + 8px)',
            left: 0,
            zIndex: 20,
            width: 216,
            fontSize: 12,
            color: 'var(--text-2)',
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            columnGap: 10,
            rowGap: 2,
            lineHeight: 1.5,
          }}
        >
          {SHORTCUTS.map((s) => (
            <Fragment key={`${s.keys} ${s.label}`}>
              <span style={{ color: 'var(--text-1)', whiteSpace: 'nowrap' }}>{s.keys}</span>
              <span>{s.label}</span>
            </Fragment>
          ))}
          <ThemeToggle />
        </div>
      )}
    </div>
  );
}

/**
 * 主題切換（spec `2026-08-14-dual-theme-design.md` §4）。
 * 借住 Shortcuts 彈出層尾端——這是唯一一個既有的「設定類」落點，不必為它在
 * 頂欄多開一個常駐控制項。彈出層是兩欄 grid，所以要 `gridColumn: '1 / -1'` 橫跨。
 */
function ThemeToggle() {
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);
  const on = theme === 'paper';
  return (
    <div className="panel-edge-t" style={{ gridColumn: '1 / -1', marginTop: 8 }}>
      <button
        className={`seg${on ? ' on' : ''}`}
        aria-pressed={on}
        onClick={() => setTheme(on ? 'dark' : 'paper')}
        style={{ width: '100%', marginTop: 8 }}
      >
        <Sun size={13} /> Paper theme
      </button>
    </div>
  );
}

/**
 * Inspector 的索引卡——**大使館在編輯器裡的第二件實體**
 * （spec `docs/superpowers/specs/2026-08-14-agent-presence-design.md` §3.4
 *  與其 2026-08-16 修訂）。
 *
 * 沒有選取時，這片面板是唯一「閒著也會被看到」的區域。原本只有一句
 * 「Select a clip…」在描述系統狀態，而使用者此刻真正需要知道的是這個產品的
 * 核心迴路：AI 在不在、它剛做了什麼。
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
function AgentStatus() {
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

export function Inspector() {
  const doc = useProject((s) => s.doc);
  const selected = useSelection((s) => s.selected);
  if (!doc) return null;
  if (!selected) {
    return (
      <div className="form">
        <AgentStatus />
        <CanvasFitRow />
        {/* `empty-note`＝「桌上的一張便條」掛勾（微轉 −0.7deg，兩主題共用）。
            ⚠️ `fontSize` 在 CSS 的 `.empty-note`（12px）而不是這裡的 inline style：
            inline style 贏過任何 author 規則，留在這裡的話主題永遠改不掉字級。
            ⚠️ 這裡曾有一個 `<span className="sc-help">` 包住 ShortcutHelp，用途是讓
            快捷鍵表逃出紙主題套在 `.empty-note` 上的手寫體。**2026-08-14 手寫體全面
            退場後它沒有存在意義**（ShortcutHelp 的根本來就是 block 的 `<div>`），
            已連同 `.sc-help` 的 CSS 一起移除——不要再包回來。 */}
        <div className="empty-note" style={{ padding: 12, color: 'var(--text-3)' }}>
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
        <h3>Clip {clip.label ?? clip.id}</h3>
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
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
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
        </div>
        <div className="danger-zone">
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
        <h3>Audio {a.label ?? a.mediaId}</h3>
        <p className="section">Timing</p>
        <label className="field">Start (s)</label>
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
        <p className="section">Levels</p>
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
        <label className="field check">
          <input
            type="checkbox"
            checked={a.ducking === true}
            onChange={(e) => upd({ ducking: e.target.checked })}
          />
          Duck the video track while this plays
        </label>
        <div className="danger-zone">
          <button
            className="btn-danger icon-btn"
            onClick={() => {
              send({ name: 'removeAudio', id: a.id });
              useSelection.getState().select(null);
            }}
          >
            <Trash2 size={13} /> Delete audio
          </button>
        </div>
      </div>
    );
  }

  if (selected.kind === 'caption') {
    const cap = doc.tracks.captions.find((c) => c.id === selected.id);
    if (!cap) return null;
    return (
      <div className="form" style={{ padding: 12 }}>
        <h3>Caption</h3>
        <label className="field">Text</label>
        {/*
         * **失焦才送命令**（與同一面板的文字 overlay Text 欄同一個模式）。
         * 以前是 `value` + `onChange` 每一鍵一筆 `updateCaption`：每個按鍵都是一筆 history、
         * 一次 cardSync 重產字卡（實測打 33 個字 → `derived/text/` 多出 99 個檔案，而那個
         * 目錄目前只增不減、沒有 GC）。
         *
         * 這裡刻意**不接**打字三段式（`ui/src/stores/editDraft.ts` + `CaptionList.tsx`）：
         * 那條路的 debounce 計時器與 `useEditDraft` 的單一草稿槽都是 CaptionList 的模組私有
         * 狀態，兩個編輯面板同時往同一個槽寫，會出現「誰的草稿蓋掉誰」的競態；要共用得先把
         * schedulePreview/cancelPreview 抽成共用模組並訂出草稿所有權，那是另一批的事。
         * 現況：畫布即時打字看得到的那條路仍在右上字幕列表（雙擊那一句），這裡是「改完就送」。
         *
         * 非受控 + `key` 帶值：AI/別的 session 從外部改了同一句字（id 不變、值變了）時要
         * remount 才會刷新，否則面板停在舊值、使用者一 blur 就把外部的修改靜默蓋掉。
         * 沒有 Enter 送出——這個 `<textarea>` 正是使用者打「真的換行」的地方（見 HANDOFF）。
         */}
        <textarea
          style={{ minHeight: 48 }}
          defaultValue={cap.text}
          key={cap.id + cap.text}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== cap.text) {
              // `tokens: []`（空陣列＝清除）**不能省**。有逐詞時間戳的那些句子，
              // 字卡是照 tokens 排版的——`text_card.py` 的 render_cards 在有 tokens 時
              // 走 layout_tokens，`cfg["text"]` 從頭到尾沒被讀過。只送 text 的話：文件裡
              // 的 text 換了、tokens 沒動 → 產出的 PNG 與改字前**逐位元組相同**，畫面沒有
              // 任何變化，也沒有任何錯誤訊息。使用者會以為自己打錯地方了。
              // 而且舊的詞邊界本來就對不上新文字，留著只會讓 karaoke 照錯的詞界跑。
              // CaptionList.tsx 的打字路徑一直是這樣送的，這裡以前漏了（2026-08-05 修）。
              send({ name: 'updateCaption', id: cap.id, patch: { text: v, tokens: [] } });
            }
          }}
        />
        <p className="section">Timing</p>
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
        <p className="section">Style</p>
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
      <h3>Overlay {ov.imagePath.split('/').pop()}</h3>
      <p className="section">Timing</p>
      {ov.anchor ? (
        <>
          <label className="field">Offset from clip (s)</label>
          <input
            type="number"
            step="0.1"
            value={ov.anchor.offset}
            onChange={(e) =>
              send({
                name: 'updateOverlay',
                id: ov.id,
                patch: { anchor: { clipId: ov.anchor!.clipId, offset: num(e) } },
              })
            }
          />
          <p
            className="hint"
            style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}
          >
            <Paperclip size={13} style={{ flexShrink: 0 }} />
            follows{' '}
            {doc.tracks.video.find((c) => c.id === ov.anchor!.clipId)?.label ?? ov.anchor.clipId}
          </p>
        </>
      ) : (
        <>
          <label className="field">Start (s)</label>
          <input
            type="number"
            step="0.1"
            min="0"
            value={ov.start ?? 0}
            onChange={(e) => send({ name: 'updateOverlay', id: ov.id, patch: { start: num(e) } })}
          />
        </>
      )}
      {/*
       * 勾選框排在 Duration **之後**，而且勾起來時輸入框留在原地變灰、不整組消失。
       * 舊版是「勾選框在前 + `{ov.duration !== null && …}`」：勾下去 Duration 整組不見、
       * 版面往上跳，勾選框頓時緊貼上一個欄位（offset），看起來像在修飾那一個。
       * DOM 順序仍是 label → input → 勾選列，視覺位置由 .field-group 的 grid 排。
       */}
      <div className="field-group">
        <label className="field">Duration (s)</label>
        {ov.duration === null ? (
          <input type="text" value="to end of video" disabled readOnly />
        ) : (
          <input
            type="number"
            step="0.1"
            min="0.1"
            value={ov.duration}
            onChange={(e) =>
              send({ name: 'updateOverlay', id: ov.id, patch: { duration: num(e) } })
            }
          />
        )}
        <label className="field check">
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
          until end
        </label>
      </div>
      <p className="section">Position</p>
      {/*
       * x·y 併成兩欄，Scale 留一整行。三欄放不下——見 theme.css 的 .duo：畫布拖曳寫進來
       * 的是四位小數，最窄面板下三欄會把數字截掉，使用者會讀到截斷後的值當成真值。
       */}
      <div className="duo">
        <div>
          <label className="field">x (0–1)</label>
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
        </div>
        <div>
          <label className="field">y (0–1)</label>
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
        </div>
      </div>
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
      {ov.text && (
        <>
          <p className="section">Style</p>
          <label className="field">Text</label>
          <textarea
            rows={2}
            defaultValue={ov.text.text}
            key={ov.id + ov.text.text}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== ov.text!.text) {
                send({
                  name: 'updateOverlay',
                  id: ov.id,
                  patch: { text: { ...ov.text!, text: v } },
                });
              }
            }}
          />
          <label className="field">Font size</label>
          <input
            type="number"
            defaultValue={ov.text.fontSize}
            key={ov.id + ov.text.fontSize}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (n > 0 && n !== ov.text!.fontSize) {
                send({
                  name: 'updateOverlay',
                  id: ov.id,
                  patch: { text: { ...ov.text!, fontSize: n } },
                });
              }
            }}
          />
          <label className="field">Color</label>
          <input
            type="color"
            defaultValue={ov.text.fill}
            key={ov.id + ov.text.fill}
            onChange={(e) => {
              const v = e.target.value;
              if (v !== ov.text!.fill) {
                send({
                  name: 'updateOverlay',
                  id: ov.id,
                  patch: { text: { ...ov.text!, fill: v } },
                });
              }
            }}
          />
        </>
      )}
      <div className="danger-zone">
        <button
          className="btn-danger icon-btn"
          onClick={() => {
            send({ name: 'removeOverlay', id: ov.id });
            useSelection.getState().select(null);
          }}
        >
          <Trash2 size={13} /> Delete overlay
        </button>
      </div>
    </div>
  );
}
