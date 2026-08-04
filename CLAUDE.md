# vidcut

AI 原生的直式短影音時間軸編輯器（1080×1920）：AI 走 MCP 剪片、人在瀏覽器 UI 監修。
本檔與 `HANDOFF.md` 是這個 repo 的權威來源，**優先於訓練知識**；有疑問先搜這個 repo。

## 架構要點

單一 Node 程序在 **:3845** 同時服務靜態 UI、`/media`、`/mcp`、`/ws` —— 沒有分離的前後端伺服器。
Server 服務的是 **`ui/dist`（build 產物）**，不是 Vite dev server。

## 指令

```bash
npx tsx server/src/index.ts projects/demo   # 起 server，載入既有專案
npm run demo                                # ⚠️ 會「重新產生」projects/demo，覆蓋既有內容
npm run dev:ui                              # UI 熱重載（:5173，另外開）
npm test                                    # 全部（真 ffmpeg + 真 whisper，約 25 秒）
npm run typecheck && npm run lint && npm run format:check
npm run verify:panels                       # 面板控制項的瀏覽器回歸檢查
```

- **改完 UI 原始碼必須 `npm run build -w @vidcut/ui`**，否則 :3845 上跑的還是舊版。
  只有 `npm run dev:ui` 那條路不用 build。
- `verify:panels` 需要 server 已在跑 + `ui/dist` 是最新的。
  換視窗尺寸：`VIDCUT_VIEWPORT=1280x620 npm run verify:panels`；
  Chrome 路徑可用 `CHROME_BIN` 覆寫（這台機器沒有 Chrome，用 playwright 快取的 Chromium）。
- `npm run format:check` 會抓到 `ui/coverage/*.json` 這類產生檔，不是你的問題。

## 鐵則

- **任何專案狀態變更都走 `applyCommand`**（人）或 `aiWrite`→`applyCommand`（AI）。
  不要旁路直改 doc。新增一種編輯操作是**三步，第三步不會自動發生**：
  1. `shared/src/types.ts` 的 `Command` 加 variant
  2. `commands.ts` 加驗證與 case（驗證一律寫在這層，不要寫在 MCP 或 UI）
  3. **`mcp.ts` 手動 `registerTool` 並同步 `instructions`** —— 漏了第三步，
     AI 就永遠碰不到這個能力（前例：`addClip` 做完八輪 TDD 卻沒人能用，
     因為只做了 1、2 步）
- **`projects/*/.env` 與各專案密鑰不得提交或印出內容。**
- **改了工具行為或語意，必須同步更新 `server/src/mcp.ts` 的工具描述與 instructions。**
  MCP 描述是 AI 使用者唯一的文件，過期描述會直接害它踩坑
  （前例：get_frame 描述殘留「M4 加 overlay 合成」的 roadmap 字句，
  但功能從未做，AI 因此誤判 overlay 沒設定成功）。

## UI 驗證的陷阱

這幾點踩過，會讓你量到錯的東西：

- **headless 下 CSS transition 可能數秒不推進**（畫面被節流）。用瀏覽器量版面前，
  先注入 `*{transition:none!important;animation:none!important}`，否則量到的是過渡中的座標。
- **`JSON.stringify(DOMRect)` 回 `{}`** —— 拿它比對「版面是否穩定」會立刻假性通過。要逐欄取值。
- **React 不會在同一次 `Runtime.evaluate` 內同步 flush**。程式化點擊後要另一次呼叫才讀得到新 DOM。
- `theme.css` 檔尾的 `@media (prefers-reduced-motion)` 用 `*{transition:none!important}`，
  **author `!important` 蓋得過 inline style**，所以元件行內的 transition 也會被關掉 —— 這是刻意的。

## Git

- 這個 repo 有自己的 `.git`（GitHub private `mao-data/vidcut`），在專案目錄內執行 git。
- **不要 `git add -A`**：這個工作區常有多個 session 同時進行，全加會把別人改到一半的檔案掃進你的 commit。
  只 stage 你自己動過的路徑。
- 除非使用者要求，不要自行 commit 或 push。

## 交叉參考

- `HANDOFF.md` —— 先讀這份，含各檔案職責與已完成/未驗證的分界
- `docs/ROADMAP.md` —— 上線計劃與可行方向
- `docs/superpowers/specs/` —— 各功能的設計定案；`docs/superpowers/plans/` —— 實作計畫
