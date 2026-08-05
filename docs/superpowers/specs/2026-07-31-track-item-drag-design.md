# 字幕／音訊／overlay 拖曳與調長

2026-07-31 使用者選定「全部＋可調長度」。背景：M2 只給影片主軌做了拖曳互動，
其他軌只能點選後去 Inspector 改數字——命令層本來就支援移動，缺的是 UI 手感層。

## 語意（關鍵差異）

影片主軌是磁性軌（拖曳＝換順序）；字幕/音訊/overlay 是**絕對時間定位**
（拖曳＝平移 `start` 秒數），另寫一套拖曳數學，pattern 沿用主軌（純函式＋preview＋放手送命令）。

## 行為

| 軌              | 本體拖曳                                                 | 左緣 trim                                        | 右緣 trim                        |
| --------------- | -------------------------------------------------------- | ------------------------------------------------ | -------------------------------- |
| 字幕            | 平移 `start`（≥0，吸附）                                 | 右緣不動：`start`+`duration` 對調（min 0.1s）    | 改 `duration`（min 0.1s）        |
| 音訊            | 平移 `start`（≥0，吸附）                                 | 右緣不動：`start`/`in`/`duration` 連動（`in`≥0） | 改 `duration`（≤ 素材長 − `in`） |
| overlay（絕對） | 平移 `start`（≥0，吸附）                                 | —（duration 可為 null=到片尾，不做拖曳 trim）    | —                                |
| overlay（錨定） | 平移＝改 `anchor.offset`（**保持跟隨片段**，offset 可負） | —                                                | —                                |

> 2026-08-05 修訂：原定「offset ≥ 0」改為允許負值。資料層（命令驗證、MCP、`overlayWindow`、
> 渲染）本來就支援負 offset，只有 UI 拖曳在放手時單邊夾制——造成「往後拖無上限、往前拖
> 彈回」的不對稱，且放手值與拖曳預覽不一致（會閃跳）。現與 Inspector（拿掉 `min="0"`）
> 一致：負 offset＝先於錨定片段出現，仍跟隨片段移動。

- 吸附沿用主軌的 `snapTime` 候選（片段邊界/片尾/playhead/整秒），吸附對象＝被拖的那個邊
- 拖曳中本地 preview、放手才送命令（與主軌一致，無樂觀更新問題）
- 拖曳自動選取該項目

## 命令層小擴充

`updateOverlay` patch 加 `anchor`，並讓兩種定位互斥且自洽：

- `patch.start` 給了 → 設 `start`、**刪 `anchor`**（轉絕對；修掉現況「錨定時設 start 無效」的隱性陷阱）
- `patch.anchor` 給了 → 設 `anchor`（驗證 clipId 存在）、**刪 `start`**

MCP `update_overlay`（若無此工具則僅 WS/Command 層）與 zod schema 同步。

## 不做

- overlay 的拖曳 trim（duration:null 語意複雜，Inspector 改數字已夠用）
- 跨軌拖曳、多選拖曳
- server 端其他行為

## 驗收

拖曳數學純函式測試；updateOverlay 互斥規則命令層測試；現有測試全綠；
typecheck/lint/build 乾淨；截圖無版面迴歸；拖曳手感由使用者驗。
