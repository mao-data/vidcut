# 多畫布比例 —— 實作計畫

**Spec**:`docs/superpowers/specs/2026-08-26-multi-canvas-design.md`(已定案)
**分支**:`multi-canvas`(基於 `main`@f918aa5,開源線)
**光柵器**:main 是 **Pillow**(`server/scripts/text_card.py`),不是 Skia

---

## Global Constraints(每個任務都受約束)

1. **憲法級**:直式(1080×1920)專案行為**逐位元組不變**——render filtergraph 字串、
   字卡 PNG hash。任何任務都不得改變直式路徑的輸出。
2. **順序鐵則**:e2e 腳本(Task 4)**必須先參數化並跑出直式全綠**,才准動 `Player.tsx`
   (Task 5)。`verify:canvas` 是「縮放係數單一來源」的唯一守門人,反過來做等於無網走鋼索。
3. 三步鐵則:新增命令 = `types.ts` variant → `commands.ts` 驗證與 case →
   `toolRegistry.ts` defineTool + `mcp.ts` instructions。漏第三步 = AI 永遠碰不到。
4. UI 產品字串**英文**;程式註解**繁體中文**。
5. 不 `git add -A`(多 session 工作區);vitest 絕不裸 `-w`;不跑 `npm run demo`。
6. 改 UI 原始碼後要 `npm run build -w @vidcut/ui`,否則 :3845 跑的還是舊版。
7. 動到 MCP 工具面 → `mcp-surface-snapshot` 必紅,**先讀 diff 確認新描述屬實**再 `-u`。

---

## Task 1:canvas preset 表(shared,純資料+純函數)

**檔案**:`shared/src/canvasPresets.ts`(新)、`shared/src/canvasPresets.test.ts`(新)

四檔 preset,照 `captionPresets.ts` 的形狀:

| id             | width | height | label(英文)    |
| -------------- | ----- | ------ | -------------- |
| `portrait`     | 1080  | 1920   | Portrait 9:16  |
| `landscape`    | 1920  | 1080   | Landscape 16:9 |
| `square`       | 1080  | 1080   | Square 1:1     |
| `portrait-4-5` | 1080  | 1350   | Portrait 4:5   |

匯出:`CANVAS_PRESETS`(陣列,順序即 UI 顯示順序)、
`findCanvasPreset(width, height)`(反查,UI 亮 chip 用——**比尺寸不比名字**,
因為專案存的是展開值)。

**測試**:四檔都能反查到自己;非 preset 尺寸回 undefined;寬高都是偶數
(h264 不吃奇數,這是實質約束不是形式檢查)。

---

## Task 2:`setCanvas` 命令(server,含預算安全網)

**檔案**:`shared/src/types.ts`、`server/src/commands.ts`、對應測試

1. `Command` union 加 `{ name: 'setCanvas'; width: number; height: number }`
2. `commands.ts` 加 case + 驗證(**驗證一律寫這層**):
   - 寬高必須命中 `CANVAS_PRESETS`(不接受任意值)
   - **no-op 早退**:與現值相同 → 成功但不 mutate(避免無謂全量重烤)
   - **預算安全網**(spec 定案 2,已降級為安全網):對每一句字幕與每個文字 overlay,
     用**新寬度**跑一次 `cardRequestError`;有任何一項失敗 → **整個命令拒絕**,
     錯誤訊息點名 `capId` + 文字前 20 字。
     ⚠️ 實測(spec 內表格)四檔 preset 之間切換打不到這條線——這是安全網不是主流程,
     **不要為它設計使用者引導**。
3. `store.ts:53` 的 `isUndoable()` 已認 `canvas` 路徑,setCanvas 自動可 undo,**不用改**

**測試**:非 preset 尺寸被拒;no-op 不產生新版本;預算失敗時 doc 完全沒動
(用一句刻意超長的字幕 + 一個窄畫布構造,即使實務打不到也要釘住這條路);
成功時 `doc.canvas.width/height` 變更且進 undo 堆疊。

⚠️ 本任務**不做**重烤接線(Task 3),只做命令與驗證。

---

## Task 3:改畫布後的重烤與孤兒清理

**檔案**:`server/src/cardSync.ts`、`server/src/textOverlays.ts`、`server/src/index.ts`
(或 setCanvas 的後置鉤子,實作者判斷放哪最乾淨)、對應測試

1. **重烤**:setCanvas 成功後,字幕由既有 `CaptionCardSync` 重產、文字 overlay 由
   既有 `refreshTextOverlayCards()` 重解析。**兩條機制都已存在**(升 rasterizer id 時
   用的同一套),本任務是**接線**不是新寫。確認新 canvas.width 有傳到位。
2. **孤兒清理**(spec 定案 3):重烤完成後掃 `derived/text/`,刪掉沒有被任何
   caption/overlay 的 imagePath 指到的 PNG + JSON。**只在 setCanvas 後就地清**,
   不做全域 GC。⚠️ undo 回去時舊卡會被重新產生(內容定址,同輸入同 key),所以刪安全。

**測試**:改畫布後每張字卡的 imagePath 都指向新寬度的卡(hash 變了);
`derived/text/` 沒有殘留孤兒;**undo 之後字卡 hash 回到原本的值**(內容定址驗證,
這條同時證明清理是安全的)。

---

## Task 4:e2e 腳本參數化(**Task 5 的前置,不可對調**)

**檔案**:`ui/e2e/canvas-direct.mjs`、`ui/e2e/preview-vs-export.mjs`

兩支都吃 `VIDCUT_CANVAS` 環境變數(值為 preset id,**預設 `portrait`**)。

**`canvas-direct.mjs`**(問題最大):

- ❗`:235` 靠 CSS 字串 `s.width === '1080px' && s.height === '1920px'` 找座標層 wrapper、
  `:329` 靠 `height === '1920px'` 找吸附導線 → **換尺寸直接掛掉而不是變紅**。
  改用 `data-testid`(要在 `Player.tsx` 加對應屬性——這是 Task 5 的一部分,
  所以本任務先加 testid、腳本改吃 testid,**兩邊都保持直式行為不變**)
- `:314` 畫布水平中心寫死 `540` → 改 `canvas.w / 2`
- 其餘散落的 1080/1920 收斂成一個具名常數

**`preview-vs-export.mjs`**:

- `CANVAS`(`:47`)已是具名常數(好),改成從 `VIDCUT_CANVAS` 解析
- fixture 造素材(`:606`)、rawvideo byte 對帳(`:133,137`)、截圖換算(`:1268,1286`)
  跟著參數化
- ⚠️ **CASES 的期望值是直式下量的絕對像素**(`:279-281`、`:692`)。本任務**不改它們**,
  只讓腳本在直式下跑出與今天相同的結果。橫式基線是 Task 6 的事。

**驗收**:`npm run verify:canvas` 與 `npm run verify:wysiwyg` 在**不設 `VIDCUT_CANVAS`**
時全綠且結果與改動前相同(這是本任務唯一的驗收——參數化不得改變直式行為)。

---

## Task 4.5:修 `verify:canvas` 的量測環境(**Task 4 實測逼出來的,Task 5 的真前置**)

⚠️ **這個任務不在原計畫裡。** Task 4 完成後實測發現:`verify:canvas` **在改動前就是紅的**,
而且紅的項目會在「檢查 2/3」與「檢查 4」之間**交替**——它每次跑都把 overlay 位置寫回
`projects/demo`,下一次的起點就是上一次的終點,於是紅在哪一項取決於上次跑完的狀態。

**controller 親自覆核的三項事實**(2026-08-26):

1. `stageW=200.81`——viewport 明明是 1440×820,stage 卻只有 200.8px 寬(scale 0.186,
   1 螢幕 px ≈ 5.4 畫布 px)。吸附門檻 16 畫布 px 只剩約 3 螢幕 px,拖曳精度整個失真。
2. **根因**:`canvas-direct.mjs:111` 只設 `--window-size`,**沒有下
   `Emulation.setDeviceMetricsOverride`**。同 repo 的 `preview-vs-export.mjs:702` 有下,
   所以它 6/6 全綠。這正是 `.claude/rules/ui-verification.md` 明文記載的坑:
   「測 RWD 必須用 CDP setDeviceMetricsOverride,`--window-size` 會造成假破版」。
3. baseline(`5392f52`,Task 4 之前)實跑同樣紅,只是紅在檢查 4 —— **不是 Task 4 的回歸**。

**要做的事**:

- `canvas-direct.mjs` 補 `Emulation.setDeviceMetricsOverride`(照 `preview-vs-export.mjs:702`
  的用法),讓 stage 拿到真實寬度
- **消除狀態污染**:腳本每次跑都寫回 demo,導致「這次的起點=上次的終點」。
  要嘛跑完還原、要嘛改用自己的臨時專案(照 `verify:wysiwyg` 的作法)。
  ⚠️ 已知陷阱(`.claude/rules/ui-verification.md`):位移量不能是「相對起點的固定偏移」,
  幾次之後會把元素逼到畫布邊緣、clamp 讓前後值撞在同一個數字 = 假性失敗
- 驗收:**連跑兩次都全綠**(這正是狀態污染會破的條件)

**為什麼必須在 Task 5 之前做**:Task 5 要改 `Player.tsx` 的整條座標鏈,
`verify:canvas` 是唯一守門人。守門人自己是紅的且紅點會漂,改完根本分不出
「紅是我改壞的」還是「本來就紅」。

## Task 5:Player 座標鏈改由 canvas 驅動

**檔案**:`ui/src/player/Player.tsx`、`ui/src/player/CaptionLayer.tsx`、
`ui/src/player/dragLayer.ts`、`ui/src/panels/CaptionList.tsx`、對應測試

⚠️ **前置:Task 4 必須已完成且直式全綠。**

`Player.tsx`(main 線行號):

- `:656` `aspectRatio: '9/16'` → `` `${canvas.width}/${canvas.height}` ``
  **這不是一個數字,是 `scale = stageW/1080` 成立的物理前提**——stage 形狀決定
  `objectFit:contain` 的 video 是否精確填滿它。只改除數不改形狀 = 全域靜默偏移。
- `:381` `scale = stageW / 1080` → `/ canvas.width`(維持單一來源,註解已寫「不得重算/硬編」)
- `:710-711` 座標層 width/height、`:738-739` overlay 位置、`:460` 拖曳邊界、
  `:465` 字幕拖曳、`:638` 命中框、`:774` 與另一處導線 → 全部讀 `doc.canvas`
- 加 `data-testid`(Task 4 的腳本要用)

`CaptionLayer.tsx`:兩處 `1920 * cap.style.y`(字卡路徑與 DOM fallback 路徑)
`dragLayer.ts`:`dragCaption()` 補 `canvasW` 參數(照 `dragOverlay` 收完整 canvas 的樣子);
四處硬編 `w: 1080`
❗`CaptionList.tsx:33`:拿掉 `width: 1080`(讓 server 用 `doc.canvas.width` 預設)
——**這是現存的 WYSIWYG bug 種子**,橫式下預覽卡與成品卡會是不同 hash

**漏一處就是靜默 WYSIWYG 落差**,這正是本 repo 反覆修過的那類 bug。

**驗收**:直式 `verify:canvas` / `verify:wysiwyg` 全綠且與改動前相同;UI 單元測試全綠。

---

## Task 6:橫式基線 + 橫式 e2e case

**檔案**:`ui/e2e/preview-vs-export.mjs`(加橫式 case)、可能的 fixture

在 `VIDCUT_CANVAS=landscape` 下跑出橫式基線。至少三個 case(涵蓋 x/y 兩軸換算):

1. 字幕置中(驗 y 軸換算與卡片全寬)
2. overlay 定位(驗 x/y 兩軸)
3. overlay 掛畫布外裁切(驗負座標,兩端同一條線)

⚠️ **期望值要重新量,不要用直式數字推算**(spec 定案 5)。
⚠️ 視窗尺寸:直式用 `1200x1400`,橫式要另挑(stage 寬 < 400px 時量測本底雜訊會超過
4px 容差——這是已知的假紅來源,見 `.claude/rules/ui-verification.md`)。

---

## Task 7:MCP 工具面 + ExportMenu + 提示文字

**檔案**:`server/src/mcp.ts`、`ui/src/panels/ExportMenu.tsx`、UI 入口(實作者判斷放哪合設計)

⚠️ **計畫原本寫錯檔案**:`toolRegistry.ts` 是**商業線**的重構,**main 沒有這個檔**。
main 線的工具直接寫在 `mcp.ts` 裡(`server.registerTool(...)`),
範本看 `set_canvas_fit`(`mcp.ts:1835`)。

0. ❗**必做第一件事:刪掉 `server/test/mcp-docs-sync.test.ts` 的 `setCanvas` 豁免**
   (Task 2 留下的**暫時性**中間態——命令層先落地、工具後補)。留著等於讓鐵則第三步
   的守衛對這個 variant 永久失效。刪掉後那支測試會要求 `set_canvas` 工具真的存在,
   正好是本任務的驗收。
1. **`set_canvas` 工具**(defineTool + instructions 同步,工具數 +1)。描述要講明:
   改畫布會重烤所有字卡、可 undo、只接受 preset。
2. **UI 入口**:畫布 preset 選擇器(chips 或下拉),讀 `CANVAS_PRESETS`、
   用 `findCanvasPreset` 亮回當前值。英文字串。
3. ❗**`ExportMenu.tsx:9-13`**:硬編 `1080×1920`/`720×1280`/`4K 2160×3840`,
   橫式畫布下第二、三檔會**強行輸出直式把畫面壓變形**(`render.ts` 只在單邊給定時
   依比例推算,兩邊都給且比例不符時不做保護)。→ 改成**倍率語意**
   (原尺寸 / 0.67× / 2×),實際尺寸由 canvas 推算後顯示在標籤(`1920×1080` 這樣)。
4. **AI 提示文字動態化**:`mcp.ts` 的「vertical short video (1080×1920)」等宣告
   → 從當前 canvas 動態組字串。橫式下這些會讓 AI 做**反向**重排版。
   ⚠️ 動到工具面 → snapshot 必紅,先讀 diff 再 `-u`。

---

## Task 8:文件與收尾

- `CLAUDE.md`:畫布不再寫死 1080×1920 的敘述;`HANDOFF.md` 補 `canvasPresets.ts` 職責行
  (gauntlet 的文件引用檢查會抓新檔案)
- `.claude/rules/wysiwyg.md`:「預覽即成品」的範圍加註畫布維度
- `scripts/mutants.json`:setCanvas 的驗證要有 mutant 守(preset 檢查、預算安全網)
- 跑 `bash scripts/gauntlet.sh` 全綠

---

## 驗收(spec §5)

1. 直式專案行為**逐位元組不變**(filtergraph + 字卡 hash)——憲法級
2. 橫式:`verify:wysiwyg` 橫式基線全綠、`verify:canvas` 橫式全綠
3. `set_canvas` 走 MCP 改橫式 → 字幕/overlay 自動重烤且預覽=成品
4. undo 回直式 → 字卡 hash 回到原值(內容定址驗證)
5. gauntlet 全綠(含新增 mutant)
