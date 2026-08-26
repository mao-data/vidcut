# 畫布尺寸依賴盤點(2026-08-26,Explore agent,已由 controller 抽查確認)

## 結論

server 端(render/光柵器/命令驗證)**已經全部讀 `project.canvas`,是乾淨的**。
硬編集中在 **UI 預覽層**與 **e2e 驗證腳本**。命令層**沒有 setCanvas**(只有 setCanvasFit)。

## 1. render 管線 —— 全讀 canvas,零硬編

- `render.ts:595` `const {width,height,fps} = project.canvas`
- contain: `render.ts:722-723` `scale=W:H:force_original_aspect_ratio=decrease,pad=...`
- blur: `render.ts:713-718` split=2 / increase+crop+boxblur / decrease → overlay
- overlay 座標:`render.ts:907-908` 用 ffmpeg 的 `W`/`H` 變數,非字面量
- 字卡寬:`render.ts:1337` `project.canvas.width`
- 匯出單邊推算:`render.ts:991-997` 依畫布比例,已支援任意比例
- `frame.ts:71,79` 讀 canvas
- ⚠️ `BLUR_RADIUS=24`(`render.ts:566`)是絕對像素,註解自承「對 1080 寬視覺剛好」——換橫式是**調校**問題非壞掉

## 2. 字卡光柵器 —— 全參數化;cardKey 已含畫布寬

- `rasterizer.ts:36` `CardRequest.width` 是參數;`:74-76` `cardMargin(width,frac)` 由 width 推導
- `cardBudget.ts:144` 同源;`:45-47` widthMin16/widthMax4096(4K 涵蓋,不擋)
- **`textCards.ts:38` `w: req.width` 進 sha1** ⇒ 換畫布 = 全部字卡 hash 變 = 全量重畫
- 寫入路徑全讀 `store.doc.canvas.width`:cardSync.ts:72、textOverlays.ts(8 處)、commands.ts:721/1153/1205/1296/1332、app.ts:1284
- ❗**唯一破口 `ui/src/panels/CaptionList.tsx:40`**:`width: 1080` 明給,蓋掉 server 預設 ⇒ 橫式下預覽卡與成品卡 hash 不同 = WYSIWYG 落差

## 3. UI 預覽 —— 硬編最集中

`Player.tsx`:**869 `aspectRatio:'9/16'`**(整條縮放鏈的物理前提)、592 `scale=stageW/1080`、940-941 層尺寸、952-953 位置換算、671 拖曳邊界、676 字幕拖曳、851 命中框、1038/1051 導線。Player **完全沒讀 doc.canvas.width/height**。
`CaptionLayer.tsx`:303、382 `top: 1920*y`(兩條路徑)
`dragLayer.ts`:`dragCaption()` 高是參數、**寬四處硬編 1080**(117,118,122,123);`dragOverlay()` 收完整 canvas 物件=乾淨
`shared/src/snap.ts:37-53` 完全參數化,無問題

## 4. mograph —— 與畫布解耦,最不痛

- 烘焙尺寸來自 props 自己的 width/height(`html.ts:14-15`,16..2160),**與 canvas 無關**
- `htmlMographKey` 含的是 props 尺寸 ⇒ **換畫布不會讓 mograph 快取失效**
- `htmlBakePool` key = `${w}x${h}`,本來就多尺寸並存 ⇒ **零影響**
- ❗要改的是**提示文字**:`mcp.ts:35,69,100`、`mographLibrary.ts:92,96`、`toolRegistry.ts:2019` 向 AI 宣告「1080x1920 portrait / re-layout for vertical」——橫式下會讓 AI 做反向重排版

## 5. 其他

| 檔案                                 | 判定                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `publish.ts`                         | 只查秒數/位元組,不碰尺寸 ⇒ 不會壞(註解過期)                                                                 |
| ❗`ExportMenu.tsx:9-13`              | PRESETS 硬編三檔;720×1280/4K 明給直式 width/height ⇒ **橫式畫布會壓變形**(`render.ts:995` 不做 aspect 保護) |
| `proxyPlan.ts:38` MAX_DIMENSION=1920 | 用 `max()` 比長邊,橫直對稱 ⇒ 不會錯                                                                         |
| `filmstrip.ts:34-48`                 | 素材比例驅動,與畫布無關 ⇒ 不會錯                                                                            |
| `stockProviders.ts:231`              | 用 `min()` 短邊,對稱;orientation 無預設 ⇒ 不會錯(但 AI 受 mcp.ts 宣告間接偏直式)                            |

## 6. 命令層 —— setCanvas 不存在

- `types.ts:559` Command union 只有 `setCanvasFit`;`commands.ts:771-776` 只寫 `d.canvas.fit`
- `get_project` 讀得出 canvas,無 setter ⇒ 畫布只能在 `createProject()`(`types.ts:712`)決定
- ✅ `store.ts:53` `isUndoable()` 已認 `canvas` 開頭的 patch ⇒ 基礎設施就緒

## 7. e2e —— 假設極深

`preview-vs-export.mjs`:`:47 CANVAS={w:1080,h:1920,fps:30}` 已常數化(好),但 `:133,137` byte 對帳、`:606` fixture、`:1268,1286` 換算、CASES 期望值(`:279-281`、`:692`)是**直式下量的絕對像素**,參數化後仍要重建基線
❗`canvas-direct.mjs`:硬編密且未常數化;**`:235` 靠 `s.width==='1080px'&&s.height==='1920px'` 字串比對找 DOM**、`:329` 靠 `height==='1920px'` 找導線 ⇒ 換尺寸**直接掛掉不是變紅**;`:314` 畫布中心寫死 540

## 三個硬骨頭

1. **cardKey 含畫布寬 ⇒ 改比例全專案字卡失效**:重畫量=句數×詞數,舊 PNG 全變孤兒且無 GC;且 `commands.ts` 用**新寬驗舊內容**,窄畫布下既有長字幕可能超 MAX_CARD_PIXELS 讓改畫布本身失敗
2. **`Player.tsx:869 aspectRatio:'9/16'`**:不是一個數字,是 `scale=stageW/1080` 成立的物理前提;只改除數不改形狀 ⇒ 全域靜默偏移(正是本 repo 反覆修過的那類 bug)
3. **e2e 守門失效 × 遷移**:`canvas-direct.mjs` 會掛掉,而它是「縮放係數單一來源」的唯一守門人;等於在無回歸網狀態下新增一條會改動所有既有專案的路徑。且 `canvas` 已 undoable ⇒ 一次 setCanvas 產生涵蓋全專案重烤的 undo entry,undo 語意要定義
