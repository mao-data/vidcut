# vidcut

AI 原生的本機影片時間軸編輯器。AI（Claude Code 或任何 MCP client）透過 MCP 剪片，人類在瀏覽器裡即時看到每一步、隨時介入調整，AI 讀回人類的調整繼續工作。

參考對象：[Vyra](https://www.usevyra.com/) 的 External AI Integration 模式。

## 快速開始

```bash
npm install                 # 安裝所有 workspace 依賴
brew install ffmpeg         # 需要原生 ffmpeg/ffprobe

npm run demo                # 建 demo 專案 + 起 server（127.0.0.1:3845）
npm run dev:ui              # 另開終端機 → http://localhost:5173
```

瀏覽器會顯示時間軸與預覽播放器。按 ▶ 播放，點時間軸任意位置 seek。

## 開發指令

| 指令                                 | 作用                                 |
| ------------------------------------ | ------------------------------------ |
| `npm test`                           | 跑所有 workspace 的 vitest           |
| `npm run typecheck`                  | 三個 workspace 的 tsc --noEmit       |
| `npm run lint`                       | ESLint                               |
| `npm run format`                     | Prettier 寫入                        |
| `npm run dev:server -- <projectDir>` | 起 server 服務某專案                 |
| `npm run dev:ui`                     | 起 Vite dev server（proxy 到 :3845） |

## 架構

單一 Node 程序（`server/`）綁 `127.0.0.1:3845`，一個 port 服務四種流量：靜態 UI、`/media/*`（原生 Range，給 `<video>`）、`/mcp`（M3）、`/ws`（狀態同步）。專案狀態是一份 `project.json`，所有變更（AI 或人）都走 `ProjectStore.mutate()` 這條序列化路徑，經 immer patch 廣播給瀏覽器。

```
shared/   @vidcut/shared  型別 + 純函數（server/ui 共用）
server/   @vidcut/server  ProjectStore、ffmpeg、ingest、http/ws、（M3）MCP、（M4）render
ui/       @vidcut/ui      React：ws client、A/B 播放器、時間軸
```

詳細設計見 [`docs/superpowers/specs/`](docs/superpowers/specs/)，實作計畫見 [`docs/superpowers/plans/`](docs/superpowers/plans/)，目前進度與已知限制見 [`HANDOFF.md`](HANDOFF.md)。

## 里程碑

- **M1 看得到** ✅ — ProjectStore + WS 同步 + ingest + 唯讀時間軸 + A/B 無縫預覽
- **M2 改得動** ✅ — 命令層 + trim 拖拉、排序、Inspector 編輯、undo、活動面板
- **M3 AI 接上** ✅ — MCP server（15 工具）+ request_review 審核閉環 + 編輯脈絡回報
- **M4 渲染** ✅ — ffmpeg 從 project.json 輸出 1080×1920 成品 + 進度 + 渲染 UI

- **T1 CapCut 快贏** ✅ — 播放頭分割/刪左右/定格、時間軸縮放吸附、音訊混音與 ducking、blur 填充、匯出選項、封面

全部里程碑的核心功能已實作並自動化驗證。親眼驗收與 Claude Code 實連步驟見 [`HANDOFF.md`](HANDOFF.md)。

## 快捷鍵

| 鍵             | 作用                           |
| -------------- | ------------------------------ |
| 空白           | 播放 / 暫停                    |
| `S` / `Ctrl+B` | 在播放頭分割片段               |
| `Q` / `W`      | 刪除播放頭左側 / 右側          |
| `F`            | 插入定格幀                     |
| `N`            | 吸附開關                       |
| `Shift+Z`      | 時間軸全覽                     |
| `←` `→`        | 逐幀移動（`Shift` 一次 10 幀） |
| `Ctrl`+滾輪    | 以游標為錨縮放時間軸           |
| `Cmd/Ctrl+Z`   | 復原                           |

## 接 Claude Code

```bash
npm run dev:server -- projects/demo          # 先起 server
claude mcp add --transport http vidcut http://127.0.0.1:3845/mcp
```

然後在 Claude Code 裡請它用 vidcut 剪片；你在瀏覽器 UI 即時看到並可介入。
