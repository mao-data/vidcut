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
npm run verify:canvas                       # 畫布縮放/拖曳/吸附導線的瀏覽器回歸檢查
```

- **改完 UI 原始碼必須 `npm run build -w @vidcut/ui`**，否則 :3845 上跑的還是舊版。
  只有 `npm run dev:ui` 那條路不用 build。
- `verify:panels` 與 `verify:canvas` 都需要 server 已在跑 + `ui/dist` 是最新的。
  換視窗尺寸：`VIDCUT_VIEWPORT=1280x620 npm run verify:panels`（`verify:canvas` 同樣吃這個環境變數）；
  Chrome 路徑可用 `CHROME_BIN` 覆寫（這台機器沒有 Chrome，用 playwright 快取的 Chromium）。
  **不要**用 `npm run demo` 當 `verify:canvas` 的前置——它會重新產生 `projects/demo`；
  直接 `npx tsx server/src/index.ts projects/demo` 起 server 即可。
  `verify:canvas` 的拖曳檢查會真的透過 WS 把 demo 專案裡一個 overlay 的位置寫回
  `projects/demo` 的 `doc.json`（位置小幅挪動，非破壞性，是 demo 專案本來就該承受的操作）。
- `npm run format:check` 會抓到 `ui/coverage/*.json` 這類產生檔，不是你的問題。

## 鐵則

- **任何專案狀態變更都走 `applyCommand`**（人）或 `aiWrite`→`applyCommand`（AI）。
  不要旁路直改 doc。新增一種編輯操作 = 在 `shared` 的 `Command` 加 variant
  - `commands.ts` 加驗證與 case → UI 與 MCP 自動都能用。
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
- **`getComputedStyle(el).transform` 一律回 `matrix(a,b,c,d,e,f)`**，就算行內寫的是
  `transform: scale(0.2057)`。字串比對 `scale(...)` 會直接落空；要 `.match(/matrix\(([^)]+)\)/)`
  拆出 6 個數字，`a` 就是 scaleX。驗證任何 CSS scale/transform 正確性都要走這條路。
- **`document.querySelector('video')` 可能撞到不是你要的那顆**。Player 同時掛
  A/B 兩顆播放用 `<video>`，開 blur 填充時還有第三顆背景模糊 video（帶
  `transform: scale(1.15)` 的刻意放大，遮住模糊邊緣），三顆 DOM 順序在先。
  量版面要順著程式碼實際用的那條路徑走（例如量 `Player.tsx` 的
  `ResizeObserver` 觀測的同一個 stage 容器），不要用泛用 selector 猜「反正
  是第一顆 video」——量出來的數字會看似合理（同比例）但其實是量錯元素。
- **jsdom 沒有 `ResizeObserver`**，Player 用它量 stage 寬（1080 座標空間縮放係數）
  ——`ui/src/test/setup.ts` 已全域 polyfill 一個空殼版本，任何會 mount Player
  的測試都需要它，不要逐檔補。
- **Node 的 undici `fetch` 對相對 URL（如 `/api/fonts`）直接丟 `TypeError`**，
  不像瀏覽器會用 `document.baseURI` 解析成絕對路徑。掛載就會發相對路徑
  fetch 的元件（例如 `App.tsx` 注入 `@font-face`）在 vitest/jsdom 下要有 shim
  ——`ui/src/test/setup.ts` 已補一個「相對路徑一律當 404」的全域預設，個別
  測試要驗真實回應時用 `vi.stubGlobal('fetch', ...)` 蓋過。
- **`useRef` + 空 deps 的 `useEffect` 在元件首次 render 就 `return null` 時永遠不會
  掛上**——effect 只跑一次，跑的那次目標元素還沒進 DOM，之後就算元件真的
  render 出來了也不會重新 observe。改用 `useState` 當 ref（callback ref：
  `<div ref={setStageEl}>`），元素真正掛上時 state 變了會自然重新跑
  依它為 dep 的 effect（見 `ui/src/player/Player.tsx` 的 `stageEl`/`setStageEl`）。
- **`<img>` 預設瀏覽器原生可拖曳（HTML5 drag-and-drop），會搶走自訂的 pointer 拖曳**。
  在一個掛了 `onPointerDown`/`setPointerCapture` 的 `<img>` 上按下再移動，只要沒設
  `draggable={false}`，原生拖曳手勢會在移動的瞬間搶走事件序列：`dragstart` 觸發、
  隨即 `pointercancel`，你自己的 `pointerup` 永遠不會到達。後果不是「拖曳沒反應」這種
  一眼看穿的失敗——本地的拖曳中覆蓋值（optimistic UI）會**永久卡在放手時的座標**（因為
  「放手」事件從未真正發生，沒有任何 commit/reconcile 邏輯會被觸發），畫面上看起來拖
  曳成功了，但從未送出過任何命令，伺服器端座標從未更新，重新整理就打回原形。這不是
  headless/CDP 合成事件才有的假象——是標準瀏覽器行為，真人用真滑鼠拖也會踩到（Task 16
  的 `verify:canvas` 就是這樣抓到 overlay 與字幕卡拖曳全壞掉的真 bug）。**任何要用
  pointer 事件做自訂拖曳的 `<img>` 都要 `draggable={false}`**（`ui/src/player/Player.tsx`
  的 overlay、`ui/src/player/CaptionLayer.tsx` 的字卡 `<img>` 已修）。用真瀏覽器驗證拖曳
  時，「放手後位置沒變」不能只看一次就結論「拖曳邏輯有 bug」——先確認 `pointerup`
  真的有送達目標元素（例如監聽 `pointercancel`/`dragstart` 排除這個坑），不然會誤修錯地方。

- **會真的寫回專案狀態的 e2e 腳本，位移量不能是「相對起點的固定偏移」**——`verify:canvas`
  的拖曳檢查每次跑都會把 demo 專案的 overlay 位置存回 `doc.json`，下一次跑的起點就是
  上一次的終點。固定偏移量（例如「永遠往右下拖 160px」）跑幾次後會把元素逼到畫布邊緣，
  clamp 會讓「拖曳前」與「拖曳後」的值撞在同一個被夾住的數字上，讓斷言穩定假性失敗
  （看起來像「拖曳沒生效」，其實是腳本自己把狀態作到牆角去了）。改成算絕對目標座標
  （依目前值在畫布哪一側，交替瞄準另一側），才能保證重跑任意次都不會收斂到邊界。

## Git

- 這個 repo 有自己的 `.git`（GitHub private `mao-data/vidcut`），在專案目錄內執行 git。
- **不要 `git add -A`**：這個工作區常有多個 session 同時進行，全加會把別人改到一半的檔案掃進你的 commit。
  只 stage 你自己動過的路徑。
- 除非使用者要求，不要自行 commit 或 push。

## 交叉參考

- `HANDOFF.md` —— 先讀這份，含各檔案職責與已完成/未驗證的分界
- `docs/ROADMAP.md` —— 上線計劃與可行方向
- `docs/superpowers/specs/` —— 各功能的設計定案；`docs/superpowers/plans/` —— 實作計畫
