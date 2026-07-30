# vidcut UI 重設計 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把工程原型級 UI 重塑為「C 現代 web 工具」視覺系統（深藍紫玻璃＋紫漸層強調），含保守版面調整、峰值+RMS 波形、GSAP 動效。

**Architecture:** 四層依序落地，各自獨立 commit：(1) 資料層 peaks+RMS、(2) theme.css 設計系統（styling 原生元素為主，讓元件「刪 inline style 就變好看」）、(3) 版面（頂欄匯出/右欄分頁/時間軸工具列/收合）、(4) 時間軸重繪與 GSAP。行為零改動：命令層、MCP、播放引擎、拖曳數學全部不碰。

**Tech Stack:** React 19 + Vite、zustand、純 CSS 變數（無 Tailwind）、gsap + @gsap/react、lucide-react、canvas 2D。

## Global Constraints

- spec: `docs/superpowers/specs/2026-07-30-vidcut-ui-redesign-design.md`
- 不碰：`server/src/commands.ts`、`mcp.ts`、`ui/src/player` 的排程邏輯、`ui/src/timeline/dragMath.ts`
- 既有 143 測試須全數通過；`npm run typecheck && npm run lint && npm run build -w @vidcut/ui` 乾淨
- 新依賴僅限：`gsap`、`@gsap/react`、`lucide-react`（裝在 ui workspace）
- token 色值以 spec §1 為準（--accent #8b5cf6、音訊 #0ea5e9、成功 #34d399、危險 #f87171、高亮 #fbbf24）
- 時間碼一律 `font-variant-numeric: tabular-nums`
- `prefers-reduced-motion: reduce` 時停用所有動效（CSS 兜底 + GSAP 判斷）

---

### Task 1: peaks 升級（100 桶/秒 + RMS）＋ shared `PeaksFile` 型別

**Files:**
- Modify: `shared/src/types.ts`（檔尾附近，MediaAsset 區塊後）
- Modify: `server/src/ingest.ts:14-15`（常數）、`:102-119`（桶計算與寫檔）
- Modify: `ui/src/timeline/Timeline.tsx:27-32`（改 import shared 型別）
- Test: `server/test/ingest.test.ts`（擴充既有 peaks 斷言）

**Interfaces:**
- Produces: `PeaksFile { sampleRate: number; samplesPerBucket: number; peaks: number[]; rms?: number[] }`（shared 匯出；Task 5 的波形繪製依賴）

- [x] **Step 1: shared 加型別**

```ts
/** peaks.json 的形狀（ingest 產出、UI 波形繪製消費）。rms 舊檔沒有 → 單層退回。 */
export interface PeaksFile {
  sampleRate: number;
  samplesPerBucket: number;
  /** 每桶 max|amp|，0–1 */
  peaks: number[];
  /** 每桶 RMS，0–1（2026-07-30 起新 ingest 才有） */
  rms?: number[];
}
```

- [x] **Step 2: 先改測試（TDD）** — `server/test/ingest.test.ts` 找到現有 peaks 斷言，追加：

```ts
// 100 桶/秒（8000/80）；rms 與 peaks 等長且逐桶 ≤ peak
const peaksJson = JSON.parse(await readFile(join(dir, m.peaksPath!), 'utf8')) as {
  sampleRate: number; samplesPerBucket: number; peaks: number[]; rms?: number[];
};
expect(peaksJson.sampleRate / peaksJson.samplesPerBucket).toBe(100);
expect(peaksJson.rms).toBeDefined();
expect(peaksJson.rms!.length).toBe(peaksJson.peaks.length);
for (let i = 0; i < peaksJson.peaks.length; i++) {
  expect(peaksJson.rms![i]!).toBeLessThanOrEqual(peaksJson.peaks[i]! + 1e-9);
}
// 正弦波的 RMS ≈ peak/√2：抽有聲桶驗證比值合理（0.5–0.9）
const loud = peaksJson.peaks.map((p, i) => [p, peaksJson.rms![i]!]).filter(([p]) => p! > 0.3);
expect(loud.length).toBeGreaterThan(0);
for (const [p, r] of loud) expect(r! / p!).toBeGreaterThan(0.4);
```

- [x] **Step 3: 跑測試確認紅**（`npx vitest run test/ingest.test.ts --root server`）
- [x] **Step 4: 實作** — `PEAK_SAMPLES_PER_BUCKET = 80`；迴圈同時累積 `sum += v*v`，桶尾 `rms.push(Number((Math.sqrt(sum / n) / 32768).toFixed(4)))`；寫檔加 `rms`。`Timeline.tsx` 刪本地 `interface Peaks`，改 `import type { PeaksFile } from '@vidcut/shared'`（暫時 alias `type Peaks = PeaksFile` 讓其餘程式不動，Task 5 再重寫繪製）。
- [x] **Step 5: 跑測試綠 + typecheck** 
- [x] **Step 6: Commit** `feat(ingest): 100 buckets/sec peaks + per-bucket RMS (PeaksFile shared type)`

---

### Task 2: 設計系統 `ui/src/theme.css` ＋依賴安裝

**Files:**
- Create: `ui/src/theme.css`
- Modify: `ui/index.html`（刪 `<style>` 塊，只留 meta/root/script）
- Modify: `ui/src/main.tsx`（`import './theme.css'`）
- Modify: `ui/package.json`（新依賴）

**Interfaces:**
- Produces: CSS 變數（`--bg --surface --card --line --line-strong --text-1 --text-2 --text-3 --accent --accent-2 --accent-soft --audio --audio-soft --ok --danger --hl`）與 class：`.glass .panel-head .tag .btn-primary .btn-danger .icon-btn .seg .seg.on .badge .mono`。**原生 `button/select/input/textarea` 直接被 theme 樣式化**——後續 task 大多只需「刪 inline style」。

- [x] **Step 1: 安裝依賴** `npm i -w @vidcut/ui gsap @gsap/react lucide-react`
- [x] **Step 2: 寫 theme.css**（核心內容如下；完整檔含捲軸、reduced-motion 兜底）

```css
:root {
  --bg: #0d0e16;
  --surface: rgba(255, 255, 255, 0.05);
  --surface-2: rgba(255, 255, 255, 0.08);
  --card: #272d49;
  --line: rgba(255, 255, 255, 0.08);
  --line-strong: rgba(255, 255, 255, 0.14);
  --text-1: #e6e7f0;
  --text-2: #9ba0b8;
  --text-3: #5d6275;
  --accent: #8b5cf6;
  --accent-2: #6366f1;
  --accent-soft: rgba(139, 92, 246, 0.2);
  --audio: #0ea5e9;
  --audio-bright: #7dd3fc;
  --ok: #34d399;
  --danger: #f87171;
  --hl: #fbbf24;
  --r-panel: 10px;
  --r-card: 9px;
  --r-ctl: 7px;
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; }
body {
  margin: 0;
  background: linear-gradient(180deg, #151726 0%, var(--bg) 40%);
  color: var(--text-1);
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang TC', 'Noto Sans TC', sans-serif;
  font-size: 13px;
}
.mono { font-variant-numeric: tabular-nums; }
/* —— 原生控件全面接管 —— */
button {
  font: inherit; color: var(--text-1);
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-ctl); padding: 5px 10px; cursor: pointer;
  transition: background .12s ease, border-color .12s ease, transform .12s ease;
}
button:hover:not(:disabled) { background: var(--surface-2); border-color: var(--line-strong); transform: translateY(-1px); }
button:active:not(:disabled) { transform: translateY(0); }
button:disabled { opacity: .45; cursor: default; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 1px;
}
.btn-primary {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  border: none; color: #fff; font-weight: 600;
  box-shadow: 0 2px 12px rgba(139, 92, 246, 0.35);
}
.btn-primary:hover:not(:disabled) { background: linear-gradient(135deg, #9a70f8, #7478f3); }
.btn-danger { color: var(--danger); border-color: rgba(248, 113, 113, 0.35); }
.icon-btn { display: inline-flex; align-items: center; gap: 5px; padding: 5px 8px; }
input, select, textarea {
  font: inherit; color: var(--text-1);
  background: rgba(0, 0, 0, 0.25); border: 1px solid var(--line);
  border-radius: var(--r-ctl); padding: 5px 8px;
  transition: border-color .12s ease;
}
input:hover, select:hover, textarea:hover { border-color: var(--line-strong); }
input[type='color'] { padding: 2px; height: 28px; }
input[type='checkbox'] { accent-color: var(--accent); }
input[type='range'] { accent-color: var(--accent); padding: 0; background: none; border: none; }
a { color: #a5b4fc; }
/* —— 佈局積木 —— */
.glass { background: var(--surface); border-bottom: 1px solid var(--line); }
.panel-head {
  font-size: 11px; letter-spacing: .4px; color: var(--text-3);
  text-transform: uppercase;
}
.tag { font-size: 11px; color: var(--text-2); }
.seg { background: var(--surface); border: 1px solid var(--line); color: var(--text-2); }
.seg.on { background: var(--accent-soft); border-color: rgba(139, 92, 246, 0.5); color: #c4b5fd; }
.badge {
  font-size: 10px; padding: 0 6px; border-radius: 8px;
  background: var(--accent-soft); color: #c4b5fd;
}
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.12); border-radius: 5px; border: 2px solid transparent; background-clip: content-box; }
::-webkit-scrollbar-thumb:hover { background-color: rgba(255, 255, 255, 0.2); }
::-webkit-scrollbar-track { background: transparent; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
```

- [x] **Step 3: index.html 刪 inline `<style>`；main.tsx 首行 `import './theme.css'`**
- [x] **Step 4: build + 手開 dev server 目視**（原生控件應立即改觀）
- [x] **Step 5: Commit** `feat(ui): design system theme.css + gsap/lucide deps`

---

### Task 3: 版面 — 頂欄匯出、右欄分頁、審核條 overlay、面板收合、Inspector/CaptionList/Activity 換 class

**Files:**
- Create: `ui/src/panels/ExportMenu.tsx`（RenderBar 邏輯搬入下拉）
- Delete: `ui/src/panels/RenderBar.tsx`
- Modify: `ui/src/App.tsx`（整個 return 重寫 + Toast 樣式）
- Modify: `ui/src/stores/view.ts`（`leftOpen/rightOpen/toggleLeft/toggleRight`）
- Modify: `ui/src/panels/ReviewBar.tsx`（overlay 定位＋新樣式，動效 Task 5）
- Modify: `ui/src/panels/Inspector.tsx`、`CaptionList.tsx`、`Activity.tsx`（刪 inline style 改 class；快捷鍵表收進 `?` popover）
- Modify: `ui/src/player/Player.tsx`（刪底部 transport 列——移去 Timeline）

**Interfaces:**
- Consumes: theme class（Task 2）
- Produces: `useView` 新欄位 `leftOpen: boolean; rightOpen: boolean; toggleLeft(): void; toggleRight(): void`；App grid `gridTemplateColumns: leftOpen ? '260px' : '0px' … rightOpen ? '320px' : '0px'` 帶 `transition: grid-template-columns .25s ease`；右欄 tab state 放 App 本地 `useState<'captions' | 'activity'>`

- [x] **Step 1: view store 加收合欄位**（預設皆 true）
- [x] **Step 2: ExportMenu**——主鈕 `.btn-primary`「匯出 ▾」，點開 popover（絕對定位卡片）含解析度/畫質/fps select、設封面鈕、成品與封面連結；渲染中主鈕顯示進度%（禁用）；頂欄另有 4px 細進度條（漸層填充）。沿用 RenderBar 的 PRESETS/QUALITY 與 `sendRender/sendSetCover` 呼叫，行為不變。
- [x] **Step 3: App.tsx 重寫版面**

```tsx
<div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
  <header className="glass" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '7px 14px', position: 'relative', zIndex: 30 }}>
    <b style={{ fontSize: 15, background: 'linear-gradient(90deg,#a78bfa,#60a5fa)', WebkitBackgroundClip: 'text', color: 'transparent' }}>vidcut</b>
    <span className="tag">{doc?.name ?? '—'} · v{version}</span>
    <span style={{ marginLeft: 'auto' }} className="tag">
      <span style={{ color: connected ? 'var(--ok)' : 'var(--danger)' }}>●</span> {connected ? '已連線' : '未連線'}
    </span>
    <ExportMenu />
  </header>
  <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
    <ReviewBar />  {/* absolute overlay，蓋在內容上，不擠版面 */}
    <div style={{ flex: 1, display: 'grid', gridTemplateColumns: `${leftOpen ? '260px' : '0px'} 1fr ${rightOpen ? '320px' : '0px'}`, minHeight: 0, transition: 'grid-template-columns .25s ease' }}>
      {/* 左欄/右欄外層 overflow:hidden，內層固定寬，收合時內容不擠壓變形 */}
    </div>
  </div>
  <Timeline />
  <Toast />
</div>
```

  面板收合鈕：左右欄 panel-head 上的 `⟨`/`⟩`（lucide `PanelLeftClose`/`PanelRightClose`）；收合後在中欄邊緣顯示反向展開鈕。右欄 head 是兩個 `.seg` tab（字幕 N / 活動），內容區依 tab 切換。
- [x] **Step 4: ReviewBar** → `position: absolute; top: 0; left: 50%; transform: translateX(-50%)`、玻璃卡（`--surface-2` 底、紫邊、陰影、圓角下緣）、核准 `.btn-primary`-綠變體（inline 綠漸層）、退回 `.btn-danger`。
- [x] **Step 5: Inspector/CaptionList/Activity 清 inline style**——label/區塊用 `.tag`/`.panel-head`；快捷鍵表改成標題列 `?` icon-btn 的 popover 卡。Player 刪底部 `<div>`（transport 移 Task 4）。
- [x] **Step 6: typecheck + lint + build + 目視；Commit** `feat(ui): new shell layout — header export, right-panel tabs, collapsible panels, overlay review bar`

---

### Task 4: 時間軸重繪（波形帶、卡片化、工具列 transport、playhead）

**Files:**
- Create: `ui/src/timeline/waveform.ts`（純繪製函式，供片段帶與音訊軌共用）
- Modify: `ui/src/timeline/Timeline.tsx`（ClipBlock 視覺、工具列、尺規、軌道 chips、playhead/吸附線）

**Interfaces:**
- Consumes: `PeaksFile`（Task 1）、theme 變數
- Produces:

```ts
export function drawWaveform(
  cv: HTMLCanvasElement,
  pf: PeaksFile,
  opts: { from: number; duration: number; peakColor: string; rmsColor: string; midline?: boolean },
): void;
// from/duration 皆為來源秒數。DPR-aware：內部依 clientWidth*dpr 設定 cv.width。
// 鏡像包絡：峰值層＋（pf.rms 存在時）RMS 層；midline 預設 true。
```

- [x] **Step 1: waveform.ts**

```ts
import type { PeaksFile } from '@vidcut/shared';

export function drawWaveform(cv, pf, opts) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (W === 0 || H === 0) return;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d'); if (!ctx) return;
  ctx.scale(dpr, dpr);
  const bps = pf.sampleRate / pf.samplesPerBucket;
  const first = Math.floor(opts.from * bps);
  const count = Math.max(1, opts.duration * bps);
  const mid = H / 2, pad = 1;
  const fill = (data: number[], color: string) => {
    ctx.beginPath(); ctx.moveTo(0, mid);
    for (let x = 0; x < W; x++) {
      const v = data[first + Math.floor((x / W) * count)] ?? 0;
      ctx.lineTo(x, mid - v * (mid - pad));
    }
    for (let x = W - 1; x >= 0; x--) {
      const v = data[first + Math.floor((x / W) * count)] ?? 0;
      ctx.lineTo(x, mid + v * (mid - pad));
    }
    ctx.closePath(); ctx.fillStyle = color; ctx.fill();
  };
  ctx.clearRect(0, 0, W, H);
  if (pf.rms) { fill(pf.peaks, opts.peakColor); fill(pf.rms, opts.rmsColor); }
  else fill(pf.peaks, opts.rmsColor);           // 舊檔退回單層
  if (opts.midline !== false) { ctx.fillStyle = 'rgba(230,231,240,0.18)'; ctx.fillRect(0, mid - 0.5, W, 1); }
}
```

- [x] **Step 2: ClipBlock 重寫視覺**——`ROW_H` 56→64；結構改為上 label 區（filmstrip 背景）＋下 40% `.wvband`（`rgba(0,0,0,0.32)` 底＋canvas 吸滿）；`border` 刪除改 `boxShadow: inset 0 0 0 1px var(--line-strong)`，選取 `inset 0 0 0 1.5px var(--accent), 0 0 14px rgba(139,92,246,.35)`；圓角 `var(--r-card)`；frozen：波形帶畫一條 `rgba(255,255,255,.15)` 平線＋label 前 `<Snowflake size={11} />`；靜音（volume===0）canvas `opacity:.35`。波形色：peak `rgba(167,139,250,0.30)`、rms `rgba(196,181,253,0.85)`。canvas 繪製 effect 依 `[peaks, clip.in, clip.duration, w]`，改呼叫 `drawWaveform`。trim handle 改 6px 寬、`rgba(255,255,255,0.22)`、hover 提亮（CSS class `.handle`，theme.css 加 `.handle:hover { background: rgba(255,255,255,.45) }`）。
- [x] **Step 3: 工具列**——左側 transport：`SkipBack`（seek 0）、`Play`/`Pause`（依 playing）、`SkipForward`（seek total）＋時間碼 `<span className="mono" style={{color:'#c4b5fd'}}>{fmt(time)} <span className="tag">/ {fmt(total)}</span></span>`（`fmt = (t) => \`${Math.floor(t/60)}:${(t%60).toFixed(1).padStart(4,'0')}\``）；右側 zoom（`ZoomOut/ZoomIn/Maximize2` icon-btn）＋吸附（`Magnet`，開=`.seg.on`）。Player.tsx 的播放鈕已刪（Task 3）。
- [x] **Step 4: 軌道 chips**——overlay：`--ok` 系（`rgba(52,211,153,.18)` 底＋描邊）；caption：紫系；audio：`SUB_ROW_H` 24→30、青系底＋**全高波形 canvas**（`drawWaveform(cv, pf, { from: a.in, duration: a.duration, peakColor: 'rgba(14,165,233,0.30)', rmsColor: 'rgba(125,211,252,0.85)', midline: false })`，audio 的 peaks 從 `media.peaksPath` 取）；選中 chip＝亮色描邊。尺規：刻度字 `.mono .tag`、`borderBottom: 1px solid var(--line)`；吸附線 `background: var(--accent)`＋1px glow；playhead：2px `linear-gradient(#a78bfa,#6366f1)`＋`box-shadow: 0 0 10px rgba(139,92,246,.7)`＋頂端 9px 圓頭。
- [x] **Step 5: typecheck + lint + build + 目視（demo 專案重跑 ingest 看 RMS 波形）；Commit** `feat(ui): timeline redesign — waveform bands, card clips, transport toolbar, glow playhead`

---

### Task 5: GSAP 動效

**Files:**
- Create: `ui/src/motion.ts`（registerPlugin + `motionOK()`）
- Modify: `ui/src/panels/ReviewBar.tsx`、`App.tsx`（Toast、tab 切換）、`ExportMenu.tsx`（渲染完成 pulse + popover 進場）、`CaptionList.tsx`（當前句捲動置中）

**Interfaces:**
- Produces: `motion.ts`：

```ts
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
gsap.registerPlugin(useGSAP);
export { gsap, useGSAP };
export const motionOK = () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
```

- [x] **Step 1: ReviewBar 滑入**——容器 ref＋`useGSAP(() => { if (motionOK()) gsap.from(ref.current, { y: -24, opacity: 0, duration: 0.45, ease: 'back.out(1.6)' }); }, { scope: ref })`（mount 時跑一次；review 出現才 mount，天然對齊）。
- [x] **Step 2: 右欄 tab 切換**——內容容器 `useGSAP(() => { if (motionOK()) gsap.fromTo(el, { opacity: 0, x: 8 }, { opacity: 1, x: 0, duration: 0.2, ease: 'power2.out' }); }, { dependencies: [tab] })`。
- [x] **Step 3: Toast**——`useGSAP` mount 進場（y: 12→0, opacity）；訊息更換靠 `dependencies: [message]` 重播。
- [x] **Step 4: 匯出鈕 pulse**——ExportMenu 監看 `render?.status`，`useGSAP(... dependencies: [status])` 內 `if (status === 'done' && motionOK()) gsap.fromTo(btnRef.current, { scale: 1 }, { scale: 1.06, yoyo: true, repeat: 1, duration: 0.18, ease: 'power1.inOut' })`；popover 開啟時 `gsap.from(pop, { opacity: 0, y: -6, duration: 0.18 })`。
- [x] **Step 5: CaptionList 當前句**——`useEffect` 依 `currentId`：`rowRef.scrollIntoView({ block: 'nearest', behavior: motionOK() ? 'smooth' : 'auto' })`；高亮背景色已由 CSS `transition: background .2s` 平滑。
- [x] **Step 6: typecheck + lint + build + 目視全部動效；Commit** `feat(ui): GSAP motion — review bar, tabs, toast, render pulse`

---

### Task 6: 全面驗證與文件

- [x] **Step 1: 全測試** `npm test`（143+新增全綠）；`npm run typecheck`；`npm run lint`；`npm run format`；`npm run build -w @vidcut/ui`
- [x] **Step 2: demo 專案重建**（`rm -rf projects/demo && npm run demo` 背景起）→ dev server 目視六項：頂欄匯出流程、右欄分頁、面板收合、審核條（curl 打 MCP request_review 觸發）、時間軸波形/transport、拖曳讓位動畫仍在
- [x] **Step 3: HANDOFF.md / README.md 更新**（UI 重設計段落、theme.css 與 motion.ts 加進 code map、驗收清單）
- [x] **Step 4: 最終 commit**

## Self-Review checklist

- Spec 覆蓋：§1 theme→Task 2、§2 版面→Task 3、§3 時間軸→Task 1+4、§4 動效→Task 5、§5 資料相容→Task 1（rms optional + 退回單層）、§6 驗收→Task 6 ✓
- 型別一致：`PeaksFile` 名稱在 Task 1 定義、Task 4 消費 ✓；`drawWaveform` 簽名兩處一致 ✓
- 無 placeholder ✓（機械性「刪 inline style 換 class」附了目標 class 名）
