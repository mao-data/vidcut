# vidcut 上線計劃與可行方向

最後更新 2026-08-03。現況與已驗證範圍見 `HANDOFF.md`；各項設計定案見 `docs/superpowers/specs/`。

## 進行中

### 素材匯入：零複製引用 + 素材庫

設計定案：`docs/superpowers/specs/2026-08-03-media-import-design.md`

| 階段 | 內容                                                                                                                                                   | 狀態                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| 1    | `resolveMediaPath` 路徑語意、`scanSourceFolder`、`GET /api/source`、ingest 接受外部絕對路徑、`addClip` command、`POST /api/import`、MCP `import_media` | ✅ `main` + `list_source`、`add_clip` 補完 |
| 2    | 右側面板新增 `Media` 分頁：素材夾掃描 → 勾選匯入 → 已匯入清單 → 加到時間軸                                                                             | 待實作                                     |

後端零複製能力 + MCP 工具已全部上線；MCP 面原先階段 1 完成時仍有空白（`import_media` 掛、`add_clip` 缺），現已補完。

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

`ui/e2e/panel-affordance.mjs` 目前涵蓋面板收合/展開控制項（12 項斷言、4 種視窗尺寸）。
同樣的手法（真瀏覽器命中測試）可延伸到時間軸拖曳與字幕編輯 —— jsdom 量不出被遮擋與捲動裁切。

### 8. MCP elicitation URL mode

`request_review` 目前是「阻塞 + UI 核准 + 保活 + 逾時」。
讓 Claude Code 直接彈出瀏覽器審核頁需要 v2 SDK 遷移，因無法自動驗證而擱置（見 `HANDOFF.md`）。

### 9. 音訊素材支援（大半已完成）

**匯入這半已經通了**：`main` 的 `ecc5e0f` 放寬 `probe`（無視訊串流不再丟錯）、
純音訊跳過 proxy/filmstrip 只產 peaks；合併後素材夾裡的 `.mp3/.m4a/.wav/.aac`
可以被 `GET /api/source` 列出、`POST /api/import` 零複製匯入
（`import-api.test.ts` 的兩條端到端測試守著）。

**MCP 那條也已經通了**：`import_media`（吃絕對路徑）→ `set_audio`（schema 本來就吃
`mediaId`）→ `render`，實測可產出含 BGM 的成品。缺的只有 `POST /api/import` 帶
`addToTimeline: true` 時的分流——目前它一律呼叫 `addClip`（只上視訊軌且擋 audio-only），
所以匯入 BGM 會進 `failed[]`（素材其實已匯入）。可行方向：新增 `addAudio` command
（`{ mediaId, start, in, duration }` → append 到 `tracks.audio`），`/api/import` 依
`probe.hasVideo` 分流到 `addClip` 或 `addAudio`。這是產品決策，待定。

### 10. Origin／Host header 檢查

Server 綁 `127.0.0.1`（`index.ts:36` 已確認），但沒有 Origin／Host header 檢查。
DNS rebinding 攻擊下，惡意網頁可誘使受害者瀏覽器對 `127.0.0.1:3845` 發請求，
`GET /api/source?dir=…` 會給攻擊頁面**任意目錄列舉**能力——這是「素材匯入」分支
新增的能力面（先前只有 `/api/project` 洩漏專案內路徑，範圍小得多）。根目錄白名單
已核准不做（見 spec 的 YAGNI 段），但 Host header 檢查（拒絕 Host 不是
`127.0.0.1:<port>` 或 `localhost:<port>` 的請求）是最便宜的等效防護，不需要額外設定。

### 11. 素材匯入分支留下的已知缺口

八輪 TDD 期間逐條記錄、經 controller 裁決延後的項目（原始紀錄在該分支的
`.superpowers/sdd/2026-08-03-media-import-backend/progress.md`）：

- **`updateClip` 與 `updateAudio` 的 `1e-6` 容差無 mutant 覆蓋**——與 `addClip` 同形，但只有 `addClip` 那處有 `addclip-bounds` 守著。補兩隻 mutant 即可，屬小 Task。
- **`GET /api/source` 的「素材夾無權限」分支無專屬測資**——與「目錄不存在」共用同一條
  catch，行為正確但沒有獨立驗證。
- **`POST /api/import` 的 `failed[].error` 可能夾帶絕對路徑**——與既有 `/api/source`
  的錯誤格式一致，非新增問題，但若日後要對外開放需一併處理。
- **無全域 ffmpeg 佇列**——「逐支序列」只在單一 `/api/import` 請求內成立（由
  `import-api.test.ts` 的 `maxInFlight===1` 守著）；兩個併發請求、或 import 與
  `render`／`transcribe` 併行時不成立。
- **`scanSourceFolder` 逐檔序列 `await stat`**——上萬檔的素材夾會慢，目前規模無影響。

## 上線前必須由人確認

自動化測試涵蓋不到，需要真人與真環境：

- 播放流暢度與 A/B 無縫切換的實際觀感
- 成品觀感（字幕排版、ducking 音量、blur 填充）
- Claude Code 的真實 MCP 連線（目前驗過 transport，未驗過完整對話流程）
