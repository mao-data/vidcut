# Agent Presence——AI 存在感升級(紙上分鏡世界駐編輯器大使館)

日期:2026-08-14 · 狀態:**設計定案**(使用者核准方向與分階段工序)
前情:`docs/research/2026-08-13-ui-optimization-proposal.md` Tier 1-7「AI 進行中狀態」;
Inspector 的 AgentStatus 區塊(`ui/src/panels/Inspector.tsx` 的 `AgentStatus`,2026-08-13 落地)。

## 1. 問題與目標

vidcut 的核心迴路是「AI 剪、人監修」,但 UI 只呈現**過去式**:連線與否
(header 的 `●` + Connected/Offline,`ui/src/App.tsx` 約 241 行)與已完成的變更
(AgentStatus 最近 3 筆、Activity 面板)。**AI 正在做什麼看不到**——對標 Vyra 的
體驗亮點(「On it. Watching your 9 clips now」),這是實用層最大的缺口。

目標:(a) AI 工具呼叫進行中即時可見;(b) session 統計讀數;(c) 視覺上成為
編輯器的記憶點——採用 `site/DESIGN.md` 的紙上分鏡世界。

## 2. 概念:大使館

**深色編輯器維持原樣;只有 AI 存在感相關的元素是紙。** AI 就是 landing page
(`site/index.html`)上那個用鉛筆打草稿的分鏡師;它在編輯器裡的存在感,是深色
剪輯室裡唯一的紙上物件——一張貼在 header 的膠帶紙條、一張釘在 Inspector 的
索引卡。黑房間裡的紙天然醒目,美學與實用同向。

`site/DESIGN.md` 原本明文禁止把紙世界帶進編輯器;使用者已核准**唯一例外**
(大使館條款,見該檔 Scope 段與 Don't 末條的修訂)。紙物件僅限本 spec 的兩件,
不得擴散。

## 3. 範圍

### 3.1 Server:`agentActivity` 廣播(非 Command,不動 doc)

- `shared/src/types.ts` 的 `WsServerMsg` 聯集(364 行起)新增:
  `{ type: 'agentActivity'; phase: 'start' | 'end'; tool: string; callId: string }`。
- 發射點:`server/src/mcp.ts` 的 `createMcpServer` 內做一層 `registerTool` 包裝,
  handler 進入廣播 start、離開(含拋錯)廣播 end——31 個工具一次涵蓋,不逐一改。
- 傳遞:照 `renderProgress` 的既有前例(`server/src/render.ts` 的
  `renderProgressBus` EventEmitter → `server/src/wsHub.ts` 52 行監聽後廣播)。
- **硬性驗收:MCP 工具面 snapshot(`server/test/mcp-surface-snapshot.test.ts`)
  必須逐位元組不變**——包裝層只攔執行,不碰 name/description/schema。

### 3.2 UI 狀態機(store 層,無視覺)

三態,由兩個既有訊號+一個新訊號推導:

| 態        | 條件                                                    |
| --------- | ------------------------------------------------------- |
| `offline` | WS 未連(`useProject.connected === false`)               |
| `idle`    | 已連且無進行中呼叫                                      |
| `working` | 進行中呼叫集合非空(以 `callId` 計,start 加入、end 移除) |

- WS 斷線 → 清空進行中集合(**不得卡假忙碌**;server 死了 ws 必斷,天然自癒)。
- 工具連發(如 `set_timeline` 批次)靠 `callId` 集合天然去抖;顯示最新一筆的
  `tool` 名與其經過秒數。
- Session 統計:純前端推導,零 server 變更——`useActivity.entries` 的
  `source === 'ai'`/人 分計、`useProject.version`。

### 3.3 Header 紙條(取代 App.tsx 241–242 行的 ● Connected)

膠帶貼住的小紙條(Dynamic-Island 式形態變化):

- **offline**:紙條灰調、手繪圈是 graphite-faint 虛線;文字 `NO AGENT`。
- **idle**:圈畫滿(graphite),`AGENT READY` label caps。
- **working**:紙條伸長,mono 工具名浮現+經過秒數;手繪圈持續重畫自己
  (stroke reveal 循環)。
- 點擊:`setTab('activity')`(分頁狀態在 `ui/src/App.tsx` 69 行,紙條就渲染在
  App 的 header 內,直接可及)+右欄若收合則展開(`useView.rightOpen`)。
- `role="status"` + `aria-live="polite"`;三態文字對讀屏幕完整可讀。

### 3.4 Inspector 索引卡(重製 `AgentStatus`)

紙質索引卡釘在面板裡(未選取時顯示,現機制不變):

- 圈+狀態行(與紙條共用同一份 store 推導,不重複實作)。
- working 時:`▸ tool_name 00:12`(mono;transcribe 可跑數分鐘,要有活著的感覺)。
- 最近 3 筆:**卡內改用 Two-Hands 分色——AI=graphite、you=紅鉛筆**,附署
  `—AI`/`—you`(graphite-faint);**卡外的 Activity 面板維持既有紫/藍不動**。
- Session 讀數列:`v{version} · AI {n} · you {m}`,mono tabular-nums,數字翻動。
- 離線時保留現有的 `claude mcp add …` 接回指令(既有行為,只換皮)。

### 3.5 視覺規格(全部取自 `site/DESIGN.md`,不發明新值)

| 項     | 值/作法                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 紙面   | paper-card `#f7f3e9`;圓角 3–4px;微轉(紙條 −1deg、索引卡 +0.8deg 級)                                                                              |
| 膠帶   | `rgba(214, 192, 122, .55)`,微轉,1px ink 色陰影                                                                                                   |
| 墨/筆  | ink `#26231d`、graphite `#4a463c`、graphite-faint `#635c4b`、紅鉛筆 `#c0392b`(只做筆畫與手寫,**絕不當底色**)                                     |
| 手繪圈 | SVG `pathLength="1"` + `stroke-dasharray:1; stroke-dashoffset` 揭示;`#pencil` 濁度濾鏡(feTurbulence 0.055/seed 7+displacement 2.6);linecap round |
| 字     | Jost(label caps,600/0.16em)、Caveat(手寫註記)、SF Mono(工具名/讀數,tabular-nums)                                                                 |
| 影     | 全部 ink 色 `rgba(38,35,29,α)` 小而軟;hover=物理輕推(translate/rotate),不加大陰影                                                                |
| 動效   | `cubic-bezier(.2,1.4,.4,1)` 彈簧;一律過 `motionOK()`(`ui/src/motion.ts`);reduced-motion=完成態瞬切                                               |
| 不用   | 綠 stamp(One-Pigment:核可專用,留給未來 review)、highlighter、紅底、7px 以上圓角                                                                  |

字型資產:Jost/Caveat woff2(皆 OFL 授權,與 AGPL 相容)放 `ui/public/fonts/`
(目錄現不存在,vite 慣例會打進 `ui/dist`),`@font-face` 進 theme.css;
**零 npm 依賴、不打 CDN**(本機優先是產品承諾)。

## 4. 反目標(明確不做)

- 不碰 wysiwyg 管線、Command 層、`applyCommand` 路徑、ReviewBar。
- 變更條目不可點(未核准)。紙世界不擴散到這兩件物件之外。
- 不動 Activity 面板與其配色。不新增 npm 依賴。
- 開源線合法:通用編輯器 UX,不涉 Pro 字幕能力表任何一列。

## 5. 分階段工序(每階段獨立 commit、獨立打槍點)

| 階段 | 內容                       | 驗收                                                              |
| ---- | -------------------------- | ----------------------------------------------------------------- |
| 2    | 3.1+3.2(訊號+store,無視覺) | old-coder 迴圈;mcp-surface snapshot 逐位元組不變;mutants;gauntlet |
| 3    | 3.3 紙條+字型資產          | 元件測試+mutants+`npm run verify:panels`+前後截圖                 |
| 4    | 3.4 索引卡                 | 同上+gauntlet 收尾                                                |
| 5    | main→cloud-p0 合併對帳     | cloud 側測試;`CLAUDE.cloud.md`/`HANDOFF.cloud.md` 過期才改        |

文件同步照 `.claude/skills/docs-sync-review/SKILL.md` 的矩陣逐階段執行
(HANDOFF 職責表、EVIDENCE、README 僅當對外敘述變假時動並雙語同步)。
