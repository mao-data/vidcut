# 發佈包（Publish Package）P0 設計定案

日期：2026-08-21。對應調研：社群媒體 API 整合利弊與成本（結論：P0 不接任何平台 API）。

## 目標

render 完成後，把「拿去各平台手動上傳」需要的所有東西打成一個資料夾：
成品影片＋封面＋.srt＋各平台文案檔＋manifest（含各平台上傳連結與時長/檔案大小警告）。
零平台 API、零審核、零外部費用。同時把「經使用者自己的 Buffer connector 發佈」寫成文件。

## 明確不做（P0 邊界）

- 不接 TikTok/YouTube/IG/Facebook/X 任何 API，不做 OAuth，不存任何平台憑證。
- 不做每平台重新轉檔：**一支 1080×1920 H.264+AAC master 四平台通吃**
  （TikTok/Reels/Shorts/Facebook 都收），發佈包裡的 video.mp4 就是 render 成品的複本。
- **「長影片」指時長，不指橫式畫布**：發佈包支援長片目標（YouTube 一般影片、
  Facebook 一般影片，見 `kind`），但 16:9 橫式編輯／render preset 是另一個 feature，
  不進這份。直式長片（如 10 分鐘 1080×1920）現在就能打包。
- 不做 UI 表單填文案：文案（標題/內文/hashtags）由 AI 經 MCP 工具帶入
  （AI 本來就是這個產品的剪輯者）；人只在 UI 看結果、點連結。
- 聚合商（upload-post/Ayrshare）是 Phase 1，屬 pro/cloud 線，不進這份。

## 資料模型（shared/src/types.ts）

```ts
export type PublishPlatform = 'tiktok' | 'youtube' | 'instagram' | 'facebook';
/** 目標形式：短片（Shorts/Reels）或一般影片（長片）。 */
export type PublishKind = 'short' | 'video';
export interface PublishMeta {
  title?: string; // YouTube/Facebook 用；TikTok/IG 忽略
  body: string; // caption / description
  hashtags?: string[]; // 不帶 #
  /**
   * 只影響警告門檻與 manifest 標記，不影響檔案內容。
   * 省略時的預設：youtube→short（vidcut 主產出是直式短片）、facebook→video、
   * tiktok/instagram 只有 short（帶 video 也當 short）。
   */
  kind?: PublishKind;
}
export interface PublishInfo {
  dir: string; // 相對專案資料夾，output/publish/<stamp>
  stamp: string;
  platforms: PublishPlatform[];
  files: string[]; // 相對專案資料夾
  warnings: string[]; // "tiktok: …" 格式
  createdAt: string; // ISO 8601
}
```

- `RenderState` 加 `publish?: PublishInfo`（跟 `lastOutput`/`coverPath` 同一層級、
  同一種「非 undoable」性質——patch path 是 `render`，不進 undo 堆疊）。
- `Command` 加 `{ name: 'setPublish'; info: PublishInfo }`，走 registerMedia/setCover
  同一個模式：async 檔案工作在外面（`publish.ts`），命令層只做同步登記＋驗證。
  AI 路徑經 `aiWrite` 因此吃得到審核鎖。

## 發佈包內容（output/publish/<stamp>/）

| 檔案             | 來源                                                           | 條件                         |
| ---------------- | -------------------------------------------------------------- | ---------------------------- |
| `video.mp4`      | `output/<stamp>.mp4` 複本                                      | 必有（render done 才能打包） |
| `cover.jpg`      | `render.coverPath` 複本                                        | 有封面才有                   |
| `subtitles.srt`  | `serializeSrt(captions)`                                       | 有字幕才有                   |
| `<platform>.txt` | `metaToText(meta)`：title、空行、body、空行、`#tag` 列         | 每個帶了 meta 的平台一個     |
| `manifest.json`  | 打包摘要：影片秒數/bytes、各平台 uploadUrl＋warnings＋textFile | 必有                         |

## 平台檢查（警告，不擋）

門檻按（platform, kind）查表；平台不支援該 kind 時退回它唯一的 kind：

| 平台      | kind           | maxSeconds               | maxBytes | 上傳連結                                     |
| --------- | -------------- | ------------------------ | -------- | -------------------------------------------- |
| tiktok    | short（唯一）  | 600（網頁上傳保守值）    | 4 GiB    | `https://www.tiktok.com/tiktokstudio/upload` |
| youtube   | short（預設）  | 180（超過就不算 Shorts） | 256 GiB  | `https://studio.youtube.com/`                |
| youtube   | video          | 43200（12 小時）         | 256 GiB  | 同上                                         |
| instagram | short（唯一）  | 180（Reels 一般帳號）    | 1 GiB    | `https://www.instagram.com/`                 |
| facebook  | short（Reels） | 90                       | 4 GiB    | `https://www.facebook.com/`                  |
| facebook  | video（預設）  | 14400（240 分鐘）        | 10 GiB   | 同上                                         |

超限只產生 warning 字串（進 manifest、MCP 回覆、UI），不會讓打包失敗——
長片本來就是合法目標（YouTube/Facebook 一般影片）。manifest 每平台記 `kind`。

## MCP 工具：`export_publish_package`

- input：`{ tiktok?, youtube?, instagram?, facebook?: PublishMeta, ifVersion? }`，至少帶一個平台
  （PublishMeta 含 `kind?: 'short' | 'video'`）。
- 前置：`render.status === 'done'` 且 `lastOutput` 檔案存在，否則明確報錯「先 render」。
  審核中比照 auto_caption 先擋（真正守衛仍是 aiWrite）。
- 流程：`buildPublishPackage()` → `aiWrite(store, { name:'setPublish', info })` → 回
  structured `{ dir, files, warnings, version }` ＋文字摘要（含各平台 uploadUrl）。
- **鐵則第三步**：mcp.ts `registerTool` ＋ instructions 同步更新＋
  `mcp-surface-snapshot.test.ts` 讀 diff 後 `-u`。

## UI（ExportMenu 下拉，render done 之後）

- 一列固定的「上傳頁」連結（TikTok Studio / YouTube Studio / Instagram / Facebook），
  render done 就顯示——沒打包也能用。
- `render.publish` 存在時：列出包內檔案的 `/media/<dir>/<file>` 連結＋warnings。
  UI 不提供「建立發佈包」按鈕（文案來自 AI；人要包就在聊天裡請 AI 包）。

## Buffer / MCP 工作流（文件，不寫程式）

`docs/PUBLISH.md`：發佈包使用方式、平台限制表、以及 Buffer connector 工作流——
使用者自己在 client 連 Buffer，agent 用 render 成品 URL 建 create_post。
**誠實註記**：Buffer 拿檔案要公開 URL，本機 127.0.0.1 拿不到，此工作流僅雲端部署可用；
本機一律走發佈包手動上傳。

## 驗證

- 純函數（warnings/metaToText）與檔案操作（buildPublishPackage）：`server/test/publish.test.ts`
  （不跑真 render——手寫假的 `output/<stamp>.mp4` 即可，打包只做複製與 stat）。
- MCP 面：`server/test/mcp-publish.test.ts`（InMemoryTransport，比照 mcp-tools.test.ts）。
- UI：`ui/src/panels/ExportMenu.test.tsx`（seedProject 塞 render.publish）。
- 全量：`npm test`、`npm run typecheck`、`npm run lint`、UI 改動後 `npm run build -w @vidcut/ui`。
