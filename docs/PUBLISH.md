# 發佈：從 render 到各平台

vidcut P0 **不接任何社群平台 API**（利弊與成本調研見
`docs/superpowers/specs/2026-08-21-publish-package-p0.md` 的背景段）。
發佈走兩條路：發佈包手動上傳（本機與雲端都可），或使用者自己的 Buffer connector（僅雲端）。

## 發佈包（export_publish_package）

render 完成後，AI 呼叫 `export_publish_package` 並附各平台文案：

- 產出 `output/publish/<stamp>/`：`video.mp4`（成品複本；1080×1920 H.264 四平台通吃，
  不重轉檔）、`cover.jpg`（有設封面才有）、`subtitles.srt`（有字幕才有）、
  每平台一個 `<platform>.txt`（標題／內文／hashtags）、`manifest.json`。
- 每平台可帶 `kind: 'short' | 'video'` 指定目標形式（只影響警告門檻）：
  短片＝Shorts/Reels，`video`＝一般長片。預設 youtube→short、facebook→video；
  tiktok/instagram 只有 short。**長影片**（如 10 分鐘以上）發 YouTube/Facebook
  帶 `kind: 'video'` 即可，不會出現 Shorts 警告。
- 平台超限只**警告不擋**（見下表）；警告同時出現在工具回覆、manifest 與 ExportMenu。
- 重跑會整個目錄重建，舊平台檔不殘留。
- 建議搭配 `render` 的 `subtitles: 'sidecar'`——畫面乾淨、字幕交給平台（會自動翻譯）。

| 平台      | 上傳頁                                     | 警告門檻                                                     |
| --------- | ------------------------------------------ | ------------------------------------------------------------ |
| TikTok    | https://www.tiktok.com/tiktokstudio/upload | >600s、>4 GiB                                                |
| YouTube   | https://studio.youtube.com/                | short：>180s（超過就不算 Shorts）；video：>12 小時；>256 GiB |
| Instagram | https://www.instagram.com/                 | >180s（Reels 一般帳號）、>1 GiB                              |
| Facebook  | https://www.facebook.com/                  | short（Reels）：>90s、>4 GiB；video：>240 分鐘、>10 GiB      |

UI：Export 下拉在 render 完成後顯示四個上傳頁連結；打包後列出包內檔案與警告。

## Buffer connector 工作流（僅雲端部署）

使用者在自己的 AI client 連了 Buffer connector 時，agent 可以：
render（`subtitles: 'sidecar'`）→ `export_publish_package` 產文案 → 用 Buffer 的
create_post 建立貼文／排程，影片 URL 用部署站的 `/media/output/publish/<stamp>/video.mp4`。

⚠️ **本機（127.0.0.1:3845）不可行**：Buffer 抓不到本機 URL。本機一律走發佈包手動上傳。
發佈是不可逆動作——排程／發佈前先 `request_review` 取得使用者確認。

## Phase 1 之後（尚未實作）

聚合商一鍵發佈（upload-post／Ayrshare）屬 pro/cloud 線；`PublishProvider` 抽象與
OAuth 皆走雲端，不進開源 repo。見調研報告的分階段建議。
