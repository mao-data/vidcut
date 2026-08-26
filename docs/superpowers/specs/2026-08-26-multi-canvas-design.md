# 多畫布比例(橫式輸出)設計定案

**日期**:2026-08-26
**狀態**:待使用者審(審過才進 plan → SDD 實作)
**分支歸屬**:**`main`(開源線)——使用者 2026-08-26 拍板**。這是通用編輯器能力不是雲端功能;
做完推 origin,之後照常 `main → 商業線` 吸收。⚠️ 不要只做在 cloud-upload。
⚠️ main 的字卡光柵器是 **Pillow**(`text_card.py`)不是 Skia,字卡相關驗證要在 Pillow 路徑上做。

---

## 1. 問題

vidcut 從產品定位到程式碼都假設「直式短影音 1080×1920」。使用者要能做**橫式長影片**
(16:9),而畫布比例目前**無法變更**——`Project.canvas` 是資料欄位,但:

- 命令層沒有 `setCanvas`(只有 `setCanvasFit` 管 contain/blur),畫布只能在 `createProject()`
  寫死成 1080×1920。
- UI 預覽層(`Player.tsx`)**完全不讀** `doc.canvas`,整條座標鏈是 1080/1920 字面量。

盤點全文見 `docs/superpowers/plans/2026-08-26-multi-canvas-survey.md`。
一句話總結:**server 端(render/光柵器/命令驗證)早就參數化了,痛點在 UI 預覽層與 e2e 腳本。**

---

## 2. 使用者決策(2026-08-26)

| 問題                 | 決定                                       |
| -------------------- | ------------------------------------------ |
| 「長影片格式」是什麼 | **橫式畫布(16:9 等多比例)**,不是「長時長」 |
| 誰決定畫布、何時     | **建專案時選 preset,之後可改**             |
| 這輪範圍             | **只出計劃,不動工**                        |

---

## 3. 定案

### 定案 1:比例用 preset,不開放自由輸入

四檔 preset,`shared/src/canvasPresets.ts`(新檔,與 `captionPresets.ts` 同一套哲學:
UI chips 與 MCP 讀同一份):

| id             | 尺寸      | 用途                      |
| -------------- | --------- | ------------------------- |
| `portrait`     | 1080×1920 | 直式短影音(**預設,現狀**) |
| `landscape`    | 1920×1080 | YouTube 橫式長片          |
| `square`       | 1080×1080 | IG 貼文                   |
| `portrait-4-5` | 1080×1350 | IG 直式貼文               |

理由:自由輸入的驗證面(奇數、極端比例、超出 `CARD_LIMITS.widthMax=4096`)遠大於收益,
而且**畫布寬直接進字卡預算與 cardKey**——任意寬度等於任意重烤成本。fps 維持專案既有值,
不隨 preset 動(preset 只管幾何)。

⚠️ **專案檔存展開後的具體 width/height,不存 preset 名字**(與字幕 preset 同一紀律):
日後調 preset 數值不會靜默改掉既有專案。UI 要把 chip 亮回來靠反查尺寸。

### 定案 2:新增 `setCanvas` 命令,重烤是它的一部分

```ts
{
  name: 'setCanvas';
  width: number;
  height: number;
}
```

三步鐵則照走:`types.ts` 加 variant → `commands.ts` 加驗證與 case → `toolRegistry.ts`
`defineTool` + `mcp.ts` instructions 同步(工具 `set_canvas`,+1)。

**驗證(寫在 commands.ts 這層,不在 MCP/UI)**:

1. 寬高必須命中 preset 表(不接受任意值)。
2. **預檢既有內容在新寬度下的字卡預算 —— 真的擋得到,不是純理論**(2026-08-26 兩次實測)。

   ⚠️⚠️ **本節有一段已被推翻的結論,保留在這裡當方法教訓,不要照舊版數字做決策。**

   **第一次實測(錯的)**:在 `cloud-upload`(Skia 線)量,結論是「四檔 preset 之間差
   一個數量級,打不到上限」。**那條線有 `setCardMeasure` 注入真實字型量測,走
   `exactLines`(真的折一次行)。**

   **第二次實測(對的,Task 2 實作者發現、controller 覆核)**:本批做在 `main`
   (**Pillow 線,沒有精確量測**),走的是 `maxWrappedLines` **保守上界估算**——
   取「字元數上界」與「前進寬上界(`greedyLineBound`)」的較小值。行為完全不同:

   | 構造                      | 1080 寬              | 1920 寬                   |
   | ------------------------- | -------------------- | ------------------------- |
   | 50 全形字 @ fontSize 176  | 50 行 → **11.40M ✓** | 31 行 → **12.57M ✗ 超標** |
   | 30 字 @ fontSize 64(正常) | 0.99M                | 1.04M                     |
   | 120 字 @ fontSize 64      | 3.95M                | 3.96M                     |

   **成因**:1080 寬時「每字一行」的**字元數上界飽和**,行數被鎖在 50 降不下去;
   換到 1920 寬,行數只降到 31(-38%)但寬度多 78% ⇒ 總像素反而漲。
   所以「畫布變寬 ⇒ 字卡變矮」在上界估算這一段**不成立**。

   **方法教訓(這才是重點)**:第一次的錯不在算術,在**拿 A 分支量的數字寫進 B 分支
   的 spec**。main 是 Pillow、商業線是 Skia,兩條線的字卡估算路徑不同——
   **凡是字卡相關的數字,必須在目標分支上量。**

   **裁決不變**:預檢照做,真觸發時整個拒絕改畫布,錯誤訊息點名是哪幾句
   (`capId` + 前 20 字)。理由不變:「改了但那幾句壞掉」是靜默不一致。
   但**定位要修正**——它不是「永不觸發的安全網」,而是**真的擋得到極端內容的驗證**。
   仍然不需要為它設計使用者引導流程(正常字幕 fontSize 64 離上限差近一個數量級),
   一則清楚的錯誤訊息就夠。

3. 寬高相同(no-op)直接回成功不動 doc(避免無謂的全量重烤)。

**重烤**:命令套用後,字幕由既有 `CaptionCardSync` 重產、文字 overlay 由既有
`refreshTextOverlayCards()` 重解析——**兩條遷移機制已經存在**(這正是 `SkiaRasterizer.id`
升號時用的同一套),不用新寫。

**undo 語意裁決**:`store.ts:53` 的 `isUndoable()` 已認 `canvas` 路徑,所以 setCanvas
**是可 undo 的**,undo 回去會再觸發一次反向重烤。這是正確語意(畫布是專案狀態),
成本由定案 1 的 preset 限制與定案 3 的孤兒清理兜住。

### 定案 3:孤兒字卡在改畫布時清一次

改畫布會讓 `derived/text/` 全部變孤兒(cardKey 含 `w`)。**裁決:setCanvas 完成重烤後,
掃一次 `derived/text/`,刪掉沒有被任何 caption/overlay 的 imagePath 指到的 PNG+JSON。**
不做全域 GC(那是另一批的事),只在這個明確會製造大量孤兒的操作上就地清。
⚠️ undo 回去時舊卡會被重新產生(內容定址,同輸入同 key),所以刪掉是安全的。

### 定案 4:Player 的 stage 幾何改由 canvas 驅動(硬骨頭 ②)

`Player.tsx:869` 的 `aspectRatio: '9/16'` **不是一個數字,是 `scale = stageW/1080` 成立的
物理前提**:stage 形狀決定 `objectFit:contain` 的 video 是否精確填滿它。

**改法必須成套,一次到位**:

- `aspectRatio` → `` `${canvas.width}/${canvas.height}` ``
- `scale = stageW / canvas.width`(:592,註解已寫「不得重算/硬編」,維持單一來源)
- 座標層 `width/height`(:940-941)、overlay 位置(:952-953)、拖曳邊界(:671)、
  字幕拖曳(:676)、命中框(:851)、吸附導線(:1038,1051)全部改讀 `doc.canvas`
- `CaptionLayer.tsx:303,382` 兩處 `1920*y`
- `dragLayer.ts` 的 `dragCaption()` 補 `canvasW` 參數(照 `dragOverlay` 的樣子)
- ❗`CaptionList.tsx:40` 拿掉 `width: 1080`(讓 server 用 canvas 預設)——這是現存的
  WYSIWYG bug 種子,橫式下預覽卡與成品卡會是不同 hash

**漏一處就是靜默 WYSIWYG 落差**,所以定案 5 的守門是這一項的前置,不是後續。

### 定案 5:e2e 腳本先參數化,才動 Player(硬骨頭 ③)

`canvas-direct.mjs` 靠 CSS 字串 `'1080px'`/`'1920px'` 比對找 DOM(`:235`, `:329`)——
換尺寸**直接掛掉而不是變紅**,而它是「縮放係數單一來源」的唯一守門人。

**順序鐵則:先讓兩支腳本吃 `VIDCUT_CANVAS` 環境變數(預設 portrait,行為不變),
確認直式全綠,再改 Player。** 反過來做等於在無網狀態下走鋼索。

- `canvas-direct.mjs`:DOM 定位改用 `data-testid`(不要用尺寸字串),畫布中心 `540` 改推導
- `preview-vs-export.mjs`:`CANVAS` 已是具名常數(好);fixture(`:606`)、byte 對帳
  (`:133,137`)、換算(`:1268,1286`)跟著參數化。⚠️ CASES 的期望值是**直式下量的絕對
  像素**(`:279-281`、`:692`),橫式基線要**重新量一次**,不要用推算的
- 橫式 case 至少要有:字幕置中、overlay 定位、掛畫布外裁切三項(涵蓋 x/y 兩軸換算)

### 定案 6:ExportMenu 的 preset 改成相對畫布

`ExportMenu.tsx:9-13` 硬編 `1080×1920` / `720×1280` / `4K 2160×3840`,橫式畫布下第二、
三檔會**強行輸出直式把畫面壓變形**(`render.ts:995` 不做 aspect 保護)。

**裁決:preset 改成倍率語意**——「原尺寸」「0.67×」「2×」,實際尺寸由 `canvas` 推算後
顯示在標籤上(`1920×1080` 這樣)。順帶在 `render.ts` 補一道:只給單邊時已經依比例推算
(`:991-997` 已正確),但**兩邊都給且比例與畫布不符**時應該警告而非靜默壓變形。

### 定案 7:AI 提示文字動態化

`mcp.ts:35,69,100`、`mographLibrary.ts:92,96`、`toolRegistry.ts:2019` 向 AI 宣告
「vertical short video (1080×1920)」「re-layout 1920x1080 blocks for the vertical canvas」
——橫式畫布下這些會讓 AI 做**反向**重排版。改成從當前 canvas 動態組字串。
⚠️ 這會動 `mcp-surface-snapshot`,照鐵則先讀 diff 再 `-u`。

### 不做(明確排除)

- **自由輸入寬高**(定案 1 的理由)
- **每個 clip 各自的畫布**(`set_canvas_fit` 已解決素材比例不符的問題)
- **全域孤兒 GC**(定案 3 只就地清)
- **`BLUR_RADIUS` 相對化**:`render.ts:566` 的 24px 在橫式下模糊感略弱,屬**調校**,
  記在 HANDOFF 待實測後再定,不進這批
- **publish.ts 的平台語意**:橫式 master 對 Shorts/Reels 是產品問題不是程式問題,另議

---

## 4. 風險與代價

| 風險                                 | 緩解                                                                |
| ------------------------------------ | ------------------------------------------------------------------- |
| 改畫布觸發大量重烤(句數×詞數張 PNG)  | preset 限制次數;`CaptionCardSync` 是既有機制;預檢先擋掉會失敗的情況 |
| 漏改一處 UI 座標 = 靜默 WYSIWYG 落差 | 定案 5 的順序鐵則:守門先參數化並跑出橫式基線                        |
| 既有專案                             | 零影響——預設仍是 1080×1920,不改就完全不動                           |
| 開源/商業線                          | 這批進 `main`;`main → 商業線` 是合法方向                            |

## 5. 驗收

1. 直式專案行為**逐位元組不變**(render filtergraph、字卡 PNG hash)——這是憲法級要求
2. 橫式專案:`verify:wysiwyg` 橫式基線全綠、`verify:canvas` 橫式全綠
3. `set_canvas` 走 MCP 改成橫式 → 字幕/overlay 自動重烤且預覽=成品
4. undo 回直式 → 字卡回到原本的 hash(內容定址驗證)
5. gauntlet 全綠(含突變測試;新增的 setCanvas 驗證要有 mutant 守)
