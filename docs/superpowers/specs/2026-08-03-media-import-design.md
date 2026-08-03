# 素材匯入：零複製引用 + 素材庫

2026-08-03 使用者核准（「我要怎麼導入素材」→ 選定零複製引用 + 素材夾挑檔 + 素材庫且可直接排上主軌）。

## 為什麼是零複製

業界慣例是引用而非複製：Premiere 預設只建連結，複製要另外開 Ingest Settings 的 Copy；
CapCut 桌面版同樣只引用原檔，另提供「Copy media to project」手動打包。
只有雲端網頁編輯器（Kapwing 免費 250MB／VEED 免費 1GB）非上傳不可，
因為瀏覽器永遠不會把本機絕對路徑交給網頁 —— 那是安全模型的硬限制。

**vidcut 不受這個限制：server 就在 localhost，可以自己讀磁碟。**

本機實測（2026-08-03，M 系列 Mac）佐證取捨的優先順序：

| 項目 | 數據 |
|---|---|
| 現況上傳 300MB（`arrayBuffer()` + `express.raw`） | 瀏覽器 peak heap 301MB、Node peak RSS 297MB、919ms |
| 串流上傳同一支（`body: file` + `req.pipe`） | 瀏覽器 1MB、Node RSS +22MB、261ms |
| ingest 一支 60s 1080p | proxy 7.06s + filmstrip 1.40s + peaks 0.06s ≈ **8.5s（約 7× 實時）** |

上傳 300MB 只要 0.26 秒，ingest 一支 10 分鐘的片要約 85 秒 —— **瓶頸是 ingest，不是傳輸**。
所以本案不做串流上傳（零複製後根本不上傳），把力氣放在進度回饋。

## 核心決策：`MediaAsset.path` 的語意擴充

- **相對路徑** = 專案資料夾內（既有行為，舊專案不受影響）
- **絕對路徑** = 外部引用，原檔留在原地

新增 `shared/src/paths.ts` 的 `resolveMediaPath(projectDir, path)`：
`isAbsolute(path) ? path : join(projectDir, path)`。

**這是整案樞紐**：現有 4 處 `join(projectDir, media.path)` 全部換成它
（`render.ts:195/216/411`、`ingest.ts`）。不換的話絕對路徑會被拼成 `/專案/Users/...`。

衍生檔（`derived/<id>/` 的 proxy/filmstrip/peaks）**仍一律產在專案內**。
因此 UI 預覽（`mediaUrl` 取 `proxyPath ?? path`）與 `/media/*` 靜態服務都不用改。

## 階段 1：後端能力

做完即可透過 MCP 使用，不必等 UI。

- **`server/src/sourceFolder.ts`（新）** `scanSourceFolder(dir)`：列出白名單副檔名的檔案，
  回 `{ name, size, mtime }`（依 name 排序）。不遞迴子目錄、排除隱藏檔、目錄不存在或非目錄則丟錯。
  純讀檔，不碰 store。
  白名單：影片 `.mp4 .mov .m4v .webm .mkv`、音訊 `.mp3 .m4a .wav .aac`。
- **`GET /api/source?dir=<abs>`**：薄殼，呼叫上者。另回 `imported: boolean`
  （比對 `doc.media` 解析後的絕對路徑）。錯誤回 `400 { error }`。
- **`ingest.ts`**：接受專案外絕對路徑。既有的
  `media.find(m => m.path === relPath)` 冪等判斷換成絕對路徑後照樣成立，
  重複匯入同一支回既有 id、不重跑 ffmpeg。
- **`addClip` command**：走 `applyCommand`（人與 AI 共用的唯一寫入語意）。
  `{ mediaId, in, duration }` → append 到 `tracks.video` 尾端。
  驗證 mediaId 存在、`duration > 0`、`in + duration <= probe.duration`。
- **`POST /api/import { dir, names[], addToTimeline }`**：ffmpeg 要跑數秒到數分鐘，
  不能塞進 command 層。逐支序列處理（並行只會互搶 CPU），每支完成廣播一次 activity，
  最後回 `{ ok: [{ name, mediaId }], failed: [{ name, error }] }`。
  `addToTimeline` 為真時，每支 ingest 完接著送
  `addClip { mediaId, in: 0, duration: probe.duration }`（整支全長，之後再自己修剪）。
- **MCP `import_media`**：描述中的「須已放進專案資料夾」不再成立，一併更新並接受絕對路徑。
  AI 與 UI 走同一條路，不分裂成兩套語意。

## 階段 2：素材庫面板

右側面板新增第三個分頁 `Media`（與 Captions／Activity 並列）：

- 上方：素材夾路徑輸入 + 掃描
- 中間：可勾選的檔案清單，已匯入者標示
- 下方：「匯入選取」與「匯入並加到時間軸」
- 已匯入素材列表（`doc.media`），每列可「加到時間軸」；原檔離線者標示

## 錯誤處理

| 情況 | 行為 |
|---|---|
| 素材夾不存在／非目錄／無權限 | `400 { error }`，UI 顯示於輸入框下方 |
| 單一檔 probe 失敗 | 進 `failed[]`，其餘繼續 |
| ingest 中途失敗 | 清掉該支 `derived/<id>/`，不留半成品 |
| 已匯入但原檔被移走 | 素材庫標「離線」（列素材時對解析後路徑做一次 `existsSync`）。預覽照常（proxy 在專案內）；輸出前檢查缺檔並回明確錯誤 |
| 審核進行中 | 沿用既有守衛，不另立規則 |

## 不做（YAGNI）

- 串流上傳：零複製後沒有上傳這一步
- 遞迴掃描子目錄：先做一層
- 根目錄白名單：server 綁 127.0.0.1，且限制會擋到使用者自己的素材。
  仍拒絕 `..`、只回白名單副檔名、排除隱藏檔
- 素材夾路徑持久化：先每次輸入

## 驗收

**單元**：`resolveMediaPath`（相對／絕對／`..`／空字串）；`scanSourceFolder`
（副檔名過濾、隱藏檔、排序、目錄不存在丟錯）；`addClip`（未知 mediaId、超界、正常 append）。

**整合（真 ffmpeg，沿用專案不 mock 的慣例）**：ingest 一支專案外的檔 →
`media.path` 為絕對路徑、`derived/` 在專案內、`mediaUrl` 指向 proxy；
重複 ingest 回同一 id；**render 吃絕對路徑素材能正常輸出**（`resolveMediaPath` 最關鍵的迴歸點）。

**UI（階段 2）**：素材庫面板 smoke（doc 為 null 與已載入）；勾選後送出的 payload 正確。

全綠 + lint/typecheck/build；實際操作由使用者驗。
