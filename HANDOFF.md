# HANDOFF — vidcut 開發交接

> 目前做到哪、怎麼驗、已知限制、下一步。
> 最後更新：M1–M4 + T1 + T2#8（自動字幕）+ UI 重設計 + 字幕 WYSIWYG 階段 1（光柵器地基）+ 階段 2（可編輯文字 overlay）+ 階段 3（預覽字卡直出）+ 階段 4（畫布拖曳+吸附導線）**四階段全部完成**，含真瀏覽器回歸（`npm run verify:canvas`）。
>
> ⚠️ **「預覽=成品」對「沒有逐詞高亮的字幕」與 overlay 成立**（字幕已驗到 PNG sha256 逐位元組
> 相同；overlay 於 2026-08-04 修好兩個幾何落差，`npm run verify:wysiwyg` 三項全綠、最大差 1.0px）。
> **karaoke 字幕仍有已知、可重現的落差**——範圍與實測數字見 `CLAUDE.md`「『預覽即成品』的
> 實際範圍」與下面的階段 3 節。寫文件或對外描述這個功能時請一律帶上限定詞。

## 現況總覽

| 里程碑                | 狀態                                           | 內容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 看得到             | ✅ `m1-done`                                   | ProjectStore + WS 同步 + ffmpeg ingest + 唯讀時間軸 + A/B 無縫預覽                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| M2 改得動             | ✅ `m2-done`                                   | 命令層 + trim 拖拉 + 排序 + Inspector 編輯 + undo + 活動面板                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| M3 AI 接上            | ✅ `m3-done`                                   | MCP server（15 工具）+ request_review 審核閉環 + 編輯脈絡回報                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| M4 渲染               | ✅ `m4-done`                                   | ffmpeg 從 project.json 輸出 1080×1920 成品 + 進度 + UI 渲染鈕                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| T1 CapCut 快贏        | ✅ `t1-done`                                   | 見下節                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| T2 #8 自動字幕        | ✅                                             | whisper 逐字稿 + 自動斷句 + 逐詞高亮 + 字幕列表 UI，見下節                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| UI 重設計             | ✅                                             | 深藍紫玻璃視覺系統 + 峰值/RMS 波形 + GSAP 動效，見下節                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 字幕 WYSIWYG 階段 1–4 | ✅（分支 `caption-wysiwyg`，**四階段全完成**） | 階段 1：Pillow 常駐光柵器 + 字型表 + 字卡快取服務 + 字幕卡 debounce 同步。階段 2：**可編輯文字 overlay**——UI 時間軸「Text」鈕新增文字 overlay、Inspector 可改文字/字級/顏色，MCP `add_overlay`/`update_overlay`/`set_overlays` 皆支援 `text`。階段 3：**字幕預覽改走與成品同一張字卡**（**限非 karaoke**）——`fontSize/3` 估算已廢除，1080×1920 座標空間 + `transform: scale(stage寬/1080)`；karaoke 用 base+全高亮兩張幾何相同的卡疊 `clip-path` 逐詞揭色（**但匯出端是一詞一卡，兩者不是同一張圖**，見下節）；打字三段式即時預覽；真瀏覽器實測驗證縮放公式（見下節，注意那份量測不等於「預覽與成品對齊」）。階段 4：**畫布直接拖曳 overlay/字幕 + 吸附導線**——`shared/src/snap.ts` 的 `snapBBox` 純函數（水平置中/垂直置中/上下 5% 安全邊距，16px 吸附半徑）+ `ui/src/player/dragLayer.ts` 的錨點↔bbox 換算 + `Player.tsx` 的 pointer 拖曳與「放手後 echo 未到前」的本地覆蓋橋接；真瀏覽器 e2e 回歸（`npm run verify:canvas`，見下節）過程中抓到並修掉一個真 bug（`<img>` 原生瀏覽器拖曳手勢劫持 pointer 事件序列，見下節與 `CLAUDE.md`）。 |

**自動化狀態**（2026-08-04 於 `87514dd` + 工作區未提交變更實測，每一條都是真的跑過的）：

- `npm test` 全綠。測試數在本次覆核的兩小時內就從 511 變成 **515**（shared 39 / server 252 / ui 224），
  因為有另一條線在補測試——**這個數字沒有保存價值，別引用它，要就重跑**：

  ```bash
  npm test 2>&1 | grep -E '^ *Tests '   # 三個 workspace 各印一行，自己加總
  ```

  耗時：**沒有其他負載時約 70 秒**（實測 67s wall，其中 `server/test/render.test.ts`
  的真 ffmpeg 整合測試單獨就占 48s）。同機器上有別的重工作在跑時實測會到 2 分鐘以上
  ——量這個數字要在乾淨的機器上量，不然量到的是別人的 CPU。
  （舊版本說 `server/test/cardSync.test.ts` 的 debounce 測試會因搶 CPU 假性失敗——
  那條已經不成立：`e7376be` 之後該測試用 stub 的 `TextCardService`，不再 spawn 真的
  Pillow 子行程。）

- `npm run typecheck`：三 workspace 乾淨（exit 0）。
- `npm run lint`：**exit 1**，34 個錯誤全部在 `.claude/worktrees/**`（別的 session 的
  worktree），本 repo 追蹤的原始碼 0 問題。注意這代表
  `npm run typecheck && npm run lint && npm run format:check` 這種 `&&` 串跑不完。
- `npm run format:check`：見 `CLAUDE.md`——它報的都是真的沒格式化的原始碼（產生檔已被
  `.gitignore`/`.prettierignore` 濾掉），不是雜訊。
- UI 可 build。全部走真 ffmpeg、真 whisper、真 Pillow 與真 MCP/WS transport 驗證過。
- 真瀏覽器（非 jsdom）回歸：`npm run verify:panels`（面板）與 `npm run verify:canvas`
  （縮放/拖曳/導線/不盲拖，**4 項檢查、6 條斷言**）**都綠**，見下節「階段 4」。
  `npm run verify:wysiwyg`（真 render vs 預覽截圖的墨跡外框）**現在全綠**（2026-08-04 修掉
  overlay 那兩個缺陷之後），見「預覽 vs 成品的幾何回歸」節。
  ⚠️ `verify:canvas` 檢查 1 印的「誤差 0.000%」只驗了 transform 矩陣的 `a`（scaleX），
  **不足以推論「預覽跟成品對齊」**——理由見 `CLAUDE.md`「UI 驗證的陷阱」。

## 字幕 WYSIWYG 階段 1：光柵器地基（分支 `caption-wysiwyg`）

設計：[`docs/superpowers/specs/2026-08-03-caption-wysiwyg-design.md`](docs/superpowers/specs/2026-08-03-caption-wysiwyg-design.md)。目標是讓預覽字幕與匯出成品最終共用同一張 PNG；階段 1 只把「光柵器」這塊地基蓋好，**還沒有任何使用者看得到的行為變化**。

- **`text_card.py` 常駐 worker 模式**：`--worker` 讀 stdin/stdout 一行一 JSON，import PIL 與字型只付一次，之後每張卡約 7ms（相較逐次 spawn 的 50–70ms）。一次請求可同時產出「base 卡」與「全高亮卡」（karaoke 兩張圖疊 clip-path 的作法），並回傳逐詞 bounding box。**既有單卡 CLI 模式沒有變動**——`render.ts` 的匯出路徑目前仍走舊的逐次 spawn CLI，還沒接上 worker。
- **`server/src/rasterizer.ts`（新）**：`PillowRasterizer`（`id='pillow-1'`）把 worker 包成 TS 介面：`resolveFontPath`（public 可變，因為字型表要靠它自己 probe 後再回填）、`probeFont`、`rasterize`、`dispose`。
- **`server/src/fonts.ts`（新）**：`loadFontTable(rasterizer)` 啟動時用真 Pillow 逐一實測候選字型檔，**開不了的直接剔除**（本機 `/System/Library/Fonts/PingFang.ttc` 開不了，已剔除，落到 Heiti TC）；`fontResolver(table)` 給 family→路徑（完全比對，否則落到表首位，否則 undefined）。新端點 `GET /api/fonts`（回 `{id, family}[]`）與 `GET /fonts/:id`（真的把字型檔案送出，供之後 UI `@font-face` 用）。
- **`server/src/textCards.ts`（新）**：`cardKey()` 內容雜湊（含 rasterizer id，換引擎全快取自動失效）；`TextCardService.ensure()` 查快取未命中才產卡，寫 `derived/text/` 下的三個檔：
  **`<hash>.json`（幾何，只有這一份，沒有 `.base.json`）、`<hash>.base.png`、
  `<hash>.hl.png`（只有帶 tokens 的 karaoke 字幕才會產）**——別再用
  `<hash>.{base,hl}.json/.png` 這種大括號寫法，它會讓人以為有 `<hash>.base.json`。HTTP：靜態 `/text-card/*`（`immutable` 強快取）+ `POST /text-card/preview`（只產卡，不碰 doc/history/廣播，供之後打字即時預覽用）。輸入驗證完整（壞掉的 style 回 400，之前會靜默產出預設樣式的卡）。
- **`server/src/cardSync.ts`（新）**：`CaptionCardSync` 在字幕軌變更後 debounce 300ms 重產全部字幕卡，透過新的 WS 訊息 `{type:'textCards', entries:[{id, hash}]}` 廣播 capId→hash 對照；啟動時預熱、新連線送目前的完整對照表。**單句產卡失敗會被隔離**——失敗的那句直接從 entries 缺席（其餘句照常產出），不會讓整批 latest 被舊資料污染。`ui/src/stores/project.ts` 對 `textCards` 訊息當時（階段 1）是 no-op 早退——**必須是早退**，否則會落進 patch 分支當成版本不符觸發無限 resync；**階段 3 這個早退分支改成真的收下** `{id → hash}` 存進 `captionCards`（早退本身沒變，只是分支內容從空動作變成 `set`），`CaptionLayer` 靠這份對照決定每句字幕該不該走字卡。
- **匯出路徑接上同一張字型表**：`render.ts` 的 `renderCaptionCard`（匯出用）現在會傳 `fontPath`，用 `setCaptionFontResolver` 在啟動時注入、與預覽路徑**同一個** resolver。在此之前匯出用的是另一條寫死的候選字型鏈，`fontFamily` 對成品完全無效；現在 `fontFamily` 真的同時影響預覽與匯出（過去兩邊都不影響）。有測試比對匯出卡與預覽卡的 PNG sha256 相同，並反向驗證「不注入 resolver 時輸出必須不同」（判別性防護，避免測試假陽性）。

**階段 1 完成時仍然成立、目前仍未變的事**：匯出成品的字幕仍然只有 PNG 字卡一條路（這台機器 ffmpeg 沒 drawtext，見下方「環境限制與字幕」節）；逐詞高亮在匯出端仍是「一個詞一張卡」。**UI 消費這些卡的部分已在階段 3 補上**——見下方「字幕 WYSIWYG 階段 3」節。

## 字幕 WYSIWYG 階段 2：可編輯文字 overlay（分支 `caption-wysiwyg`）

設計：同上規格 §6/§7。目標是讓「文字 overlay」（overlay 軌新增的一種，不是字幕）變成人與 AI 都能直接建立、改文字/字級/顏色的物件，渲染管線零改動。

- **資料模型**：`OverlayItem` 新增可選欄位 `text?: OverlayText`（`{text, fontFamily, fontSize, fill, stroke?, maxWidth?}`）；`updateOverlay` 的 patch 型別隨之納入 `text`（以及既有的 `imagePath`）。有 `text` 的才是文字 overlay，既有排名 PNG 沒有這個欄位，行為完全不變。
- **命令原子性**：產卡是非同步（要跑 Pillow worker），但 `applyCommand` 本身仍是同步、單一 mutate。做法是新增 `server/src/textOverlays.ts` 的 `resolveTextCommand()`，在 `applyCommand` 之前跑一個「前置」：先產卡，把算出的 `imagePath` 併進**一個新的 command 物件**再丟給 `applyCommand`——`text` 與 `imagePath` 保證落在同一次 `store.mutate`，不會出現字改了、圖還沒換的中間態。`server/src/wsHub.ts` 的 command handler 因此改成 async，並用一個 promise chain 把 command 序列化，確保仍照抵達順序套用（不會因為前置產卡是非同步而亂序）。
- **命令層驗證（backstop）**：`commands.ts` 新增共用的 `validateOverlayTextCard()`——`text` 已給但 `imagePath` 是 `undefined` 或 `''`、`text` 全空白、`fontSize <= 0` 都會被拒絕。這是安全邊界：就算某個呼叫端忘了跑 `resolveTextCommand` 前置，也不會讓一個沒有實際圖檔的 `imagePath` 存進 doc——空字串會被 `join(projectDir, '')` 解析成專案目錄本身，餵給 `ffmpeg -i` 只會在 render 階段悄悄失敗。
- **`render.ts` 完全沒改**：它只認 `imagePath`，文字 overlay 的 PNG 就是一個真實檔案，跟排名 PNG 沒有差別。
- **MCP**：`add_overlay`、`update_overlay`、`set_overlays` 三個工具都接受 `text` 並各自跑前置產卡（`set_overlays` 起初共用的 `overlaySchema` 讓它可以帶 `text` 卻沒接前置，code review 抓到——沒接前置就可能把一個空 `imagePath` 的文字 overlay 存進 doc，render 階段才炸；已修，並靠 `validateOverlayTextCard` 這道命令層 backstop 兜底）。`McpDeps.textCards` 從此是必要欄位；三個工具的描述與 server 層 `instructions` 都同步更新（遵守下面 CLAUDE.md 的鐵則）。**MCP schema 的 `imagePath` 是選填，且 `overlaySchema` 的 `superRefine` 強制「`text` 與 `imagePath` 恰好給一個」**：帶 `text` 時再給 `imagePath` 會被明確拒絕（以前是靜默丟棄呼叫端給的路徑），兩個都不給或 `imagePath: ''` 同樣拒絕。初版讓 `imagePath` 必填、文字 overlay 傳空字串佔位，但**那個空字串正是 `validateOverlayTextCard` 用來判定「前置沒跑」的毒藥哨兵**——工具描述教人傳的值等於驗證層視為致命錯誤的值，安全與否全靠前置夾在中間換掉；順手也讓 AI 呼叫端不會因為「`imagePath` 必填」而誤以為得自己先生一張 PNG。
- **UI**：時間軸工具列新增「Text」鈕，點下去在 playhead 插入一個帶預設樣式（`Heiti TC`）的文字 overlay；Inspector 對帶 `text` 的 overlay 顯示文字/字級/顏色三個編輯欄位，每次送出都是**完整的 `OverlayText` 物件**（伺服器用整份 spec 算 hash，沒有單欄位 patch 語意）。輸入框是 uncontrolled、依目前值 keyed，切換 overlay 時會正確刷新；blur handler 會跟 store 裡目前的值比對，no-op blur 不會誤送命令。

**現在使用者可以做什麼**：在瀏覽器 UI 按「Text」鈕直接在畫布上新增一段文字（或請 AI 用 `add_overlay`/`update_overlay`/`set_overlays` 帶 `text` 建立/改字），改完文字/字級/顏色後渲染成品會真的燒出那段文字——這是本功能第一個使用者看得到的行為變化（階段 1 完全無感）。

**階段 2 完成時仍然成立、階段 3 已解決的事**：字幕預覽當時仍是 DOM 文字 `fontSize / 3` 估算，跟渲染成品的字卡不是同一張圖——見下節「字幕 WYSIWYG 階段 3」，這個落差已消除。

**階段 2 完成時仍然成立、目前仍未變的事**：

- 文字 overlay 在預覽裡確實看得到自己的字卡（`<img src=imagePath>`），但那只是因為預覽本來就把所有 overlay 畫成 `<img>`——是既有機制的副作用，不是本階段刻意做的 WYSIWYG 對齊。
- 沒有字型選單：`/api/fonts` 端點階段 1 就有了，但目前沒有任何 UI 程式碼消費它；新文字 overlay 一律用預設 `Heiti TC`。
- 沒有畫布拖曳（排在階段 4）。

## 字幕 WYSIWYG 階段 3：預覽字卡直出，預覽=成品（**限非 karaoke 字幕**，分支 `caption-wysiwyg`）

設計：同上規格 §7（§7 已依實作校對，見設計文件的落地備註）。目標：字幕預覽與匯出成品共用**同一光柵器、同一張 PNG**，消除 `fontSize/3` 這個估算縮放的分歧源。

> **先把宣稱的範圍講清楚（2026-08-04 對抗性覆核）**：「預覽=成品」**只有非 karaoke 字幕
> 真的成立**，而且成立得很扎實——同一段文字分別走匯出路徑（`render.ts` 的單卡 CLI）與
> 預覽路徑（`POST /text-card/preview` 的常駐 worker），輸出 PNG 的 **sha256 逐位元組相同**，
> 覆核涵蓋超寬文字、內嵌換行、未知字型與非 1080 的畫布寬。
> **overlay 與 karaoke 字幕都不成立**，理由與實測數字見 `CLAUDE.md`
> 「『預覽即成品』的實際範圍」——寫文件或跟使用者講這件事時請帶上限定詞，不要
> 講成整個編輯器的性質。

- **座標空間**：字幕層與 overlay 層共用 `ui/src/player/Player.tsx` 裡同一個 1080×1920 絕對定位 `<div>`，`transform: scale(stage寬/1080)`——`stage寬` 是量測「影片實際填滿的那個元素」（`stageEl`，`ResizeObserver` 觀測）的真實寬度，縮放係數只有這一處來源。`fontSize/3` 魔術除數已整個移除，`ui/src/player/CaptionLayer.tsx` 的 DOM 文字路徑（`ApproxCaption`）現在**只當 fallback**：字卡幾何**還沒開始 fetch 之前（該句尚無 hash）**或**已 fetch 但失敗**、或圖檔本身載入失敗（`onError`）時才會退回近似顯示；正常情況一律是 `<img src=/text-card/<hash>.base.png>` 直出，跟渲染成品同一張圖。**易錯點（已修過一次文檔用詞）**：字卡幾何「fetch 進行中」那個瞬間不是 fallback——`CardCaptionForHash` 對 `geo === 'pending'` 直接 `return null`，畫面是**空白一幀**，不是近似文字；近似文字只出現在「這句根本還沒有 hash（`cards[c.id]` 不存在）」或「fetch/圖檔載入確定失敗」這兩種情況。
- **karaoke（預覽端）**：base 卡 + 全高亮卡（`.hl.png`）兩張**幾何完全相同**的圖疊在一起，上層用 `shared/src/captions.ts` 的純函數 `karaokeClip(bboxes, activeIndex, pad)` 算出的 `clip-path` 逐詞揭色（`pad` 補償描邊外擴）；`tokenSeparator(prev, next)` 判斷詞間該不該插空白（CJK 不加、拉丁加），DOM fallback 與伺服端 `text_card.py` 的斷詞規則因此一致。**匯出端維持階段 1 就有的「一個詞一張卡」機制沒有變**（`server/src/render.ts` 的 `renderCaptionCards`）——兩卡+clip-path 目前只在預覽端，渲染端的「一詞一卡爆量」根治仍是後續工作（spec §2 非目標）。
  ⚠️ **所以 karaoke 字幕的預覽與成品不是同一張圖，實測也不一樣**：兩張卡疊 `clip-path` 合出來的畫面
  ≠ 匯出那張「第 k 個詞高亮」的單卡。兩個成因都可重現：(a) `karaokeClip` 的 `pad`
  （＝ `max(2, fontSize/16)`，64px 字是 4px）把每個 token bbox 四周外擴，於是**下一個還沒唸到的詞**
  的左緣約 4px 會被塗成高亮色；(b) hl 卡是獨立圖層 alpha 疊在 base 卡上，描邊的反鋸齒邊等於被畫兩次，
  比單卡厚。實測（單行 6 詞 CJK、64px、有描邊）各高亮狀態差 **793–2764 個像素**，最大單通道差 255。
  修法要嘛匯出端也改走兩卡+clip-path，要嘛預覽端改成一次只畫一張「第 k 個詞高亮」的卡——兩條都還沒做。
- **打字三段式即時編輯**：`ui/src/stores/editDraft.ts`（新，`useEditDraft`）存打字中的本地草稿（`{id, text, previewHash}`），不進 history、不碰 project doc、不經 `sendCommand`。每鍵先以 DOM 近似顯示；停手 debounce 後打 `POST /text-card/preview` 換真卡（`previewHash` 到位後 `CaptionLayer` 改走 `CardCaption`）；失焦/Enter 才真的送 `updateCaption` 命令進 history。
- **真瀏覽器實測（Task 13 驗收）**：headless Chromium 量三個視窗尺寸（1440×820／1280×620／1920×1080），caption/overlay 層 `transform: scale(...)` 與 `stageWidth / 1080` 的誤差全部 **0.000%**（遠低於 ~1% 門檻）——`fontSize/3` 舊估算法在 1280×620 曾量到 3.28× 誤差，新公式在同一視窗尺寸下已消除該誤差。腳本為一次性（未進 repo，正式回歸腳本排 Task 16）。
- **測試環境補丁**：`ui/src/test/setup.ts` 新增全域 `ResizeObserver` polyfill（jsdom 無實作，Player 量 stage 寬要用）與相對路徑 `fetch` 的預設 404 shim（Node undici `fetch` 對 `/api/...` 這種相對 URL 直接丟 `TypeError`，不像瀏覽器會解成 `document.baseURI`）。

**現在使用者可以做什麼**：**沒有逐詞高亮的字幕**，預覽看到的字級/斷行/描邊/字型與渲染成品完全一致（同一張 PNG，sha256 相同），不再需要「先渲染才知道字幕實際長怎樣」；打字時近似文字先出、~80ms 後換真卡，畫面不空窗。

**目前仍然成立、還沒變的事**：

- 畫布拖曳／吸附導線見下節（階段 4，已完成）。
- 渲染端 karaoke 仍是「一詞一卡」，還沒接上階段 1/3 的「兩卡+clip-path」機制（spec §2 非目標，本次未變）——**這代表 karaoke 字幕的「預覽=成品」並不成立**，見上面 karaoke 那條的實測數字。
- ~~**overlay（含階段 2 的文字 overlay）的「預覽=成品」從來沒有成立過**~~ **2026-08-04 已修**：
  兩個落差（預覽端 `maxWidth: 1080*0.9` 夾制、渲染端沒實作 `position.scale`）都收斂到正確的一側
  ——`render.ts` 在 overlay 之前插 `scale=iw*s:ih*s` 真的實作了 scale，`Player.tsx` 拿掉那個沒有
  渲染端對應物的 0.9 夾制（CSS scale 保留）。`verify:wysiwyg` 的 overlay 兩項從最大差 43.9px／244.0px
  變成 1.0px／1.0px。**副作用（預期內、不是回歸）**：既有專案的全寬 overlay 預覽會比以前大 11%，
  那是成品一直以來的尺寸；畫布拖曳量到的 bbox 也跟著變成真實顯示尺寸，`verify:canvas` 重跑仍全綠。
  細節見 `CLAUDE.md`「『預覽即成品』的實際範圍」。
- **`OverlayText.maxWidth` 是死欄位**：`text_card.py` 只在 `layout_tokens()` 裡用它，而 `layout_tokens()` 只有帶 tokens 時才跑，`textOverlays.ts` 從不給文字 overlay 塞 tokens。實測同一段長文字給 0.9 與 0.3 產出的 PNG sha256 相同、`lines` 都是 1。**文字 overlay 不會換行，超出的字直接被畫布邊緣裁掉**。修法（真的實作換行）排在之後的批次，現在只是把文件與型別註解改成講實話。

## 字幕 WYSIWYG 階段 4：畫布拖曳 + 吸附導線（分支 `caption-wysiwyg`）

設計：同上規格 §7（§7 已依實作校對，見設計文件的落地備註）。目標：overlay 與字幕可以直接在預覽畫布上拖曳，吸附到畫布中心線與安全邊距，取代「只能在 Inspector 打數字」的編輯方式。

- **吸附純函數**：`shared/src/snap.ts` 的 `snapBBox(bbox, canvas, threshold=16)`——只認「實際 bbox」（左上角 x/y + 寬高），不認 `OverlayItem.position` 的錨點座標。水平只有一個候選（畫布中心）；垂直三個候選（中心、上 5% 安全邊距、下 5% 安全邊距）互斥取最近者，避免同時吸兩條 y 導線。命中回傳 `SnapGuide[]`，Player.tsx 直接拿它畫黃色導線（`var(--warn, #eab308)`，視覺同時間軸吸附黃線）。
- **錨點↔bbox 換算**：`ui/src/player/dragLayer.ts` 的 `dragOverlay`/`dragCaption`——`OverlayItem.position` 的錨點刻意不對稱（x 是 bbox 水平**中心**、y 是 bbox **上緣**，對應預覽 `translate(-50%, 0)` 與 ffmpeg 端 `x=(W*x)-(w/2), y=H*y`）。曾經因為這個不對稱出過事故：把 `y: 0.5` 誤當成「置中」會把整片畫布高的圖推出畫面下緣約 960px（見 `shared/src/snap.ts` 開頭註解）。`dragLayer.ts` 專職做這個換算，`snapBBox` 本身完全不用知道錨點語意；`y` 的 clamp 上限是 `canvas.h - bbox.h`（不是 `1`）——clamp 到 `1` 代表上緣頂到畫布最底端＝整個元素 100% 掉出畫面，是同一個不對稱事故的另一種踩法，回歸測試已釘住（`dragLayer.test.ts`）。
- **拖曳手勢**：`Player.tsx` 的 `onOverlayPointerDown`/`onCaptionPointerDown` 在按下時 `setPointerCapture`，`pointermove` 只更新本地覆寫（`dragOverride`）與導線（不逐 move 送命令，一次 mousemove 一筆 command 會灌爆 undo history，同 Timeline 既有拖曳模式），`pointerup` 才 `sendCommand`。
- **pending-echo 橋接**：放手瞬間到 server echo 抵達之間有個空窗——不橋接的話畫面會「閃回拖曳前的位置」再跳到新位置。`pendingRef`（配 1.2s 保險絲，避免命令被拒/掉包時卡死）在這段空窗內繼續顯示放手時的值，且**渲染與下一次拖曳的起點共用同一份合併結果**（`overlaysForRender`/`captionsForRender`）——不然「放手後立刻再拖一次」會從 doc 的舊值起算，把第一次的位移吃掉（round 1 review 抓到的真實 bug，已修並有回歸測試）。
- **真瀏覽器 e2e 回歸（Task 16，`npm run verify:canvas`）**：仿 `ui/e2e/panel-affordance.mjs` 的 CDP harness（`ui/e2e/canvas-direct.mjs`），目前是**4 項檢查、6 條斷言**：① 字幕/overlay 層 `transform` 的 scale 與 `stage寬/1080` 誤差 ≤1%；② 拖近水平中心時 DOM 裡出現置中導線；③ 合成 pointer 事件（CDP `Input.dispatchMouseEvent`）拖曳第一個看得到的 overlay，放手後 `/api/project` 裡的座標真的變了；④「不盲拖」（`87514dd` 新增，3 條斷言）：拖曳中把 playhead 踩出該項目的時間窗後，元素仍留在畫面上、畫面繼續跟著手指、而且**存進 doc 的座標＝畫面最後顯示的座標**。⚠️ ①印出的「誤差 0.000%」只讀了 transform 矩陣的 `a`，不能拿來推論「預覽跟成品對齊」——見 `CLAUDE.md`「UI 驗證的陷阱」。**跑這支腳本時真的抓到一個會影響所有使用者的真 bug**：overlay 與字幕卡的 `<img>` 元素沒有關掉瀏覽器原生 HTML5 拖放（預設 `draggable=true`）——按下後只要指標一移動，原生拖曳手勢就搶走事件序列（`dragstart` 觸發→隨即 `pointercancel`），我們的 `pointerup` 永遠到不了，`sendCommand` 永遠不會送出；畫面上覆蓋值（`dragOverride`）會**永久卡在放手時的座標**（沒有 1.2s 保險絲能救，因為根本沒進入 pending 狀態），看起來像是拖曳成功了，但伺服器端座標從未更新，重新整理就打回原形。這不是 CDP 合成事件才有的假象——是標準瀏覽器行為，真人用真滑鼠拖也會踩到。已修：`Player.tsx` 的 overlay `<img>` 與 `CaptionLayer.tsx` 的兩張卡片 `<img>`（base/hl）都加上 `draggable={false}`；修完全部斷言穩定通過（含重跑多次、起點在畫布不同位置的情況；2026-08-04 於 `87514dd` 重跑仍全綠）。詳見 `CLAUDE.md`「UI 驗證的陷阱」新增條目。
- **前置與副作用**：`verify:canvas` 需要 `npm run build -w @vidcut/ui` 是最新的 + 一個吃著真專案的 server 已在跑（`npx tsx server/src/index.ts projects/demo`；**不要**用 `npm run demo`，會重建 demo 專案覆蓋既有內容）。⚠️ 檢查③／④會真的把 demo 專案裡一個 overlay 的位置透過 WS 寫回 `projects/demo` 的 `project.json`（專案檔叫 `project.json`，`doc` 是它裡面的鍵）——這是預期的（demo 專案本來就是拿來被操作的),不是要清乾淨的副作用；腳本本身用「依目前 x 落在畫布左/右哪一側,交替瞄準另一側四分之一處」的絕對目標(不是相對起點的固定位移量),保證重跑很多次也不會把 overlay 逼到畫布邊緣夾住,誤判成「位置沒變」。

**現在使用者可以做什麼**：直接在預覽畫布上把 overlay 或字幕拖到想要的位置，接近中心線/安全邊距時會有導線輔助對齊，放開滑鼠就存檔（可 undo）——不必再靠 Inspector 打 0–1 的座標數字。

## 預覽 vs 成品的幾何回歸（`npm run verify:wysiwyg`，分支 `caption-wysiwyg`）

`ui/e2e/preview-vs-export.mjs`。補的正是上面那條「從來沒有人 render 一次去比像素」的缺口。

- **做法**：自己在 `os.tmpdir()/vidcut-wysiwyg-fixture` 建一個臨時專案（純深灰 1080×1920
  影片 3 秒、白字深描邊、三個項目各佔一段互不重疊的時間窗），自己在 :3999 起一台 server
  （`VIDCUT_PORT` 環境變數是為此加的），**全程走 MCP**（import_media/set_timeline/
  add_overlay/set_captions/render，跟 AI 使用者同一條路徑）→ 真 render → `select=eq(n,N)`
  抽指定幀 → 量「亮度 >128 的像素外接矩形」（＝白色字身，稱墨跡外框）。預覽端用 headless
  Chromium 開真 UI、用 ArrowRight 走到同一幀（拿工具列 timecode 複驗）、`Page.captureScreenshot`
  只截 stage、換算回 1080×1920 座標量同一個外框。**不碰 `projects/demo`、不碰 :3845**，
  每次跑先把臨時專案刪掉重建（重跑任意次起點都一樣）。
- **三個 case、目前的實測結果（2026-08-04 修掉 overlay 兩個缺陷之後，三項全綠）**：
  - ✅ overlay `scale=1`（成品 `x0=318 y0=399 w=444 h=74`）→ 預覽 `x0=318.1 y0=400.0 w=444.1 h=73.0`，
    **最大差 1.0px**（修之前：預覽 `x0=340.1 w=400.1`、最大差 **43.9px**、寬比 0.9011）
  - ✅ overlay `scale=0.5`（成品 `x0=429 y0=392 w=222 h=36`——**成品也跟著變了**，因為渲染端
    現在真的吃 scale）→ 預覽 `x0=429.1 y0=392.0 w=222.0 h=37.0`，**最大差 1.0px**
    （修之前：成品仍是 444 寬、預覽 200.0 寬、最大差 **244.0px**、寬比 0.4505）
  - ✅ 字幕（無 karaoke，成品 `x0=334 y0=1166 w=410 h=75`）→ 預覽 `x0=334.1 y0=1167.0 w=410.1 h=74.0`，
    **最大差 1.0px**（這一項在修之前之後都是綠的，是量測本底的對照組）
- **所以這支腳本現在是綠的（exit 0）**。任何一項轉紅都是真的回歸：字幕那項紅＝量測本身壞了，
  先修腳本不要改斷言；overlay 兩項紅＝那兩個幾何落差回來了（先看 `measure/` 裡的 PNG）。
- **容差 4 畫布 px**：字幕那條路徑兩邊是同一張 PNG、同一個位置，它量到的誤差就是這套量測
  的本底雜訊（h264 4:2:0 + crf 壓縮讓邊緣斜坡位移、截圖重新光柵化、clip 原點取整）。
  實測本底 ≤1.0px，跨 1200×1400 與 1440×820 兩種視窗（stage 寬 628 vs 302 CSS px）都一樣，
  取 4px ＝ 四倍餘裕；當初要抓的兩個落差是 44px 與 244px 級。
- **反向驗證（證明它不是「什麼都判紅」）**：修好之前做過——暫時把 `Player.tsx` 的
  `maxWidth: 1080*0.9` 與 `scale(${o.position.scale})` 都拿掉（讓預覽跟當時的渲染端一樣
  兩件事都不吃）再跑，三項全部轉綠。**注意那只是診斷手段，不是修法**：那樣做會讓
  `position.scale` 在兩邊都變成死欄位，等於默默丟掉 Inspector 提供的編輯。真正的修法是
  渲染端補上 scale（見上），預覽端只拿掉沒有對應物的 0.9 夾制。
- **已知限制**：只比「墨跡外框」（位置與尺寸），不比字形、不比顏色、不比 alpha 邊緣，
  所以描邊粗細/反鋸齒差異這類（karaoke 的已知落差正是這一類）它抓不到；只涵蓋
  非 karaoke 字幕與文字 overlay，**karaoke 與純圖 overlay 沒有 case**；每個時間窗只放
  一個項目（同幀多個項目會讓全域外框失去意義）；預覽端的 `<video>` 內容不參與比對
  （素材刻意是純深灰，門檻切不到它）——所以它**不驗影片畫面本身的縮放/裁切/blur 填充**。

**階段 4 完成後仍待確認**：

- 體感類（需要使用者親眼/親手驗）：拖曳的手感（吸附靈敏度、導線出現的時機是否符合直覺）、打字三段式（階段 3）與拖曳同時操作時是否順手。
- ~~**從來沒有人做過「render 一次，比對成品像素與預覽畫面」這件事。**~~
  **已補上：`npm run verify:wysiwyg`（`ui/e2e/preview-vs-export.mjs`）**——見下節。
  在它之前，e2e 只驗了「伺服器存了新座標」，`verify:canvas` 檢查 1 那個 0.000% 只驗了
  transform 矩陣的 `a`（連 scaleY 與平移都沒看，見 `CLAUDE.md`「UI 驗證的陷阱」）。

## T1（參考 CapCut 的快贏功能，tag `t1-done`）

依 [`docs/research/2026-07-29-capcut-gap-analysis.md`](docs/research/2026-07-29-capcut-gap-analysis.md) 的 Tier 1 全數實作：

- **粗剪主力**：S/Ctrl+B 播放頭分割、Q/W 刪除播放頭左/右（磁性軌自動閉合）、F 定格幀。
- **時間軸手感**：Ctrl+滾輪以游標為錨縮放、吸附（片段邊界/playhead/整秒，黃線指示，N 開關）、Shift+Z 全覽、工具列 ±/Fit/吸附鈕、刻度密度隨縮放調整。
- **快捷鍵**：空白播放暫停、←/→ 逐幀（Shift 加速 10 幀）、Cmd+Z 復原。**在輸入框內打字時全部停用**。
- **音訊軌完成**：片段右鍵抽出聲音（片段轉靜音）、音量/淡入淡出/ducking（播放時自動壓低影片原聲到 0.25）、渲染走 amix 並截到成片長度。
- **Canvas blur 填充**：橫素材放進 9:16 時用模糊放大填滿代替黑邊（渲染 boxblur + 預覽端獨立背景層）。
- **匯出選項**：1080/720/4K 檔位、畫質（crf 18/20/24）、fps（24/30/60）、hevc；合成一律在畫布尺寸做完才縮放，overlay/字卡不會錯位。
- **封面**：任意時間點設封面；已有成品時從成片抽（所見即所得）。
- **新 MCP 工具**：`timeline_op`（split/deleteBefore/deleteAfter/freeze 四合一）、`extract_audio`、`set_audio`、`update_audio`、`set_canvas_fit`、`set_cover`，`render` 新增匯出參數。

## T2 #8：自動字幕與逐詞高亮

計畫見 [`docs/superpowers/plans/2026-07-30-vidcut-t2-captions.md`](docs/superpowers/plans/2026-07-30-vidcut-t2-captions.md)。

- **新 MCP 工具**：`transcribe`（只讀，回逐詞時間戳）、`auto_caption`（辨識→斷句→寫入字幕軌，一步到位）。
- **時間座標是時間軸絕對秒數**：ASR 吃的是「時間軸混音」，所以詞時間可直接當字幕時間，不必做來源↔時間軸換算。
- **逐詞高亮（karaoke）**：`CaptionItem.tokens` 存逐詞時間戳。渲染時**一個詞一張 PNG 字卡**（排版確定性，所以 N 張卡幾何完全對齊，看起來就是同一行字在變色）。預覽端當初是 DOM span 換顏色（幾乎免費）；**階段 3 之後改成 base 卡 + 全高亮卡疊 `clip-path`**——所以預覽與成品的高亮邊緣不完全一樣，見階段 3 節。
- **字幕列表面板**（右上）：點時間跳播、雙擊改字、刪除、樣式套全部。改字會自動清掉該句的 tokens——舊詞邊界對新文字沒有意義。
- **依賴**：`brew install whisper-cpp` + 模型放 `~/.cache/whisper.cpp/`（現用 `ggml-large-v3-turbo-q5_0.bin`，547MB）。或用 `VIDCUT_WHISPER_MODEL` 指定路徑。沒裝時錯誤訊息會直接給安裝指令。

**踩過的坑（whisper.cpp 1.9.1 實測，別重犯）**

1. **不要用 `-ml 1 -sow`（一段一詞）取逐詞時間**。看起來最直覺，但 segment offsets 在長句尾段會**整批退化**成「全部等於音訊結尾」，最後一個詞還會拿到 **30 秒**（內部補齊的區塊邊界）。
2. **正確來源是 `-ojf` 的 token 層 `t_dtw`**。同一次辨識裡它是正確且單調的（實測尾段 8.84→9.04→…→12.36，而 offsets 全是 12.39）。
3. **DTW 要搭 `-nfa`**：whisper.cpp 的 flash attention 與 DTW 互斥，開著會**靜默停用** DTW（log 只有一行 `dtw_token_timestamps is not supported with flash_attn - disabling`）。
4. **短音訊（約 4 秒以下）時間戳本來就會爛**，這不是我們的音訊管線問題（純 ffmpeg 轉的 wav 一樣）。`normalizeWords()` 會把擠在一點的詞攤開、把超出片長的夾回來。

**下一步（Tier 2 其餘）**：偵測工具組（`detect_silence`/`detect_scenes`/`detect_beats` → 回傳時間戳給 AI 決策）、**模板化＋批次渲染**、transcript 式長轉短。優先建議：beat 偵測 + 模板化（對 ranking 片管線立刻有感）。

## UI 重設計（2026-07-30 夜間）

spec：[`docs/superpowers/specs/2026-07-30-vidcut-ui-redesign-design.md`](docs/superpowers/specs/2026-07-30-vidcut-ui-redesign-design.md)（brainstorm 含瀏覽器 mockup 比選，使用者逐步定案：C 現代 web 視覺 × 保守版面 × 峰值+RMS 波形）。

- **設計系統 `ui/src/theme.css`**：CSS 變數 token（紫 #8b5cf6 強調、青 #0ea5e9 音訊、深藍紫玻璃層級）；**原生 button/select/input 直接被 theme 接管**，元件端大量刪 inline style；lucide-react 取代 emoji 圖示。
- **版面**：RenderBar 刪除 → 頂欄 ExportMenu（匯出鈕+下拉+3px 進度條）；右欄改「字幕⇄活動」分頁；播放控制+時間碼移進時間軸工具列；審核條改事件式 overlay 卡（GSAP 彈性滑入）；左右面板可收合（grid-template-columns 動畫）。
- **時間軸**：片段卡片化（上 60% filmstrip、下 40% 波形帶）；**峰值+RMS 雙層鏡像波形**（`ui/src/timeline/waveform.ts`，DPR 級解析度）；ingest 升級 **100 桶/秒＋rms 陣列**（`PeaksFile` 共用型別；舊檔無 rms 自動退單層）；音訊軌青色全高波形；playhead 紫漸層光暈圓頭。
- **動效**：`ui/src/motion.ts`（gsap + useGSAP + motionOK）；審核條/分頁/toast/渲染完成 pulse/字幕自動捲動；微互動走 CSS transition；`prefers-reduced-motion` 全域尊重。
- **行為零改動**：命令層/MCP/播放引擎/拖曳數學全部沒碰；demo 專案已重建（新 peaks）。

**headless 截圖打通後（chromium --headless=new）親眼驗過**：版面/波形/字幕分頁/匯出鈕都正確渲染。過程中抓到並修掉一個真 bug：

- **zustand v5 selector 禁止回傳新 reference**。`useProject((s) => s.doc?.tracks.captions ?? [])` 的 `?? []` 在 doc=null（每次冷載入）觸發同步無限重渲染 → React #185 → 整個 app 白屏。dev 分頁靠 HMR 熱更新遮住了它（更新時 doc 已非 null）。修法：fallback 用模組級常數（`NO_CAPTIONS`）。**以後寫 selector 一律不得在裡面創建新陣列/物件。**
- 波形顯示用 sqrt 感知縮放（實測素材正規化振幅常 <0.3，線性會退化成細線）；trim handle 改 hover 才浮現。

**仍待使用者驗收（體感類）**：動效手感（審核條/分頁/收合）、hover 細節、真素材上的波形觀感。舊專案想要 RMS 波形需重 ingest，不重跑也能用（單層）。

## 明天第一件事：親眼驗收（我驗不了「體感」與 Claude Code 實連）

字幕 WYSIWYG 四階段（含畫布拖曳）都做完、自動化測試與真瀏覽器 e2e（`verify:panels` + `verify:canvas`）都綠了，但**手感類的東西自動化測不出來**，需要你的眼睛與手：

### A. 開起來看

```bash
cd ai-video-cut

# 終端機 A：起 server（127.0.0.1:3845，MCP 在 /mcp）。二選一：
npx tsx server/src/index.ts projects/demo   # 保留 projects/demo 目前的內容
npm run demo                                # ⚠️ 重建 demo：會覆蓋掉現有的 overlay/字幕

# 終端機 B（可選，只有要熱重載改 UI 才需要）
npm run dev:ui
```

**先看清楚這三件事，否則會卡在錯的地方：**

- **步驟 4 與 6 需要專案裡真的有字幕。** `projects/demo` 現在（被 e2e 與手動測試操作過）
  **字幕軌是空的**；`npm run demo` 重建後會有 2 句種子字幕（無 tokens ＝ 無逐詞高亮）、
  1 個 title.png overlay，但也會**清掉**現有的 7 個 overlay（含測試用的文字 overlay）。
  想保留現況又要驗字幕，就先跑步驟 7 的 `auto_caption`（或自己用 Text/字幕面板加一句）。
- **`npm run dev:ui` 的 port 不一定是 5173**：被占用時 vite 會自動往上找（實測選過 :5175），
  以它啟動時印的那行為準；而且**只能用 `http://localhost:<port>`，`127.0.0.1` 連不上**
  （vite dev server 只綁 IPv6）。
- **不想被 port/proxy 干擾就直接用 `http://127.0.0.1:3845/`**（server 服務的 `ui/dist`）。
  這條路不需要 dev server，但**改了 UI 原始碼要先 `npm run build -w @vidcut/ui`**。
  dev 模式的字卡/字型通道曾經是死的（`ui/vite.config.ts` 少了 `/text-card` 與 `/fonts`
  兩條 proxy），現在已補上並在 dev port 的真頁面裡驗過：幾何 JSON、`POST /text-card/preview`、
  `/fonts/:id`、字卡 `<img>`、`@font-face` 全部正常。

驗收（重點在體感，e2e 只驗了「機制有沒有跑」，沒驗「順不順手」）：

1. 時間軸 5 clip（縮圖 + 波形；No.3 無音軌 → 平線），按 ▶ **切換有無黑幀/停頓**（M1 最關鍵，這條仍然是回歸底線）。
2. 拖 clip 左右邊緣 trim、拖 clip 本體換順序、點 clip 在左欄改屬性、Cmd+Z 復原、右欄活動記錄。
3. **拖曳手感（階段 4，新）**：在預覽畫布上直接拖動一個 overlay（排名徽章）或一句字幕——吸附到中心線/安全邊距時的靈敏度是否符合直覺？導線出現/消失的時機會不會太早/太晚、會不會抖動？拖到畫布邊緣時元素會不會整個消失不見（設計上應該最多露出一半，見 `dragLayer.ts` 的 clamp 說明）？
4. **打字體感（階段 3）**：在**右上字幕列表雙擊**一句字幕改字（三段式只接在 `CaptionList.tsx`，
   **畫布上不能直接改字**；左欄 Inspector 的字幕 Text 欄也不走三段式——它是 `onChange` 每一鍵
   直接送一筆 `updateCaption` 命令，會灌爆 history），
   感受「近似文字先出、~80ms 後換真卡」這個切換是否明顯/突兀。
   ⚠️ **不要用「加長文字讓它自動換行」來驗**：字幕與文字 overlay 目前都**不會自動換行**
   （`maxWidth` 是死欄位，見階段 3 節末），太長的字只會被畫布邊緣裁掉。
   `text_card.py` 對沒有 tokens 的文字只認**真的斷行字元**，所以要驗多行請在左欄 Inspector 的
   Text 欄（那是 `<textarea>`，按 Enter 就會換行；右上字幕列表是單行 `<input>`，Enter 是送出）裡打真的換行。
5. 底部「🎬 渲染成品」→ 進度條 → 完成後「開啟成品」連結播放，確認畫面/音訊/overlay/字幕。
6. **預覽=成品的最終檢驗（階段 4 收尾）**：把上面拖過的 overlay/字幕、改過的文字，用同一次渲染比對。
   **請帶著下面這份「已知會不一致」的清單去看**，否則你會把已知落差當成新 bug（或反過來，
   把落差看成「大致上一樣」而放過）：
   - ✅ **非 karaoke 字幕應該一模一樣**（同一張 PNG，已驗到 sha256 相同）——位置、字級、描邊、字型有任何差異都是新 bug，請記下來。
   - ✅ **overlay 的大小/位置現在也應該一樣**（2026-08-04 修好，`verify:wysiwyg` 三項全綠、最大差 1.0px）：
     以前「成品比預覽大約 11%」與「Inspector 的 scale 欄位對成品完全沒效果」兩條**都已消除**——
     現在改 scale 預覽與成品會一起變。若還看得到差異，那是新 bug，請記下來。
     注意既有專案的 overlay **預覽會比你印象中大 11%**：那是它在成品裡一直以來的尺寸，不是變大了。
   - ❌ **karaoke 字幕的高亮邊緣一定不一樣**：預覽是兩卡疊 `clip-path`，成品是一詞一卡；
     下一個還沒唸到的詞左緣會被預覽多染約 4px 高亮色，描邊也比較厚。同樣是已知缺陷。
   - 位置（x/y）本身**沒有人驗過**：e2e 只驗了「伺服器存了新座標」，從來沒有跑一次真的 render 去比對成品像素。這一項請你特別看。
7. **自動字幕**：素材要有人聲才有意義。請 AI 跑 `auto_caption`，右上字幕列表會出現句子，
   播放時預覽的字會逐詞亮起；渲染後成品也應該逐詞亮（我用像素數驗過，但觀感要你看，
   而且逐詞高亮的預覽/成品本來就有上面說的邊緣差異）。

### B. 接 Claude Code（M3 的重點價值）

```bash
# server 要開著（npm run demo 或 npm run dev:server -- projects/demo）
claude mcp add --transport http vidcut http://127.0.0.1:3845/mcp
```

然後在 Claude Code 裡對它說「用 vidcut 讀專案、把第 3 段縮短一秒、然後 request_review」。
你會在瀏覽器 UI 看到變更即時發生、頂部跳出審核條，按核准後 AI 那邊的 `request_review` 就回傳。
（我用 in-process client 與真 HTTP client 都驗過這條迴路，但沒有你的 Claude Code 環境，這步請親測。）

## 環境限制與字幕（已解決）

**本機 Homebrew ffmpeg 8.1.2 是精簡 bottle，沒有 `drawtext`／`libfreetype`／`libass`**（formula 本身不宣告 freetype 依賴，`brew reinstall` 也救不了；只有 drawbox/overlay/colorize）。

**字幕已用 PNG 字卡路徑解決**（2026-07-29）：render 時 runtime 偵測 drawtext——

- 有 drawtext → 原生 `drawtext` 燒字。
- 無 drawtext（本機）→ 用 **Pillow 把每條 caption 畫成透明 PNG 字卡**（`server/scripts/text_card.py`，CJK 字型 fallback），再用既有 `overlay` 濾鏡按時間合成。已端到端驗證：純黑底上字幕開啟時有字、關閉時無字、時間正確。`render` 回 `captionsBurned:true`。

需要 `pip3 install pillow`（已裝，12.3.0）。重度文字（排名標題、迷因標籤）仍走 overlay PNG（與 `make_overlays.py` 一致），這條本來就正常。

⚠️ **「哪天換成含 freetype 的 ffmpeg 會自動改走原生 drawtext，不用改碼」現在是一顆未爆彈，不是好消息。**
`server/src/render.ts` 的判斷是 `if (captions.length > 0 && (!drawtext || karaoke))` 才產字卡——
也就是「有 drawtext **且**沒有 karaoke」時會走 `drawtext` 分支。那條分支的濾鏡是
`drawtext=text=…:fontsize=…:fontcolor=…:x=(w-text_w)/2:y=…`：**沒有 `fontfile=`**（字型完全交給
ffmpeg 自己找，`style.fontFamily` 無效）、**不換行**（單行，連 `\n` 都不處理）。
換句話說，在一台有 freetype 的機器上，字幕會突然改用**完全不同的光柵器**，
本分支辛苦建立的「預覽=成品」會**靜默**失效——沒有任何測試或 runtime assertion 擋著。
換機器前要先決定：拿掉 drawtext 分支（一律走字卡），或至少加一道「兩條路輸出必須一致」的檢查。

**本機 ffmpeg 濾鏡清單（2026-07-30 實測，避免重複調查）**

| 有                                                                                                     | 沒有                                                                               |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `xfade`（轉場）、`zoompan`／`crop`（punch-in）、`geq`（逐像素表達式）、`sendcmd`、`overlay`、`boxblur` | `drawtext`／`libfreetype`、`ass`／`subtitles`（無 libass）、`frei0r`、`libplacebo` |

意義：**Tier 3 的 punch-in/zoom 與轉場不需要新依賴**，本機 ffmpeg 就做得到。反之 ASS 字幕（`\k` 逐詞卡拉 OK、`\t()` 屬性插值）在這台機器上完全走不通，PNG 字卡不是次佳解而是唯一解；逐詞亮起要靠「一句話出 N 張字卡」實作，不是 ASS。

## 已知取捨（非 bug）

- ~~`undo` 為逐步 undo，「撤 undo = redo」是簡化；要正式 redo stack 之後再擴。~~
  **已不成立**：`server/src/store.ts` 有真的 `#redoStack`、`redo(source, steps)` 方法、
  「有新編輯就清空 redo（分叉）」的處理，`Command` 有 `redo` variant，MCP 也有 `redo` 工具。
- request_review 用「阻塞 + UI 核准 + 保活 + 逾時」；**elicitation URL mode**（Claude Code 直接彈瀏覽器審核頁）列為後續增強——因無法自動驗證故未做，可用 v2 SDK `@modelcontextprotocol/server` + codemod 遷移時一起上。
- 退回（reject）目前回滾「review 開啟後的全部變更」到 sinceVersion；若人在審核期間也改了東西會一起被回滾（reject = 丟掉這一輪）。
- Safari 未測（開發用 Chrome）。
- MCP 用 v1 SDK 1.30.0（穩定）；v2（2.0.0）功能更多但兩天前才發，之後可用官方 codemod 升級。

## 架構與程式碼地圖

單一 Node 程序（`server/`）綁 `127.0.0.1:3845`，一 port 服務：靜態 UI、`/media/*`（Range）、`/mcp`（MCP Streamable HTTP）、`/ws`（狀態同步）。專案狀態 = `project.json`，**所有變更走 `ProjectStore.mutate()` 單一路徑**。

```
shared/src/types.ts       全部型別（spec §3）+ Command/WS 協議
shared/src/timeline.ts    純時間軸計算（locate/overlayWindow…）
shared/src/captions.ts    逐字稿→字幕分頁、逐詞高亮索引、ASR 時間戳修正、karaokeClip（兩卡 clip-path）、tokenSeparator（斷詞規則）（純函數）★
shared/src/snap.ts        snapBBox：畫布拖曳吸附純函數（水平置中/垂直置中/上下 5% 安全邊距，16px 半徑，只認 bbox 不認錨點）
server/src/store.ts       ProjectStore：唯一真相來源、immer patch、history、undo/redo（真的有 #redoStack）、原子存檔
server/src/commands.ts    applyCommand：人機共用的驗證過的編輯命令層 ★
server/src/aiWrite.ts     AI 寫入守衛（審核中擋 + ifVersion 過期偵測）→ commands
server/src/reviews.ts     ReviewManager：request_review 的核心（阻塞/核准/退回回滾/逾時）
server/src/editorContext.ts 人的選取/playhead（給 get_editor_context）
server/src/mcp.ts         29 個 MCP 工具 + /mcp 掛載 ★（數字＝`grep -c 'registerTool' server/src/mcp.ts`）
server/src/ingest.ts      proxy/filmstrip/peaks 產生（spec §8.1）
server/src/render.ts      project.json → ffmpeg filter_complex 成品 + blur/定格/音訊混音/匯出選項/封面 ★
server/src/asr.ts         whisper.cpp 介接：時間軸混音→wav→逐詞時間戳（含 DTW 取用）★
server/scripts/text_card.py  文字 → 透明 PNG 字卡（Pillow，含逐詞著色與貪婪換行；`--worker` 常駐模式一次回 base+全高亮兩張卡＋逐詞 bbox，7ms/張）
server/src/rasterizer.ts  PillowRasterizer：包 text_card.py worker 的 TS 介面（rasterize/probeFont/dispose）
server/src/fonts.ts       啟動時實測字型檔可否用 Pillow 開啟，剔除開不了的（本機 PingFang.ttc）；family→路徑 resolver
server/src/textCards.ts   TextCardService：內容雜湊快取字卡到 derived/text/；/text-card 靜態端點 + /text-card/preview 只讀產卡通道
server/src/cardSync.ts    CaptionCardSync：字幕軌變更 debounce 300ms 重產字卡，WS 廣播 capId→hash；單句失敗隔離不拖累整批
server/src/textOverlays.ts 文字 overlay 命令前置：resolveTextCommand() 產卡後把 imagePath 併入新命令，text 與 imagePath 在同一次 mutate 原子生效
server/src/ffmpeg.ts      runFfmpeg/probe
server/src/frame.ts       抽幀給 AI「看」
server/src/wsHub.ts       WS：full/patch/command/context/reviewResolve/render
server/src/index.ts       startServer + CLI
ui/src/theme.css          設計系統：token + 原生控件樣式 + 佈局 class ★
ui/src/motion.ts          GSAP 進入點（useGSAP + reduced-motion 判斷）
ui/src/stores/            project（patch 套用，含 captionCards）/ playback / selection / view（縮放吸附＋面板收合）/ activity / toast / editDraft（打字三段式草稿，見下）
ui/src/stores/editDraft.ts 打字中的本地字幕草稿（text + previewHash）：不進 history、不碰 doc、不經 sendCommand
ui/src/ws.ts              WS client：命令/脈絡/審核/渲染 送出 + 重連
ui/src/player/            planAt（純函數大腦）+ Player（A/B 引擎，量 stage 寬算 1080 座標空間縮放係數 + 畫布拖曳事件處理）+ CaptionLayer（見下）+ dragLayer（見下）
ui/src/player/CaptionLayer.tsx 字幕預覽：有字卡 hash 就 <img> 直出（無 karaoke 時與匯出同一張圖），karaoke 疊 hl 卡 + clip-path（與匯出的一詞一卡**不**同源）；沒有 hash／幾何 fetch 失敗／圖檔 onError 才退回 DOM 近似 fallback，幾何 fetch 進行中是 return null（空白一幀，不是近似文字）
ui/src/player/dragLayer.ts dragOverlay/dragCaption：畫布拖曳數學（純函數）——overlay 的 position 錨點不對稱（x=中心、y=上緣），這裡負責錨點↔bbox 左上角的雙向換算，呼叫 shared 的 snapBBox 做實際吸附 ★
ui/src/timeline/          scale + dragMath + waveform（純函數）+ Timeline（trim/排序/選取/縮放/吸附/transport）
ui/src/panels/            Inspector / Activity / ReviewBar / ExportMenu / CaptionList（字幕列表）
```

★ = 改動時最常碰、最核心的檔案。

**改動鐵則**：任何專案狀態變更都走 `applyCommand`（人）或 `aiWrite`→`applyCommand`（AI）；不要旁路直改 doc。要加新編輯操作 = 在 `shared` 的 `Command` 加一個 variant + `commands.ts` 加驗證 + case，UI 與 MCP 自動都能用（DRY 的關鍵）。

## 開發指令

```bash
npm test          # 全部（含真 ffmpeg 與真 whisper，機器空閒時約 70 秒）
npm run typecheck # 三 workspace tsc（乾淨）
npm run lint      # ESLint —— 目前 exit 1：34 個錯誤全在 .claude/worktrees/**（別的 session）
npm run format:check  # 目前有未格式化的原始碼會被抓出來，那不是雜訊
npm run format    # Prettier 寫入
npm run demo      # ⚠️ 重建 demo（覆蓋既有內容）+ 起 server
npm run dev:ui    # Vite dev（proxy 到 :3845；port 未必是 5173，且只綁 IPv6 → 用 localhost）
npm run verify:panels  # 面板控制項真瀏覽器回歸（前置：server 在跑 + ui/dist 最新）
npm run verify:canvas  # 畫布縮放/拖曳/吸附/不盲拖真瀏覽器回歸（前置同上；見 CLAUDE.md）
npm run verify:wysiwyg # 真 render vs 預覽截圖的墨跡外框（自己起 :3999 + 臨時專案；目前全綠）
```

> `npm run lint` exit 1 代表 `typecheck && lint && format:check` 這種 `&&` 串會停在 lint，
> **永遠跑不到 `format:check`**。要嘛分開跑，要嘛把 `format:check` 排前面。

## 下一步建議（依價值排序）

1. **親驗播放體感 + Claude Code 實連**（上面 A、B）。有問題記錄現象給我。
2. **Tier 2 其餘**（見 gap analysis；#8 自動字幕已完成）：優先 **beat 偵測**（切點對拍，質感立刻上檔次）與 **模板化 + 批次渲染**（ranking 片變成換素材就好）。
3. **skill 整合**：把 `ranking-video-generator` 步驟 3–5 尾段改走 vidcut（import_media → set_timeline → set_overlays → request_review → render）；掃描/峰值/選段不動。詳見 `docs/superpowers/plans/2026-07-29-vidcut-m4.md` 末節。
4. 其他增強：whisper 逐字稿＋自動字幕、**elicitation URL mode**、多分頁綁定（Vyra 式 Connect MCP）。

設計與計畫全文：`docs/superpowers/specs/` 與 `docs/superpowers/plans/`。
