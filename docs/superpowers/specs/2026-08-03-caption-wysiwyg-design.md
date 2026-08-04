# 字幕/文字 WYSIWYG + 可編輯文字 overlay 設計 — 2026-08-03(v2)

> 定案:**單一文字光柵器**。預覽顯示的字幕/文字 overlay 與渲染成品是**同一張 PNG**,
> 一致性由構造保證。光柵器先用 Pillow(常駐 worker,實測 7ms/張),
> 介面明文化,之後可整顆換成 headless Chromium 而不動架構。
>
> v2 變更:併入文字 overlay 與預覽拖曳;刪除 v1 階段 0(面板 bug 經排查**不存在**——
> 使用者看到的「字幕」是 ranking overlay PNG,字幕軌本來就是空的);
> 產卡從批次 spawn 改為常駐 worker;納入調研結論與實測數據。

## 1. 背景

### 問題

同一條字幕被兩套文字光柵器各畫一次:預覽是瀏覽器文字引擎(DOM),成品是
Pillow([`text_card.py`](../../../server/scripts/text_card.py))。六個實測分歧源:

1. **字級縮放**:預覽用 `fontSize / 3` 固定除數,但真實縮放比隨視窗變
   (實測 1280×620 時預覽字大 3.28×;1920×1080 時剛好 0.98×)。
2. **換行**:瀏覽器自動換行 vs text_card.py 貪婪換行——斷行點會不同。
3. **量測引擎**:DOM vs PIL `textlength`。
4. **描邊**:預覽固定 1px 中線描 vs 成品 `size//16` 外描。
5. **字型**:本機 Pillow 開不了 `PingFang.ttc`(OSError),實際 fallback 到
   Heiti TC;瀏覽器用的是真 PingFang。**兩邊字體根本不同**。
   （階段 1 現況:`fonts.ts` 啟動時實測並剔除開不了的字型,這個 OSError
   已被證實、記錄、處理——PingFang TC 從可用字型表中剔除,伺服端一律落到
   Heiti TC。瀏覽器 DOM 端本身要換成走同一份字型檔`@font-face`是階段 3
   的工作,尚未做,所以「兩邊字體不同」這個分歧本身仍然存在;階段 1 做的
   是把伺服端這一側的字型解析修對、修透明。）
6. **`CaptionStyle.fontFamily` 在渲染端是死欄位**:text_card.py 的 `load_font()`
   只吃字級,render.ts 也不傳 fontFamily——UI 改字型對成品無效。
   （**階段 1 已解決**:`render.ts` 現在會用啟動時注入的字型 resolver 解析
   `fontFamily` 並傳 `fontPath` 給 text_card.py;`/text-card/preview` 產卡
   通道也走同一個 resolver。`fontFamily` 欄位現在對「產卡」這件事(匯出
   與預覽產卡通道)都真的生效了——之前兩邊都不生效。**階段 2 落地備註**:
   UI 仍然沒有字型選單——階段 2 的 Inspector 加了文字/字級/顏色三個編輯
   欄位,但沒有做字型下拉(新文字 overlay 一律預設 `Heiti TC`,字幕的
   `CaptionStyle.fontFamily` 也還是只能靠外部/AI 改)。字型選單延後到
   之後才做,欄位本身不再是死的,只是還沒有 UI 去改它。）

另外 overlay 文字(排名清單)是外部腳本烤好的整張 PNG,**文字內容不可編輯**。

### 調研結論(2026-08-03,CapCut/專業 NLE/網頁編輯器三路調研)

- 業界唯一共識:**一個光柵器、兩個輸出口**。Premiere(Mercury)、Resolve、FCP
  (Motion 引擎)、CapCut(單一 C++ 引擎編到含 WASM 的所有平台)、Kdenlive/MLT
  (QPainter 光柵、同 graph 兩個 consumer)。維護兩套渲染器對齊的產品全部出現在
  災難案例區(Premiere 字型 fallback 競態、HandBrake 座標空間 bug)。
- **「伺服器 PNG 字卡 + overlay 合成」是正統模式**:Kapwing 以此規模化到
  10 萬專案/日、單片 1000+ 字幕;libass 內部同樣是「塑形成 alpha 點陣圖再疊」;
  DVD/藍光字幕本身就是點陣圖。
- karaoke 業界做法 = **排版一次,高亮是時間驅動的變色**,「base+全高亮兩張圖
  逐詞揭開」是標準技巧。
- CapCut 教訓:字級用**畫布相對單位**;**字型自帶**(自己載入固定字型檔、
  自己排版)以消滅 OS 字型差異。
- 升級路徑實測:常駐 Pillow worker **7ms/張**(import PIL 29ms 只付一次);
  常駐 headless Chromium **167ms/張** + 開機 1.3s(品質天花板高,留作升級)。

## 2. 目標 / 非目標

### 目標

1. 預覽字幕與成品**像素級一致**(同一張 PNG)。
2. **可編輯文字 overlay**:單色文字塊(改字/字型/字級/顏色/描邊/換行),
   人與 AI 都能建立與修改;渲染管線零改動。
3. **預覽直接操作**:拖曳移動 overlay(x/y)與字幕(y);畫布中心/安全邊距
   吸附導線;pointerup 才送命令。
4. 打字**即時回饋**:本地近似立即顯示,停手 ~80ms 後換真字卡。
5. `fontFamily` 欄位起死回生:字型檔綁定專案/伺服器,兩端同源。

### 非目標(之後另開)

- 逐段多色/花字、四角縮放手把、旋轉、進出場動畫、SRT/VTT、雙語。
- 排名圖內建模板化(現有 ranking PNG 維持外部生成,不動)。
- 渲染端「一詞一卡爆量」根治(本設計產出 bbox 與雙卡機制為它鋪路)。
- Chromium 光柵器(見 §11 升級路徑,介面已預留)。

## 3. 架構總覽

```
                    ┌─ 光柵器介面 rasterizeCard() ─┐
                    │   Pillow 常駐 worker(現在)   │←之後可整顆換 Chromium
                    └──────────┬───────────────────┘
   文字+樣式 ──────────────────┤
                               ▼
        derived/text/<hash>.base.png / .hl.png / .json(逐詞 bbox)
                               │
              ┌────────────────┴────────────────┐
              ▼                                 ▼
   預覽:<img> 疊在 1080×1920 座標空間     渲染:ffmpeg overlay 合成
   (transform: scale 與影片同縮放)        (render.ts 現有路徑,零改動)
```

**單位決策**:`fontSize` 維持「畫布 px」(1080×1920 座標系),已等價於相對單位
(畫布固定);分歧只出在預覽端,修法是預覽一律走 transform scale,**廢除 `/3`**。
位置維持 0–1 畫布分數。schema 不變。

## 4. 光柵器介面(本設計的核心合約)

> **與實作的形狀差異**(階段 1 完成後校對,spec 以下已改為與程式碼一致):
> 原設計把「輸出檔路徑」放進 `CardResult` 回傳;實作改成呼叫端(`textCards.ts`,
> 負責算 hash、決定路徑)把要寫入的路徑當參數傳給 `rasterize()`,`rasterizer.ts`
> 只回幾何(`CardGeometry`,含新增的 `lines` 行數),不知道、也不決定路徑或快取
> ——快取/路徑這一層職責完全在 `textCards.ts`(§5),`rasterizer.ts` 只管「畫」。
> 欄位名 `maxWidth` 也改成 `maxWidthFrac`(語意不變,只是明確化「這是分數」)。

```ts
// server/src/rasterizer.ts(實際簽名)
interface CardRequest {
  text: string;
  tokens?: string[];          // 逐詞(karaoke);無則整段
  style: TextCardStyle;       // fontFamily/fontSize/fill/stroke/highlight
  width: number;              // 畫布寬(1080)
  maxWidthFrac?: number;      // 0–1,換行寬度,預設 0.9(文字 overlay 用;字幕沿用預設)
}
interface CardGeometry {
  width: number; height: number; lines: number;
  tokens?: { x: number; y: number; w: number; h: number }[];  // 逐詞 bbox,tokens 有值才有
}
// rasterize 不回路徑——路徑由呼叫端(textCards.ts)決定並當參數傳入;
// outHl 省略時只產 base 卡(無 tokens 的情況)。
rasterize(req: CardRequest, outBase: string, outHl?: string): Promise<CardGeometry>
```

`textCards.ts` 的 `TextCardService.ensure()` 才是「查快取 → 沒有就叫 rasterize → 回帶
hash 的結果」這一層(見 §5),對應原設計裡 `CardResult` 想表達的角色;它回傳
`CardGeometry & { hash: string }`,`hash` 本身就隱含 base/hl PNG 的路徑
(`derived/text/<hash>.base.png` / `.hl.png` / `.json`),所以不需要額外的
`basePng`/`hlPng` 欄位。

- **快取 key** = `hash(text, tokens, style, width, maxWidthFrac, rasterizerId)`。
  與時間無關(改起訖不重產);`rasterizerId` 讓換引擎自動失效全部快取。
- **實作 1(本次,已完成)**:Pillow 常駐 worker。text_card.py 加了 `--worker`,
  stdin/stdout JSONL 迴圈(import PIL 與字型載入只付一次,實測後續每張 7ms);
  一次請求產 base+hl 兩張並回逐詞 bbox。現有單卡 CLI 模式保留,`render.ts`
  的匯出路徑目前仍呼叫它,還沒有改走 worker。worker 掛掉時下一次請求會
  自動重新 spawn(`PillowRasterizer.ensureChild()` 檢查 `exitCode`),
  不是主動偵測崩潰後重啟;重啟後仍失敗的降級走 §9。
- **實作 2(升級,§11)**:headless Chromium。合約不變,尚未實作。

### 字型綁定(修分歧源 5、6)

- server 維護 `fontFamily → 字型檔路徑` 對照表(`server/src/fonts.ts` 的
  `CANDIDATES`),**啟動時用真 Pillow 實測能否開啟**,開不了的從表中剔除並
  `console.warn`(本機 `PingFang.ttc` 即此情況,已剔除,落到 `Heiti TC`)。
- 新端點 `GET /fonts/:id` 供 UI 以 `@font-face` 載**同一個字型檔**——
  打字時的本地近似預覽(§7)因此與成品同字體(§7 的三段式編輯本身待階段 3)。
- text_card.py 接受明確字型檔路徑參數(取代寫死的候選鏈);
  `render.ts` 透過啟動時注入的 `setCaptionFontResolver` 拿到同一個
  resolver,解析 `cap.style.fontFamily` 後傳入——fontFamily 欄位自此生效,
  且與預覽路徑保證同源(有判別性測試把關,見 `render-fonts.test.ts`)。
- UI 字型選單只列 server 回報的可用清單:實作選了**靜態端點**這條路
  (`GET /api/fonts` 回 `{id, family}[]`),不是 WS full 訊息夾帶
  ——原設計列了兩個選項,這裡記錄實際選了哪個。**階段 2 落地備註**:
  UI 端消費這份清單(下拉選單本身)並未如原計畫排進階段 2——階段 2 的
  Inspector 只加了文字/字級/顏色編輯,`/api/fonts` 端點目前仍完全沒有
  UI 消費者,新文字 overlay 一律預設 `Heiti TC`。字型選單延後到更後面
  才做。

## 5. 產卡服務(server 新模組 `textCards.ts`)

- 包住光柵器:查快取 → 未命中丟 worker → 寫 `derived/text/` → 回 CardResult。
- **三條觸發路徑**(階段 1 只實作了①的字幕那一半;②是階段 2 加的,**與
  原設計預期的形狀不同**,見下方階段 2 落地備註):
  1. **字幕 debounce 路徑**:`applyCommand` 的 patch 若碰到 `tracks.captions`,
     `CaptionCardSync` debounce 300ms 後對**全部**字幕重新 `ensure()`
     (不是只重產受影響的那幾句;字幕數量目前夠少,全量重算比精算差異變更
     簡單且不會有髒快取風險),完成後 WS 廣播
     `{type:'textCards', entries:[{id, hash}]}`(無 `kind` 欄位,只有
     字幕會走這條路)。
  2. **文字 overlay 的命令前置路徑(階段 2)**:`server/src/textOverlays.ts`
     的 `resolveTextCommand()` 在 `applyCommand` 之前直接呼叫
     `TextCardService.ensure()` 產卡,把算出的 `imagePath` 併進命令再套用
     ——**不透過** `textCards` WS 訊息,結果是文字 overlay 的 `imagePath`
     隨那次命令的一般 doc patch 一起送到 client。
     > **與原設計形狀差異**:原本這裡預期文字 overlay 也會走「① 的
     > `textCards` 廣播 + `kind` 欄位分流」這套機制(所以才有上面「`kind`
     > 留給階段 2 文字 overlay 加入時再補」的伏筆)。實作沒有這樣做——
     > 命令觸發(使用者存了一次 `text`)跟字幕的軌道變更 debounce 是不同
     > 性質:命令是一次性、需要即時原子生效(§6),不適合套字幕那種
     > 「debounce 全量重算再廣播」模式。所以 `TextCardService`(以及
     > `CardGeometry`)本身確實是①②共用的服務,但②走的是全新的
     > `resolveTextCommand` 命令前置,`textCards` WS 訊息型別**沒有**加
     > `kind` 欄位,現在也不需要加——它天生只服務字幕這一種消費者。
  3. **預覽路徑(打字用)**:`POST /text-card/preview`——只產卡不動 doc、
     不進 history、不廣播,回 hash。給 §7 的三段式編輯用(階段 1 已有端點
     與驗證,UI 端的「打字時呼叫它」要到階段 3 才接上)。
- 專案載入時背景預熱缺卡(已實作:`index.ts` 啟動時 `cardSync.schedule()`)。
- **孤兒檔清理延後**(階段 1 未實作):`derived/text/` 目前只增不減——舊字幕/舊樣式產生的卡不會
  被回收。內容雜湊快取代表孤兒檔不會造成正確性問題(不會被誤用),純粹是磁碟空間會緩慢累積。
  留到之後有實際容量壓力或做專案匯出瘦身時再處理;不在本計畫範圍內。
- HTTP:實際端點是 `GET /text-card/<hash>.base.png`、`GET /text-card/<hash>.hl.png`(有 tokens
  才存在)、`GET /text-card/<hash>.json`(即 `CardGeometry`,`{width,height,lines,tokens?}`),
  都是 `express.static` 掛在 `/text-card` 下的 `immutable` 強快取(內容定址,URL 變即內容變)。
  另有 `POST /text-card/preview`(見上方預覽路徑)。

## 6. 資料模型與命令層

```ts
interface OverlayItem {
  id: string;
  imagePath: string;          // 文字 overlay 時 = derived 產物,由 server 維護
  text?: OverlayText;         // 有值 = 可編輯文字 overlay
  anchor?; start?; duration; position;   // 既有欄位不動
}
interface OverlayText {
  text: string;
  fontFamily: string; fontSize: number;
  fill: string; stroke?: string;
  maxWidth?: number;          // 0–1 相對畫布,預設 0.9
}
```

- 既有排名 PNG 無 `text` 欄位,行為完全不變(向下相容免費)。
- **不新增命令**:`updateOverlay` patch 型別擴大到含 `text`(以及既有的
  `imagePath`);`addOverlay` 帶 `text` 即新增文字 overlay。

> **與實作的形狀差異**(階段 2 完成後校對,原設計寫「server 在同一次 mutate
> 內同步產卡並更新 imagePath」,實際做法是**兩段式**,以下為與程式碼一致的
> 版本):
>
> - 產卡本身是非同步(要跑 Pillow worker),但 `applyCommand` 保持同步、
>   單一 `store.mutate`。做法是新增 `server/src/textOverlays.ts` 的
>   `resolveTextCommand()`,在 `applyCommand` **之前**跑一個前置:偵測
>   command 是否帶 `text`,是的話先產卡,把算出的 `imagePath` 併進**一個
>   新的 command 物件**再交給 `applyCommand`——`text` 與 `imagePath` 保證
>   落在同一次 mutate,不會有字改了、圖還沒換的中間態。`resolveTextCommand`
>   涵蓋 `addOverlay`、`updateOverlay`、`setOverlays` 三種(見下)。
> - `server/src/wsHub.ts` 的 command handler 因此改成 async,並用一個
>   promise chain(`commandQueue = commandQueue.then(run, run)`)把 command
>   序列化,確保多筆 command 仍照抵達順序套用,不會因為前置產卡是非同步
>   而互相超車。
> - `commands.ts` 新增共用的 `validateOverlayTextCard()` 作為命令層的
>   backstop:`text` 已給但 `imagePath` 是 `undefined` 或 `''`、`text`
>   全空白、`fontSize <= 0` 一律拒絕。這道驗證獨立於 `resolveTextCommand`
>   前置存在——就算某個呼叫端(例如某支忘了跑前置的 MCP 工具)漏接前置,
>   也不會讓一個沒有實際圖檔的 `imagePath` 存進 doc。空字串 `imagePath`
>   在 render 階段會被 `join(projectDir, '')` 解析成專案目錄本身,餵給
>   `ffmpeg -i` 只會悄悄失敗——這正是 `set_overlays` 一開始漏接前置時
>   code review 抓到的真實風險(見下)。

- render.ts **一行不改**:它只認 `imagePath`,文字 overlay 的 PNG 是真實檔案。
- MCP 自動獲得能力(命令層共用);`add_overlay`、`update_overlay`、
  `set_overlays` **三個工具都**接受 `text` 並各自跑 `resolveTextCommand`
  前置,描述同步補上「text 由伺服器自動產卡並維護 imagePath,imagePath
  傳空字串即可」。實作時 `set_overlays` 起初共用的 `overlaySchema` 讓它
  可以帶 `text` 卻沒接上前置(整組替換沒有走到 `addOverlay`/`updateOverlay`
  的路徑),code review 抓到後補上——現在 `resolveTextCommand` 對
  `setOverlays` 命令會逐一檢查陣列裡每個 overlay,有 `text` 的各自獨立
  產卡(可平行),沒有 `text` 的原樣放行;連同 `validateOverlayTextCard`
  這道命令層 backstop,兩層一起把這個洞補上。

## 7. 預覽端

### 座標空間(修分歧源 1)

字幕層與 overlay 層改為 **1080×1920 座標空間 + CSS `transform: scale()`**,
縮放比 = 預覽舞台寬/1080,與影片幀同源。廢除 `fontSize / 3`。

### 字卡顯示與 karaoke

> **與實作的形狀差異**(階段 3 完成後校對,§7 原設計把字幕與文字 overlay
> 寫成同一套「字卡直出 + karaoke」機制,實作只把這套機制接到**字幕**;
> overlay 走的是階段 2 就有的既有路徑,以下為與程式碼一致的版本。)

- **字幕**(`ui/src/player/CaptionLayer.tsx`):`<img src=/text-card/<hash>.base.png>`;
  有 tokens(karaoke)時上面疊一張**幾何相同**的 `<img …hl.png>`,以
  `clip-path` 揭到 `activeTokenIndex`(沿用 shared 現有函數)。capId→hash
  對照存 `useProject` 的 `captionCards`,由 WS `textCards` 訊息維護(見 §5①)。
  字卡幾何 fetch 中/失敗、或圖檔本身 `onError`,退回 `ApproxCaption`
  (DOM 文字近似)——**這是唯一的 fallback 路徑**,不是額外功能。
- **文字 overlay**:沒有走這套機制。`imagePath` 由 §6 的命令前置
  (`resolveTextCommand`)保證與 `text` 同步,預覽端直接
  `<img src=/media/<imagePath>>`(`ui/src/player/plan.ts`)——本來就是
  真實檔案,不需要另一層 hash 對照或 `/text-card` 路由。overlay 沒有
  karaoke(`OverlayText` 無 `tokens` 欄位),所以沒有 hl 卡、沒有
  `clip-path`。overlay 的「預覽=成品」靠的是「同一份檔案」這個更簡單的
  保證,不是本節描述的字卡直出機制。
- 多行 clip 區域 = 已唸完整行矩形 + 目前行至目前詞右緣矩形——
  **shared 純函數 `karaokeClip(boxes, active, pad?)`**(`pad` 補償描邊外擴),
  可單測;`tokenSeparator(prev, next)` 判斷詞間空白,與 `text_card.py` 同規則。
- `fx-enter` 動畫與 `style.y` 定位保留。

### 三段式即時編輯(打字路徑)

> **與實作的形狀差異**:原設計三段式套用到「字幕/overlay 通用」,實作**只有
> 字幕**(`ui/src/panels/CaptionList.tsx` + `ui/src/stores/editDraft.ts`)
> 接了這套流程;文字 overlay(`Inspector.tsx`)仍是階段 2 的作法——
> uncontrolled input,失焦才直接送完整 `updateOverlay` 命令,沒有本地近似
> 或預覽卡兩段。

1. **每鍵**:寫入 `useEditDraft`(`{id, text, previewHash: null}`),
   `CaptionLayer` 讀到後以 DOM 文字**近似**顯示(用 @font-face 同源字型,
   1080 空間內以真字級渲染——近似度高但不保證斷行相同)。
2. **停手 ~80ms**:打 `POST /text-card/preview` 產真卡,回 hash 後寫入
   `useEditDraft.setPreview`,`CaptionLayer` 換成 `<img>` 直出。打字期間
   持續顯示近似文字,**畫面永不空窗**。
3. **失焦/Enter**:才送 `updateCaption` 命令——只有這步進 history、可
   undo、寫檔、廣播;之後 `useEditDraft.clear()`。

打字**絕不走命令層**(避免一鍵一筆 history 與 WS echo 延遲)。

### 拖曳與吸附(階段 4 完成,與原設計的形狀差異見下方落地備註)

- 沿用 Timeline 既有模式:pointermove 只動本地 preview,pointerup 才
  `sendCommand`(overlay:`position`;字幕:`style.y`)。
- 吸附目標:畫布水平中心、垂直中心、上下安全邊距(5%);命中畫導線
  (視覺同時間軸黃線)。**吸附以實際 bbox 計算,不用 position 錨點**——
  overlay 錨點不對稱(x 是中心、y 是上緣,`translate(-50%, 0)`),
  用錨點算「垂直置中」會偏。
- shared 純函數 `snapBBox(bbox, canvas, threshold?)` 回吸附後位置與命中線。
- 點畫布上的 overlay/字幕會同步選取狀態,時間軸對應塊跟著亮起
  (一個方向:畫布→選取 store→時間軸;反方向——在時間軸選取——目前
  不會在畫布上畫出選取框,見下方落地備註)。

> **與實作的形狀差異**(階段 4 完成後校對,以下為與程式碼一致的版本):
>
> - **函數名與簽名**:原設計寫 `snapPosition(bbox, canvas, targets)`,實作是
>   `shared/src/snap.ts` 的 `snapBBox(b: BBox, canvas, threshold = 16): { x, y, guides }`
>   ——沒有 `targets` 參數(候選點是寫死的水平中心/垂直中心/上下安全邊距,不可外部
>   注入),吸附半徑是有預設值(16,畫布 px)、可覆寫的 `threshold`,不是原設計暗示的
>   固定值。垂直的三個候選(中心/上邊距/下邊距)互斥,只讓「離 bbox 最近的那一個」在
>   半徑內生效,避免同時吸兩條 y 導線;水平只有一個候選(中心)。
> - **錨點↔bbox 換算獨立成一層**:`snapBBox` 只認 bbox(左上角 x/y + 寬高),完全不知道
>   `position` 錨點的不對稱語意。這層換算實際由呼叫端 `ui/src/player/dragLayer.ts` 的
>   `dragOverlay`/`dragCaption` 兩個純函數負責(位移 canvas px → 呼叫 `snapBBox` → 换算
>   回 `position`),原設計沒有把這層獨立出來寫成一個具名模組,是實作校對後補的形狀。
>   `dragOverlay` 的 y 值 clamp 上限是 `canvas.h - bbox.h`(不是 `1`)——clamp 到 `1`
>   代表 bbox 上緣頂到畫布最底端,等於整個元素 100% 掉出畫面下緣,是本節開頭提到的
>   「錨點不對稱事故」的另一種踩法(見 `shared/src/snap.ts` 開頭註解),已用回歸測試
>   釘住(`ui/src/player/dragLayer.test.ts`)。
> - **pending-echo 橋接(原設計未提及)**:放手到 server echo 抵達之間有個空窗,
>   `Player.tsx` 用 `pendingRef`(配 1.2s 保險絲)在這段空窗內繼續顯示放手時的值,
>   且渲染與「下一次拖曳的起點」共用同一份合併結果——不然放手後立刻再拖一次會
>   從 doc 的舊值起算,把第一次的位移吃掉(round 1 review 抓到的真實 bug)。這是
>   Timeline 既有拖曳模式本來就有、字幕/overlay 拖曳延用過來的機制,原設計「沿用
>   Timeline 既有模式」這句話涵蓋了它,但沒有點名這個機制本身。
> - **選取同步是單向,不是「雙向」**:原設計寫「選取與時間軸雙向同步」。實作是
>   `Player.tsx` 的 `onOverlayPointerDown`/`onCaptionPointerDown` 在按下時呼叫
>   `useSelection.getState().select(...)`,`Timeline.tsx` 讀同一個 store 高亮對應
>   區塊——這個方向(畫布點選→時間軸高亮)確實成立。但 `Player.tsx` 從未讀
>   `useSelection` 來畫任何「目前選取的 overlay/字幕」視覺標記,所以反方向(在
>   時間軸點選一個 overlay/字幕)不會在畫布上出現任何選取框或高亮——不是雙向
>   同步,只是共用同一個選取 store 的單向效果。
> - **`<img>` 原生拖放的坑(原設計未提及,實作發現並修正)**:Task 16 的真瀏覽器
>   e2e 回歸(`npm run verify:canvas`)發現 overlay 的 `<img>`(`Player.tsx`)與
>   字幕卡的兩張 `<img>`(`CaptionLayer.tsx` 的 base/hl 卡)都沒有關掉瀏覽器原生
>   HTML5 拖放——按下後只要指標一移動,原生拖曳手勢就搶走事件序列(`dragstart`
>   觸發、隨即 `pointercancel`),自訂的 `pointerup` 永遠到不了,`sendCommand`
>   永遠不會送出;畫面上的本地覆蓋值會永久卡在放手時的座標(看起來像拖曳成功,
>   實際上伺服器端座標從未更新)。這不是合成事件才有的假象,真人用真滑鼠拖也會
>   踩到。已修:三個 `<img>` 都加上 `draggable={false}`。詳見 `CLAUDE.md`
>   「UI 驗證的陷阱」。

### 新增入口

時間軸工具列「Overlay」(上傳圖)旁加「Text」鈕:在 playhead 插入帶預設
樣式的文字 overlay 並立即進入編輯。

## 8. 效能預算(實測依據)

| 情境 | 成本 |
| --- | --- |
| 播放 | 零額外(靜態 PNG 合成;karaoke 僅 clip-path 變化) |
| 打字每鍵 | 0(本地近似) |
| 停手換真卡 | 80ms debounce + 7ms 產卡 + 載圖,體感 <200ms |
| 專案載入(100 句,冷) | 常駐 worker 批產 200 卡 ≈ 1.5s,背景進行 |
| 專案載入(熱) | 0(derived 快取) |
| 記憶體 | 100 句 × 2 張 1080 寬透明 PNG ≈ 10–30MB |

## 9. 錯誤處理

> 階段 1 落地備註:下面描述的是多階段逐步達成的目標行為。字幕 debounce 同步(`cardSync.ts`)
> 已實作的策略跟原設計不同,寫在這裡讓 spec 與程式碼一致——**實際做法更簡單**:
> **單句隔離,不是 stale 標記補產**。`CaptionCardSync.runNow()` 對每句字幕各自
> `try/catch`;失敗的那句直接**不進**廣播的 `entries` 陣列(等於沒有 hash),
> 其餘句照常產出、照常廣播,不會讓一句壞字型/壞資料拖垮整批。
> 沒有「暫留舊圖 + stale 標記 + 事後補產」這個中間態,因為字幕卡沒有「舊圖」
> 可留(第一次產卡失敗時根本沒有先前的 hash);UI 這端目前(階段 1)對
> `textCards` 訊息是 no-op,還沒有實際去讀 entries 裡有沒有自己的 id 來決定
> 「顯示字卡」或「退回近似顯示」——那個判斷邏輯要到階段 3 UI 接上 karaoke
> 字卡渲染時才會存在,屆時「找不到 hash → 退回 DOM 近似渲染」會是自然結果
> (沒有 hash,`<img>` 就沒有東西可指,元件邏輯上只能走近似分支),不需要額外的
> stale flag。

> **階段 2 落地備註**:文字 overlay 的命令路徑產卡失敗,實作**沒有**採用下面
> 原設計的「命令仍成功 + imagePath 暫留舊圖並標記 stale + 事後補產」——
> `resolveTextCommand()` 產卡拋出例外時直接往外傳,`server/src/wsHub.ts`
> 與 `server/src/mcp.ts` 的呼叫端都是整個 catch 起來、回錯誤給呼叫者
> (`commandError` / `text card generation failed: …`),**doc 完全不變**,
> 不會有一個文字 overlay 帶著沒更新的舊 `imagePath` 留在 doc 裡。等於是
> 比原設計更簡單的「失敗即整筆命令失敗(fail-closed)」,跟字幕路徑用「單句
> 隔離」不同——因為命令是使用者/AI 主動觸發的單一操作,失敗時讓呼叫端知道
> 並重試,比悄悄留一張舊卡更安全。下面兩點維持原設計描述作為**尚未實作**
> 的可能方向,標明現況。

- worker 掛/產卡失敗:該項退回 DOM 近似顯示(現行為保留為 fallback),
  toast「文字預覽暫以近似樣式顯示」;不阻塞編輯與其他卡;渲染路徑不受影響。
  (階段 1/2 現況:字幕 debounce 同步已做到「失敗句缺席」;文字 overlay 命令
  路徑是 fail-closed,見上方階段 2 備註。UI 端的近似顯示/toast 是階段 3
  才會實作的消費端行為。)
- 命令路徑產卡失敗(文字 overlay):~~命令仍成功(doc 已變),`imagePath`
  暫留舊圖並標記 stale,worker 恢復後補產。~~ **未採用**,實作是命令直接
  失敗、doc 不變(見上方階段 2 備註)。
- 批產中專案又變:以最新 doc 重排隊,hash 不符的任務丟棄。

## 10. 測試

- **shared 純函數**:`karaokeClip`(單行/多行/無 tokens)、`snapBBox`
  (中心/邊距/不吸附/垂直候選互斥;見 §7 落地備註,函數名與原設計的
  `snapPosition` 不同)、hash key 穩定性(同輸入同 key;改時間不變;改字必變;
  換 rasterizerId 必變)。
- **server(真 Pillow worker)**:base/hl 幾何一致(尺寸與 bbox 相同)、
  bbox 與繪製一致、快取命中不重產、worker 重啟恢復、字型表剔除不可用字型、
  文字 overlay 命令原子性(text 與 imagePath 同版本變更)。
- **UI**:Player 字卡渲染 smoke(有 hash 用 img、無 hash 走近似)、
  三段式編輯狀態機、CaptionList 現有測試不回歸。
- **真瀏覽器**:1080 空間縮放正確性/拖曳/吸附導線(jsdom 無版面引擎、無真
  pointer capture,量不出也拖不動)——實作為 `npm run verify:canvas`
  (`ui/e2e/canvas-direct.mjs`,仿 `verify:panels` 的 CDP harness,Task 16)。
- **端到端**:預覽字卡 hash 與渲染輸入一致(同 text_card.py 同參數)。

## 11. 升級路徑:Chromium 光柵器(本次不做,介面已備)

- 實作 `rasterize()` 的第二個 backend:常駐 headless Chromium(playwright
  快取版),一個常駐 page 當「字卡工作室」,HTML 模板吃同一份 style schema,
  CDP `captureScreenshot`(透明底 + clip);逐詞 bbox 用每詞 `<span>` 的
  `getClientRects()`。
- 觸發時機:需要花字/漸層/彩色 emoji/陰影等 CSS 級效果時。**可按樣式路由**:
  簡單樣式走 Pillow(7ms),華麗樣式走 Chromium(167ms)——合約相同,
  路由 trivial。
- 已知坑(本機實測):headless 無導航時 rAF 拿不到影格(要靠截圖強制產幀
  或 `--run-all-compositor-stages-before-draw`);開機 1.3s(常駐 + 崩潰重啟
  策略);字型要等 `document.fonts.ready`;版本用 playwright 鎖定。

## 12. 分階段交付

| 階段 | 內容 | 驗收 | 狀態 |
| --- | --- | --- | --- |
| 1 | 光柵器介面 + Pillow worker + 快取 + 端點 + 字型綁定 | API 拿卡;快取命中;字型表正確 | ✅ 完成(分支 `caption-wysiwyg`,commit `c1df31b`..`be7e70d`,8 commits)。落差見 §5/§9 的落地備註。 |
| 2 | 文字 overlay(模型/命令/Inspector/Text 鈕)+ MCP | 建立/改字/渲染成品正確 | ✅ 完成(分支 `caption-wysiwyg`,commit `2fa4fce`..`9654256`,6 commits)。落差見 §5/§6/§9 的落地備註。 |
| 3 | 預覽 1080 空間 + 字卡直出 + karaoke 兩卡 + 三段式編輯 | 預覽=成品;打字即時 | ✅ 完成(分支 `caption-wysiwyg`,commit `3d4ba2f`..`e0056dd`,5 個 phase-3 commit,中間穿插 2 個不相關 fix)。真瀏覽器實測(Task 13,headless Chromium,1440×820/1280×620/1920×1080 三視窗):caption 層 `transform: scale(...)` 與 `stageWidth / 1080` 誤差 0.000%,`fontSize/3` 舊估算在 1280×620 曾量到的 3.28× 誤差已消除。落差見下方落地備註。 |
| 4 | 拖曳 + 吸附導線(overlay 與字幕) | 真瀏覽器回歸通過 | ✅ 完成(分支 `caption-wysiwyg`,commit `c35b39b`..`442e2b0`,4 commits;真瀏覽器 e2e 回歸為 Task 16 新增,`ui/e2e/canvas-direct.mjs` / `npm run verify:canvas`,見 HANDOFF.md「階段 4」節)。落差見 §7 的落地備註。 |

每階段獨立可驗收;1→2→3 有依賴,4 只依賴 3 的座標空間。

**階段 1 完成後仍待確認**:UI 目前對階段 1 新增的一切(字卡端點、`textCards` WS 廣播)完全無感——`ui/src/stores/project.ts` 收到 `textCards` 訊息目前是刻意的 no-op(見 §9 備註),預覽畫面與匯出成品都還是階段 1 之前的行為。階段 1 只是讓「產卡」這件事本身做對、做快、做出可信賴的快取,沒有任何使用者可見的變化。

**階段 2 完成後仍待確認**:文字 overlay 是本設計第一個使用者看得到的行為——UI 有「Text」鈕、Inspector 能改文字/字級/顏色、AI 也能建立與修改,渲染成品會真的燒出字。但這**不是**§1 講的「預覽=成品」問題被解決:字幕(`tracks.captions`)的預覽仍是 `ui/src/player/Player.tsx` 的 `fontSize / 3` DOM 估算,完全沒有走階段 1 蓋好的字卡通道;文字 overlay 之所以在預覽裡看起來正確,純粹是因為 overlay 軌本來就整層畫成 `<img src=imagePath>`,跟階段 1/3 要解決的「同一光柵器」無關。`/api/fonts` 端點仍無 UI 消費者(沒有字型選單,新 overlay 一律 `Heiti TC`);沒有 `@font-face`、沒有打字即時預覽通道、沒有畫布拖曳——這些都在階段 3/4。

**階段 3 完成後仍待確認**:§1 講的「預覽=成品」問題本身已解決——字幕預覽改走 1080×1920 座標空間 + `transform: scale(stage寬/1080)`,`fontSize/3` 已移除,真瀏覽器實測三視窗誤差 0.000%(見上表)。`@font-face` 同源字型也已接上(`ui/src/App.tsx` 掛載時抓 `/api/fonts`、注入指向 `/fonts/:id` 的 `@font-face`),DOM 近似路徑(`ApproxCaption`)因此跟成品用同一份字型檔,不是瀏覽器預設字型——分歧源 5 在 fallback 期間也已消除。仍沒有的是**字型選單**:`/api/fonts` 只被 `@font-face` 注入消費,沒有任何 UI 讓使用者挑字型,新字幕/新文字 overlay 一律預設 `Heiti TC`。karaoke 的「一詞一卡爆量」問題(§2 非目標)在**匯出端**完全沒動,`server/src/render.ts` 仍是階段 1 就有的「一個詞一張卡」;本階段的 base+全高亮兩卡+`clip-path` 機制只用在**預覽端**。沒有畫布拖曳/吸附導線——排在階段 4。

**階段 4 完成後仍待確認**:overlay 與字幕都可以直接在預覽畫布上拖曳,吸附到水平/垂直中心與上下 5% 安全邊距時會出現黃色導線,放手才 `sendCommand`(`shared/src/snap.ts` 的 `snapBBox` + `ui/src/player/dragLayer.ts` 的錨點↔bbox 換算,細節見下方§7 落地備註)。真瀏覽器 e2e 回歸(Task 16,`npm run verify:canvas`)驗了三件事:縮放正確、拖曳後座標真的存到伺服器、拖近中心出現導線——三項都通過,過程中抓到並修掉一個會讓「拖曳」整個失效的真 bug(`<img>` 原生瀏覽器拖放搶走 pointer 事件序列,見 `CLAUDE.md`「UI 驗證的陷阱」)。仍待人親自驗收的是**體感**:吸附靈敏度/導線時機是否符合直覺、拖曳與階段 3 的打字三段式同時操作順不順手——這些自動化測不出來,e2e 只驗「機制有沒有跑」;另外 e2e 也沒有驗過「拖完之後跑一次真的 render,成品裡的位置是否與拖曳後看到的預覽一致」,只驗了「伺服器存的座標值變了」。
