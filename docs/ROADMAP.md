# vidcut 上線計劃與可行方向

最後更新 2026-08-03。現況與已驗證範圍見 `HANDOFF.md`；各項設計定案見 `docs/superpowers/specs/`。

## 進行中

### 素材匯入：零複製引用 + 素材庫

設計定案：`docs/superpowers/specs/2026-08-03-media-import-design.md`

| 階段 | 內容                                                                                                                                                        | 狀態   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1    | `resolveMediaPath` 路徑語意、`scanSourceFolder`、`GET /api/source`、ingest 接受外部絕對路徑、`addClip` command、`POST /api/import`、更新 MCP `import_media` | 待實作 |
| 2    | 右側面板新增 `Media` 分頁：素材夾掃描 → 勾選匯入 → 已匯入清單 → 加到時間軸                                                                                  | 待實作 |

階段 1 完成即可透過 MCP 使用，不必等 UI。

## 可行方向（尚未排程）

依「有實測或程式碼佐證」排序，前面幾項是已經量過或讀過程式碼確認的。

### 1. Proxy 參數可設定

`ingest.ts` 目前寫死 `scale=-2:960`。實測一支 60s 1080p 的 ingest 約 8.5 秒
（proxy 7.06s / filmstrip 1.40s / peaks 0.06s，約 7× 實時），4K 素材會顯著更慢。
讓 proxy 高度可設定（例如 540 供快速預覽、720 供精修）可直接換取匯入速度。
**輸出不受影響** —— render 走 `media.path` 原檔，只有封面截圖會退回 proxy。

### 2. ingest 進度與取消

目前 ingest 是不可中斷的黑箱。一支 10 分鐘 1080p 約需 85 秒，使用者需要看到進度、能取消。
`POST /api/import` 已規劃每支完成廣播一次 activity，但**單支內部**的 ffmpeg 進度尚未回報。

### 3. 離線素材重新連結（relink）

零複製後，原檔被移動會讓輸出失敗（預覽仍可用，proxy 在專案內）。
Premiere 與 CapCut 都有 relink UI，這是引用式架構的標準配套。

### 4. 專案打包／搬移

等同 Premiere Ingest Settings 的 Copy 模式：把外部引用的原檔複製進專案資料夾，
讓專案可整包搬到別台機器。與零複製並存、由使用者選擇。

### 5. 上傳路徑串流化

只影響 overlay 上傳（`POST /assets`，目前 `express.raw` 上限 20MB）。
本機實測 300MB 檔案：現況 `arrayBuffer()` + `express.raw` 讓瀏覽器 peak heap 301MB、
Node peak RSS 297MB、耗時 919ms；改成 `body: file` + `req.pipe` 後為 1MB / +22MB / 261ms。
改動只有兩行（client 拿掉 `arrayBuffer()`、server 換成 `pipeline`）。
**注意**：`ReadableStream` 上傳那條路走不通 —— Chrome 要求 HTTPS + HTTP/2，
而 vidcut 是 `http://127.0.0.1` 的 HTTP/1.1，Firefox/Safari 也未支援。直接丟 `File` 就夠。

### 6. 素材夾體驗

路徑持久化與最近使用清單、遞迴掃描子目錄、素材縮圖與 scrub 預覽。
刻意留到有實際使用回饋再做。

### 7. e2e 檢查擴充

`ui/e2e/panel-affordance.mjs` 涵蓋面板收合/展開控制項（12 項斷言、4 種視窗尺寸）；
`ui/e2e/canvas-direct.mjs`（`npm run verify:canvas`，字幕 WYSIWYG Task 16 新增）涵蓋
預覽畫布的 1080 空間縮放正確性、overlay/字幕直接拖曳、吸附導線——這部分**已完成**，
不再是待辦。同樣的手法（真瀏覽器命中測試 + CDP 合成 pointer 事件）仍可延伸到**時間軸**
本身的拖曳（trim/排序/縮放吸附）與字幕列表面板的雙擊改字 —— jsdom 量不出被遮擋、
捲動裁切，也沒有真的 pointer capture 可以測拖曳。

### 8. MCP elicitation URL mode

`request_review` 目前是「阻塞 + UI 核准 + 保活 + 逾時」。
讓 Claude Code 直接彈出瀏覽器審核頁需要 v2 SDK 遷移，因無法自動驗證而擱置（見 `HANDOFF.md`）。

## 上線前必須由人確認

自動化測試涵蓋不到，需要真人與真環境：

- 播放流暢度與 A/B 無縫切換的實際觀感
- 成品觀感（字幕排版、ducking 音量、blur 填充）
- Claude Code 的真實 MCP 連線（目前驗過 transport，未驗過完整對話流程）
- 畫布拖曳/吸附的手感（吸附靈敏度、導線時機）與打字三段式的體感；拖曳/改字後
  實際渲染一次，比對成品與預覽畫布是否一致（e2e 只驗了伺服器座標值有變，
  沒有跑過真的 render 去比對成品像素）
