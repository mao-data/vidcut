---
paths: ["ui/**", "scripts/**"]
---

# UI 驗證：verify 腳本前提與量測陷阱

## verify 腳本的前提與環境變數

- `verify:panels` 與 `verify:canvas` 都需要 server 已在跑 + `ui/dist` 是最新的。
  換視窗尺寸：`VIDCUT_VIEWPORT=1280x620 npm run verify:panels`（`verify:canvas` 同樣吃）。
  Chrome 路徑可用 `CHROME_BIN` 覆寫。`findChrome()` 的順序是 `CHROME_BIN` →
  playwright 快取的 Chromium（`~/Library/Caches/ms-playwright/chromium-*`）→
  系統安裝路徑（`/Applications/Google Chrome.app`、`/usr/bin/google-chrome`、
  `/usr/bin/chromium`）——實際跑的一直是 playwright 那顆。三支 e2e 腳本各自帶一份
  **一模一樣**的 `findChrome()`（刻意不抽共用模組，理由見 `ui/e2e/preview-vs-export.mjs`
  檔頭）：改搜尋順序要三支一起改。
- **不要用 `npm run demo` 當 verify 的前置**——它會重新產生 `projects/demo`；
  直接 `npx tsx server/src/index.ts projects/demo` 起 server 即可。
- `verify:canvas` **不假設 t=0 就有 overlay**（`projects/demo` 是共用可變狀態，別的
  session 一改內容那個前提就沒了——曾因此每次都在「專案載入」逾時，看起來像 UI 壞了）。
  它用 Shift+→ 往前掃，找第一個看得到 overlay 的時刻。它的拖曳檢查會真的透過 WS 把
  demo 裡一個 overlay 的位置寫回 `project.json`（小幅、非破壞性）。
- `npm run verify:wysiwyg` **不需要先起 server**：自己在 :3999 起一台吃
  `os.tmpdir()/vidcut-wysiwyg-fixture` 的臨時專案（每次先刪掉重建），不碰
  `projects/demo` 也不碰 :3845。換 port 用 `VIDCUT_WYSIWYG_PORT`；需要 python3/Pillow。
  **`ui/dist` 過期它會自己擋下來**（`stalestSource()` 比對 `ui/src`、`shared/src`、
  `ui/index.html`、`ui/vite.config.ts`、`ui/package.json` 的 mtime，`.test.ts(x)` 除外）——忘記 build
  的話它量的是上一版 UI，全綠但毫無意義。**視窗太小也會擋**：stage 寬 < 400px 時量測
  本底雜訊超過 4px 容差，那種紅是量測誤差不是回歸。兩邊量到的畫面存成 PNG 放在臨時
  專案的 `measure/`，數字對不上直接開圖看。`VIDCUT_PORT`（`server/src/index.ts`）就是
  為這支腳本才加的。
- 上面沒提到、三支腳本**各自**還吃的環境變數（要並行跑或改連線目標時才用得到）。
  **不是每支都吃每一個**，設錯支不會報錯、只會沒效果：
  - `VIDCUT_URL`——`verify:panels`／`verify:canvas` 要打的網址，預設
    `http://127.0.0.1:3845/`。**`verify:wysiwyg` 不吃**（它打自己起的那台）。
  - `VIDCUT_CDP_PORT`——三支都吃，預設**刻意不同**：panels 9333／canvas 9334／
    wysiwyg 9336，所以同時跑不會互搶。
  - `VIDCUT_CDP_TIMEOUT_MS`——單發 CDP 逾時，預設 30000。只有 `verify:canvas` 與
    `verify:wysiwyg` 吃，**`verify:panels` 不吃**（那支沒有逾時保險絲，卡住的瀏覽器
    會讓它一直 pending，別浪費時間設這個變數）。
  - `VIDCUT_WYSIWYG_DIR`——臨時專案位置，預設 `os.tmpdir()/vidcut-wysiwyg-fixture`。
    **只有 `verify:wysiwyg` 吃。**
  - `VIDCUT_VIEWPORT`——三支都吃，但預設不同：panels／canvas 是 1440x820，
    wysiwyg 是 1200x1400。
- `verify:canvas` 檢查 1 的「誤差 0.000%」**不等於「預覽跟成品對齊」**。那段量測只讀
  transform 矩陣的 `a`（scaleX）：不看 `d`、`e`/`f`、transform-origin。對抗性驗證過——
  刻意把 transformOrigin 改成 center（整片位移 391×696px）、把 transform 改成
  `scale(a, a*1.5)`，照樣回報 0.000%。它證明的只有「ResizeObserver 拿到的寬不是舊值、
  除數確實是 1080」。要驗對齊只能真的 render 去比像素——那是 `verify:wysiwyg` 的事。

## dev 模式的坑

- **`npm run dev:ui` 的 port 不保證是 :5173**：vite 從 5173 往上找（實測跳到 :5175），
  一律以 vite 啟動訊息為準。且 vite dev server **只綁 IPv6（`[::1]`）**：
  `http://localhost:<port>` 通，`http://127.0.0.1:<port>` 連不上。
- **`ui/vite.config.ts` 的 proxy 要涵蓋伺服器每一條路由**：目前是 `/ws`、`/media`、
  `/api`、`/assets`、`/text-card`、`/fonts`。少一條**不會噴錯**——SPA fallback 回
  `index.html`，於是字卡幾何 fetch 拿到 HTML → 永久退回 DOM 近似、`@font-face` 載到
  HTML → 字型失效。`/text-card` 與 `/fonts` 曾漏掉，整個字卡功能在 dev 模式下是死的。

## lint / format

- `npm run lint` 應是乾淨的。曾經 34 個錯全在 `.claude/worktrees/**`（別的 session 的
  worktree），已把 `.claude/**` 加進 `eslint.config.js` 的 ignores。
- `npm run format:check` 報的都是真的沒格式化的原始碼（prettier 3 同時吃 `.gitignore`
  與 `.prettierignore`，產生檔不會混進來）。看到 `[warn]` 就 `npm run format` 修掉，
  **不要當雜訊放過**。

## 用瀏覽器量版面的陷阱（每一條都踩過）

- **headless 下 CSS transition 可能數秒不推進**（被節流）。量版面前先注入
  `*{transition:none!important;animation:none!important}`，否則量到過渡中的座標。
- **`JSON.stringify(DOMRect)` 回 `{}`**——拿它比對「版面是否穩定」會立刻假性通過。逐欄取值。
- **React 不會在同一次 `Runtime.evaluate` 內同步 flush**。程式化點擊後要另一次呼叫才讀得到新 DOM。
- `theme.css` 檔尾的 `@media (prefers-reduced-motion)` 用 `*{transition:none!important}`，
  **author `!important` 蓋得過 inline style**——元件行內 transition 也會被關掉，是刻意的。
- **`getComputedStyle(el).transform` 一律回 `matrix(a,b,c,d,e,f)`**，就算行內寫的是
  `scale(...)`。字串比對 `scale(` 直接落空；要 `.match(/matrix\(([^)]+)\)/)` 拆 6 個數字，
  `a` 就是 scaleX。
- **`*{animation:none!important}` 擋不住 GSAP**（JS 逐幀寫 inline style）。唯一開關是
  `ui/src/motion.ts` 的 `motionOK()`——CDP 端下
  `Emulation.setEmulatedMedia({features:[{name:'prefers-reduced-motion',value:'reduce'}]})`。
  沒下這道時實測：讀 rect 到截圖之間版面被面板動畫挪走，墨跡座標整整偏 18 畫布 px，
  看起來像一個不存在的「預覽≠成品」落差（`preview-vs-export.mjs` 因此加了
  「截圖後複驗 rect 沒變」的保險——版面在動就當場失敗）。
- **`Page.captureScreenshot` 的 `clip` 會先對齊整數 CSS px 再乘 `scale`**——要求 1080 寬
  可能拿回 1078。一律用「實得影像尺寸 ÷ 實際送出的 clip 尺寸」回推換算，否則帶一個隨
  視窗尺寸浮動的系統性偏差。
- **`document.querySelector('video')` 可能撞到不是你要的那顆**。Player 同時掛 A/B 兩顆
  播放 `<video>`，開 blur 填充還有第三顆背景模糊 video（刻意 `scale(1.15)`）。量版面要
  順著程式碼實際用的路徑走（例如 `Player.tsx` 的 `ResizeObserver` 觀測的同一個 stage
  容器），不要用泛用 selector 猜。
- **jsdom 沒有 `ResizeObserver`**——`ui/src/test/setup.ts` 已全域 polyfill 空殼版本，
  任何會 mount Player 的測試都需要它，不要逐檔補。
- **Node 的 undici `fetch` 對相對 URL 直接丟 `TypeError`**（不像瀏覽器用 baseURI 解析）。
  `ui/src/test/setup.ts` 已補「相對路徑一律當 404」的全域預設；個別測試要驗真實回應時
  用 `vi.stubGlobal('fetch', ...)` 蓋過。
- **`useRef` + 空 deps 的 `useEffect` 在元件首次 render 就 `return null` 時永遠掛不上**
  ——effect 只跑一次且那次目標元素還沒進 DOM。改用 callback ref + `useState`
  （見 `Player.tsx` 的 `stageEl`/`setStageEl`）。
- **`<img>` 預設原生可拖曳（HTML5 DnD），會搶走自訂 pointer 拖曳**：沒設
  `draggable={false}` 時，按下再移動的瞬間 `dragstart` 觸發、隨即 `pointercancel`，
  你的 `pointerup` 永遠不到。後果不是「拖曳沒反應」——本地 optimistic 覆蓋值**永久卡在
  放手座標**，畫面看似成功但命令從未送出，重新整理打回原形。真人真滑鼠也會踩到。
  任何用 pointer 做自訂拖曳的 `<img>` 都要 `draggable={false}`（`Player.tsx` 的 overlay、
  `CaptionLayer.tsx` 的字卡已修）。驗拖曳時「放手後位置沒變」不能只看一次就下結論——
  先確認 `pointerup` 真的送達（監聽 `pointercancel`/`dragstart` 排除這個坑）。
- **透明滿版容器會吃掉底下元素的 pointer 事件**（命中測試只看盒子不看 alpha）。字幕卡是
  全寬 PNG、兩側大片透明，且字幕層 DOM 順序在 overlay 之後——外層若用整張卡的框，
  playhead 停在字幕上時那條帶子裡的 overlay 全選不到。修法：`text_card.py` 幾何多回
  `ink: {x, w}`，`CaptionLayer.tsx` 的 `inkStyle()` 把命中框收斂到墨跡；DOM 近似路徑
  改成「外層 `pointerEvents:none` 置中、內層 `inline-block` 收縮到文字才吃事件」。
- **會寫回專案狀態的 e2e 腳本，位移量不能是「相對起點的固定偏移」**——每次跑的起點是
  上次的終點，固定偏移跑幾次就把元素逼到畫布邊緣，clamp 讓前後值撞在同一個數字，
  斷言穩定假性失敗。要算絕對目標座標（依目前值交替瞄準畫布另一側）。
