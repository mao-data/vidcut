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
npm run dev:ui                              # UI 熱重載（vite，另外開；port 見下）
npm test                                    # 全部（真 ffmpeg + 真 whisper；機器空閒時約 70 秒，render 整合測試就占 48s）
npm run typecheck                           # 三 workspace tsc（目前乾淨）
npm run lint                                # 目前 exit 1，見下
npm run format:check                        # 見下
npm run verify:panels                       # 面板控制項的瀏覽器回歸檢查
npm run verify:canvas                       # 畫布縮放/拖曳/吸附導線的瀏覽器回歸檢查（4 項檢查、6 條斷言）
npm run verify:wysiwyg                      # 真 render + 真瀏覽器截圖，比對「預覽 vs 成品」的墨跡外框（目前全綠，見下）
```

- **改完 UI 原始碼必須 `npm run build -w @vidcut/ui`**，否則 :3845 上跑的還是舊版。
  只有 `npm run dev:ui` 那條路不用 build。
- `verify:panels` 與 `verify:canvas` 都需要 server 已在跑 + `ui/dist` 是最新的。
  換視窗尺寸：`VIDCUT_VIEWPORT=1280x620 npm run verify:panels`（`verify:canvas` 同樣吃這個環境變數）；
  Chrome 路徑可用 `CHROME_BIN` 覆寫。`findChrome()` 的順序是 `CHROME_BIN` →
  playwright 快取的 Chromium（`~/Library/Caches/ms-playwright/chromium-*`）→ `/Applications`，
  所以實際跑的一直是 playwright 那顆（`/Applications/Google Chrome.app` 現在也存在了，
  但排在後面，不會被選到——舊文件寫「這台機器沒有 Chrome」已經不正確）。
  **不要**用 `npm run demo` 當 `verify:canvas` 的前置——它會重新產生 `projects/demo`；
  直接 `npx tsx server/src/index.ts projects/demo` 起 server 即可。
  `verify:canvas` 的拖曳檢查會真的透過 WS 把 demo 專案裡一個 overlay 的位置寫回
  `projects/demo` 的 **`project.json`**（專案檔就叫這個名字，`doc` 是它裡面的鍵；
  位置小幅挪動，非破壞性，是 demo 專案本來就該承受的操作）。
- **`npm run dev:ui` 的 port 不保證是 :5173。** vite 從 5173 開始找，被占用就往上跳
  （實測 5173/5174 都被別的 session 占著時，它選了 **:5175**）——一律以 vite 啟動訊息
  印出的那一行為準。而且 vite dev server **只綁 IPv6（`[::1]`）**：
  `http://localhost:<port>` 通，`http://127.0.0.1:<port>` 連不上（`Couldn't connect`）。
  要在 dev 模式除錯字卡/字型時，這兩點是最先卡住人的地方。
- **`ui/vite.config.ts` 的 proxy 要涵蓋伺服器的每一條路由**：目前是 `/ws`、`/media`、
  `/api`、`/assets`、`/text-card`、`/fonts`。少一條**不會噴錯**——vite 的 SPA fallback 會
  回 `index.html`，於是字卡幾何 fetch 拿到 HTML（不是 JSON）→ 每句字幕永久退回 DOM 近似、
  `@font-face` 載到 HTML → 字型失效、`POST /text-card/preview` 404 → 打字三段式的第二段
  永遠不發生。`/text-card` 與 `/fonts` 曾經漏掉，整個字卡功能在 dev 模式下是死的；已補上
  並在 dev port 的真頁面裡驗過（幾何 200/JSON、preview 200 回 hash、字型檔 200、卡片
  `<img>` 載入成功、`@font-face` 有注入）。
- **`npm run verify:wysiwyg` 不需要你先起 server**，它自己在 :3999 起一台吃
  `os.tmpdir()/vidcut-wysiwyg-fixture` 的臨時專案（每次跑先整個刪掉重建），**不碰
  `projects/demo`、也不碰 :3845 上那台**。要換 port 用 `VIDCUT_WYSIWYG_PORT`。
  仍需要 `ui/dist` 是最新的（`npm run build -w @vidcut/ui`）與 python3/Pillow。
  兩邊量到的畫面會存成 PNG 放在臨時專案的 `measure/`，數字對不上時直接開圖看。
  `VIDCUT_PORT` 環境變數（`server/src/index.ts`）就是為了這支腳本才加的，
  要自己再開一台 server 吃別的專案時也用得上。
- **`npm run lint` 目前 exit 1**：34 個錯誤全部在 `.claude/worktrees/**`（別的 session 做到
  一半的 worktree，跟本 repo 追蹤的原始碼無關）。所以
  `npm run typecheck && npm run lint && npm run format:check` 這種 `&&` 串**永遠跑不到
  `format:check`**——三個要分開跑，或至少把 `format:check` 排在 `lint` 前面。
- **`npm run format:check` 該是乾淨的；它報的都是真的沒格式化的原始碼。**
  產生檔不會混進來——prettier 3 預設同時吃 `.gitignore` 與 `.prettierignore`，
  `node_modules`/`dist`/`coverage`/`projects` 都已被濾掉。所以看到 `[warn]` 就是
  真的有檔案沒格式化（曾經同時包含 `server/src/wsHub.ts`、`shared/src/types.ts`、
  `HANDOFF.md` 這種已提交的原始碼），請 `npm run format` 修掉，**不要當成雜訊放過**。

## 「預覽即成品」的實際範圍（別當全域保證用）

`caption-wysiwyg` 分支的招牌宣稱是「預覽看到的就是成品」。**非 karaoke 字幕與 overlay
（含文字 overlay）都成立**（2026-08-04 起）；karaoke 字幕仍是已知的、可重現的不一致。

**這件事有自動化在守了：`npm run verify:wysiwyg`**（`ui/e2e/preview-vs-export.mjs`）
會真的 render 一支影片、抽幀量墨跡外框，再用 headless Chromium 截同一時刻的預覽畫面、
換算回 1080×1920 座標量同一個外框，兩邊比。**現在五項全綠（最大差 1.1px，容差 4）**——
任何一項轉紅都是真的回歸，先看 `measure/` 裡的 PNG，不要動斷言。

- ✅ **字幕（無逐詞高亮）**：預覽與匯出走同一支 `text_card.py`、同一份參數，輸出 PNG
  **逐位元組相同**（sha256 相等）。實測涵蓋超寬文字、內嵌換行、未知字型、非 1080 畫布寬。
- ✅ **overlay（含文字 overlay）**（2026-08-04 修好，之前是本節最大的落差）：曾經有兩個
  互相疊加的成因——(a) 預覽端 `ui/src/player/Player.tsx` 給 overlay `<img>` 設了
  `maxWidth: 1080 * 0.9`，`server/src/render.ts` 卻是以原生尺寸合成（文字卡一律畫布全寬
  → 成品每次都比預覽大 `1/0.9 ≈ 11%`）；(b) `position.scale` 只有預覽端吃（CSS transform），
  **渲染端整條 overlay 濾鏡鏈上沒有任何 scale**，而 Inspector 有一個使用者改得動的 scale 欄位。
  修法是**兩邊都往「正確」收斂**：渲染端在 overlay 之前插 `scale=iw*s:ih*s`（`overlay` 的
  `w` 讀的是縮放後的寬，所以 `x=(W*x)-(w/2)` 的置中式子不用改，錨點不對稱也維持原樣），
  預覽端拿掉那個沒有渲染端對應物的 0.9 夾制、保留 CSS scale。
  實測：scale=1 從寬比 0.9011／最大差 43.9px → 1.0002／1.0px；
  scale=0.5 從 0.4505／244.0px → 1.0002／1.0px。
  ⚠️ 副作用（預期內）：既有專案（例如 `projects/demo` 的全寬排名卡）的**預覽**會比以前大 11%
  ——那才是成品一直以來的尺寸，不是回歸。
  ⚠️ `scale <= 0`／NaN 的 overlay **整張不合成**：ffmpeg 的 `scale=0` 意思是「沿用原尺寸」，
  照原樣疊上去等於又製造一次「預覽看不見、成品有一張全尺寸圖」的靜默落差。
- ✅ **掛在畫布外的 overlay**（`5537a43` 把拖曳夾制改成「中心留在畫布內」之後，
  `position.y` 才第一次可能是**負值**）：預覽靠 stage 的 `overflow: hidden` 裁、成品靠
  ffmpeg `overlay` 吃負座標裁，兩邊裁在同一條線上。這件事當初只有**手動**驗過一次
  （1920 畫布、200px 高的圖、`y=-0.05` → 成品只剩 104px），現在 `verify:wysiwyg` 有
  case（`ov_offtop`，t=4.5s，y=-0.03）守著：成品 `y0=0 h=31`（未裁時是 74）、預覽同值。
  ⚠️ **不要把這個 case 改成擺在角落**：stage 有 `borderRadius: 10`，預覽的四個角是圓角、
  成品是方角，圓角半徑換算回畫布座標約 17px（大於容差 4）——角落的墨跡會因為這個純視覺
  差異被判紅，那是假警報。所以那一項水平置中，只驗上緣。
- ❌ **karaoke 字幕**：預覽是「base 卡 + 全高亮卡疊 `clip-path`」，匯出是「**一個詞一張卡**」，
  不是同一張圖。兩個成因：(a) 描邊補償 `pad`（`max(2, fontSize/16)`，64px 字＝4px）
  會把**下一個還沒唸到的詞**露出約 4px 的高亮色；(b) 兩層 alpha 疊合讓描邊的反鋸齒邊變厚。
  實測單行 6 詞 CJK（64px、有描邊）各高亮狀態差 793–2764 個像素，最大單通道差 255。

還有一顆未爆彈：`server/src/render.ts` 在「ffmpeg 有 drawtext **且**沒有 karaoke」時會走
**原生 `drawtext` 分支**——那條路沒有 `fontfile=`、不換行（連 `\n` 都不處理），是完全不同的
光柵器。本機 ffmpeg 沒有 freetype 所以踩不到；換一台有 freetype 的機器，「預覽=成品」會
**靜默**失效，目前沒有任何測試或 assertion 擋著。**自動換行上線後這顆彈更大了**：字卡路徑
現在會折行，drawtext 分支還是單行——兩條路的差別從「字型不同」變成「排版整個不同」。

## 自動換行（2026-08-04；`OverlayText.maxWidth` 從死欄位變成真的生效）

在這之前 **`maxWidth` 是死欄位**：`text_card.py` 只在 `layout_tokens()` 裡用它折行，
而 `layout_tokens()` 只有請求帶 `tokens` 時才跑（＝只有 karaoke 字幕），
`server/src/textOverlays.ts` 從不給文字 overlay 塞 tokens。實測同一段長文字給 0.9 與 0.3，
輸出 PNG 的 sha256 相同、`lines` 都是 1——**文字 overlay 與字幕都不會換行，
太長的字直接被畫布邊緣裁掉，而且沒有任何警告**。

現在無 tokens 的路徑也會折行（`text_card.py` 的 `wrap_text()`）：

- 可用寬 = `width - cardMargin(width, maxWidthFrac) * 2`；`cardMargin()` 在
  `server/src/rasterizer.ts`，是**唯一**的換算來源。預覽（rasterizer worker）與匯出
  （`render.ts` 自己 spawn 的 CLI）都得用它——匯出端以前不傳 `margin`、靠 python 的預設
  `max(32, width // 20)`，那兩式只在畫布寬 ≥ 640 時同值，小畫布一折行就會分岔。
- **CJK 逐字折、拉丁整個單字為單位**（不切進單字中間）、換行點的空白丟掉、
  行首禁則標點（。，」）…）黏回前一行；**真的 `\n` 仍然強制換行**。
- 單一不可斷字串（超長網址、`maxWidth` 調到極小）比可用寬還長 → **逐字硬切**
  （等同 CSS `break-word`）。不會溢出被裁掉、不會無窮迴圈；只有「單一字元本身就比
  可用寬還寬」時該行才會溢出，而且只溢出一個字。
- ⚠️ **`server/src/cardBudget.ts` 的行數估算改成「每個字元各佔一行」的上界。**
  折行之後一行長文字可以變成幾百行，舊的 `split('\n').length` 會**低估**，像素預算就
  不再是保證（那個預算擋的是實測 40 GB／17 分鐘的 payload）。Node 這側沒有字型量測，
  所以只能取上界——代價是**很長的文字會被誤拒**（1080 寬、fontSize 64 時上限約 146 字，
  即使實際只會折成十行）。這個上界在「可用寬只放得下一個字」時會被真的打到
  （`textCards.test.ts` 有測試釘住等號），不是隨手放大的保險係數。
- ⚠️ **副作用（預期內）**：已存專案裡被裁掉的長文字現在會折行 → 字卡變高、
  hash 改變（內容定址，舊 PNG 變孤兒檔）。`projects/demo` 的 `try_text`（「拖我 213」，
  200px）實測寬 783 < 可用寬 918 → 仍是一行、PNG 位元組完全相同，不受影響。
- 回歸守門：`npm run verify:wysiwyg` 有一個「長文字自動換行」的 case（`ov_wrap`，
  maxWidth 0.7，t=3.5s）；`server/test/rasterizer.test.ts` 有一組行為測試（折行點 ≡ 手打 `\n`
  的 PNG 位元組相同）。**文字 overlay 的預覽與成品吃的是同一張 PNG**，所以
  `verify:wysiwyg` 的兩邊比對本身抓不到「換行沒實作」——那一項另外釘住了成品側的
  墨跡形狀（高 ≥ 2 行、寬 ≤ 可用寬），拿掉換行就會當場失敗。

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
- **`*{animation:none!important}` 擋不住 GSAP**。GSAP 是用 JS 逐幀寫 inline style，
  CSS 那條路關掉的只有 CSS 動畫/過渡。要讓 GSAP 整批不跑，唯一的開關是
  `ui/src/motion.ts` 的 `motionOK()`——在 CDP 端下
  `Emulation.setEmulatedMedia({features:[{name:'prefers-reduced-motion',value:'reduce'}]})`。
  沒下這道時實測踩過：讀完 stage 的 `getBoundingClientRect` 到 `Page.captureScreenshot`
  之間版面被面板動畫挪走，量到的墨跡座標整整偏 18 個畫布 px，看起來像一個貨真價實
  卻不存在的第三個「預覽≠成品」落差（`preview-vs-export.mjs` 因此還加了一道
  「截圖後複驗 rect 沒變」的保險——版面在動就當場失敗，不要輸出一個很有說服力的錯數字）。
- **`Page.captureScreenshot` 的 `clip` 會先被對齊到整數 CSS px 再乘 `scale`**，所以
  「我要 1080 寬」拿回來的可能是 1078。別假設輸出尺寸等於你要求的：一律用
  「實得影像尺寸 ÷ 實際送出的 clip 尺寸」回推每 CSS px 幾個影像 px，再加上
  clip 原點與目標元素原點的差去換算，否則會帶一個隨視窗尺寸浮動的系統性偏差。
- **`verify:canvas` 檢查 1 的「誤差 0.000%」不等於「預覽跟成品對齊」**。那段量測只讀
  `matrix(a,b,c,d,e,f)` 的 `a`（scaleX）：不看 `d`（scaleY）、不看 `e`/`f`（平移）、
  也不看 `transform-origin`。做過對抗性驗證——刻意把整層改成 `transformOrigin: center`
  （整片位移 391×696px）、把 transform 改成 `scale(a, a*1.5)`（垂直比例錯掉），
  同一段量測**照樣回報 0.000%**。它是一個貨真價實的獨立量測（新鮮的
  `getBoundingClientRect` vs 解析出來的 transform 矩陣），但它證明的只有
  「`ResizeObserver` 拿到的寬不是舊值、除數確實是 1080」，**不是**「畫面跟成品對齊」。
  要驗對齊只能真的 render 一次去比像素——那件事現在由 `npm run verify:wysiwyg` 做了
  （overlay/字幕的墨跡外框，不是整幀像素）。
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
  的拖曳檢查每次跑都會把 demo 專案的 overlay 位置存回 `project.json`，下一次跑的起點就是
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
