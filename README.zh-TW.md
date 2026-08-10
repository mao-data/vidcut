<div align="center">

# vidcut

**AI 原生影片編輯器——AI 走 MCP 剪片，你在瀏覽器裡監修。**

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.base.json)
[![MCP](https://img.shields.io/badge/MCP-native-8b5cf6.svg)](#接上你的-ai)

[English](README.md)

<img src="docs/assets/hero.png" alt="vidcut UI — 時間軸、即時預覽、字幕面板" width="900" />

</div>

## vidcut 是什麼？

vidcut 是一個 **本機優先的直式短影音（1080×1920）時間軸編輯器**，核心理念只有一句話：**AI 跟人共用同一條時間軸、同時編輯**。

它*不是* prompt 生影片的產生器。AI agent（Claude Code 或任何 MCP client）透過 [31 個 MCP 工具](#mcp-工具)剪片——匯入素材、粗剪、上字幕、混音、輸出。每一步變更都經 WebSocket **即時出現在你的瀏覽器**。你拖一下字幕、修一刀 trim、留一句審核意見——AI 讀回你的調整、接著做。這是人在迴路中的剪輯協作，不是黑盒子。

- 🖥️ **本機且私密** —— 單一 Node 程序綁 `127.0.0.1:3845`，素材不出你的機器。
- 🤝 **為監修而生** —— AI 可呼叫 `request_review`；你在瀏覽器裡批註；它讀回意見繼續工作。
- 🔍 **字幕與 overlay 所見即所得** —— 預覽與成品用*同一張*光柵化字卡（PNG 逐位元組相同），並由像素級回歸測試守著。
- 🎬 **真實渲染管線** —— ffmpeg 從 `project.json` 合成 1080×1920 成品，含進度回報。

## 運作方式

```
┌──────────────┐   MCP  /mcp    ┌───────────────────────────┐   WebSocket  /ws   ┌───────────────┐
│ Claude Code  │ ─────────────▶ │   vidcut server  :3845    │ ◀────────────────▶ │   瀏覽器 UI    │
│ （或任何 MCP │                │  ProjectStore · 命令層    │                    │  時間軸 ·     │
│   client）   │ ◀───────────── │  ffmpeg · whisper · 字卡  │                    │  A/B 預覽 ·   │
└──────────────┘   審核閉環     └────────────┬──────────────┘                    │  Inspector    │
                                             │                                   └───────────────┘
                                        project.json
                                      （唯一真相來源）
```

一個程序、一個 port、四種流量：靜態 UI、`/media`（原生 Range 給 `<video>`）、`/mcp`、`/ws`。所有狀態變更——不管來自 AI 還是人——都走同一條序列化命令路徑，再以 immer patch 廣播給瀏覽器。

## 功能

- ✂️ **時間軸剪輯** —— 播放頭分割／刪左／刪右／定格、拖拉 trim、排序、磁性軌、以游標為錨縮放、吸附導線、undo/redo
- 📺 **無縫預覽** —— A/B 雙 `<video>` 播放器，跨剪點不斷幀
- 🗣️ **自動字幕** —— whisper.cpp 逐詞時間戳＋自動斷句，一個呼叫從音訊到成型字幕（`auto_caption`）
- 🎤 **逐詞高亮（karaoke）** —— 逐詞變色，渲染端一詞一卡、幾何確定性，成品精準
- 📝 **所見即所得字卡** —— 字幕與文字 overlay 由同一條 Pillow 光柵管線服務預覽與匯出；CJK 感知自動換行（中文逐字折、英數照單字折、行首禁則標點）
- 🖼️ **Overlay** —— 文字或圖片，直接在畫布上拖曳，含置中／安全邊距吸附導線
- 🔊 **音訊** —— 片段抽音、旁白／BGM 軌、音量與淡入淡出、講話時自動 ducking
- 🌫️ **Blur 填充** —— 橫式素材進 9:16 畫布用模糊背景取代黑邊
- 📤 **匯出選項** —— 720p/1080p/4K、畫質（CRF）、24/30/60 fps、H.264/HEVC；字幕可選 **burn**／**embed**／**sidecar（.srt）**／**off**
- 🖼️ **封面** —— 任意時間點設封面；已有成品時直接從成片抽（所見即所得）
- 🔁 **審核閉環** —— `request_review` 暫停寫入，你在 UI 裡核可或批註，AI 讀 `get_feedback` 繼續

## 快速開始

前置需求：**Node.js 20+**、**ffmpeg**（含 ffprobe），自動字幕需要 **whisper.cpp**（選裝）。

```bash
brew install ffmpeg
brew install whisper-cpp   # 選裝——自動字幕用
# 模型放 ~/.cache/whisper.cpp/（例如 ggml-large-v3-turbo-q5_0.bin），
# 或用 VIDCUT_WHISPER_MODEL 指定路徑

git clone https://github.com/mao-data/vidcut.git
cd vidcut
npm install
npm run demo               # 建立 demo 專案並啟動 server
```

打開 **http://127.0.0.1:3845** 就能看到時間軸與即時預覽。

> ⚠️ `npm run demo` 每次都會*重新產生* `projects/demo`。要載入既有專案而不動它：
>
> ```bash
> npx tsx server/src/index.ts projects/demo
> ```

## 接上你的 AI

vidcut 講 HTTP 版 [Model Context Protocol](https://modelcontextprotocol.io)。server 跑起來之後：

**Claude Code**

```bash
claude mcp add --transport http vidcut http://127.0.0.1:3845/mcp
```

或在專案的 `.mcp.json`：

```json
{
  "mcpServers": {
    "vidcut": {
      "type": "http",
      "url": "http://127.0.0.1:3845/mcp"
    }
  }
}
```

然後直接跟你的 agent 說話：

> 「把 `~/footage/cats` 裡的素材匯進來，留最精彩的 20 秒，上自動字幕加逐詞高亮，旁白進來時把 BGM 壓低，渲染前先給我審一次。」

其他 MCP client 一樣——指向 `http://127.0.0.1:3845/mcp` 即可。

## MCP 工具

31 個工具，依用途分組：

| 分組           | 工具                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **讀取與脈絡** | `get_project` · `get_history` · `get_feedback` · `get_editor_context`（使用者當前選取與 playhead）· `get_frame`（看時刻 t 的畫面）· `list_source` |
| **素材**       | `import_media`（可直接給絕對路徑，零複製）                                                                                                        |
| **時間軸**     | `set_timeline` · `add_clip` · `update_clip` · `reorder_clips` · `remove_clip` · `timeline_op`（split / deleteBefore / deleteAfter / freeze）      |
| **字幕**       | `transcribe`（逐詞時間戳）· `auto_caption`（一步到位 ASR → 字幕）· `set_captions` · `update_caption`                                              |
| **Overlay**    | `add_overlay` · `update_overlay` · `remove_overlay` · `set_overlays`                                                                              |
| **音訊**       | `extract_audio` · `set_audio` · `update_audio` · `remove_audio`                                                                                   |
| **畫布與輸出** | `set_canvas_fit`（letterbox / blur）· `set_cover` · `render`                                                                                      |
| **歷史**       | `undo` · `redo`                                                                                                                                   |
| **人在迴路**   | `request_review`                                                                                                                                  |

server 內的工具描述是權威且永遠最新的參考文件——MCP client 會自動看到。

## 開發

```
shared/   @vidcut/shared   型別＋純函數（兩側共用）
server/   @vidcut/server   ProjectStore、命令層、ffmpeg、whisper、MCP、WS、render
ui/       @vidcut/ui       React + Vite：時間軸、A/B 播放器、Inspector、面板
```

| 指令                                    | 作用                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `npm test`                              | 全套測試——真 ffmpeg、真 whisper（不用 mock）                             |
| `npm run typecheck`                     | 三個 workspace 的 `tsc --noEmit`                                         |
| `npm run lint` / `npm run format:check` | ESLint / Prettier                                                        |
| `npm run dev:ui`                        | Vite dev server 熱重載（proxy 到 :3845）                                 |
| `npm run verify:panels`                 | 真瀏覽器回歸：面板控制項                                                 |
| `npm run verify:canvas`                 | 真瀏覽器回歸：畫布縮放／拖曳／吸附導線                                   |
| `npm run verify:wysiwyg`                | 真的 render 一支影片、截預覽畫面、比對墨跡外框——「預覽＝成品」背後的證據 |

注意：server 服務的是 `ui/dist`（build 產物）。改了 UI 原始碼要 `npm run build -w @vidcut/ui`——只有走 `dev:ui` 那條路不用。

## 已知限制

誠實優先：

- **karaoke 預覽與成品有微小差異。** 匯出的 karaoke 字幕是正確的（一詞一卡、單層直畫）。*預覽*用兩張卡疊 clip-path 合成，描邊看起來略厚（約 1% 像素有差；實際上肉眼看不出來）。非 karaoke 字幕與所有 overlay 在預覽與成品之間逐位元組相同。
- **很短的音訊（約 4 秒以下）** whisper.cpp 的逐詞時間戳本來就不可靠；vidcut 會做正規化，但精度較低。
- **單專案、單使用者、僅限 localhost** —— 目前是刻意的設計。

## Roadmap

接下來（見 [`docs/ROADMAP.md`](docs/ROADMAP.md)）：給 AI 決策用的偵測工具（`detect_silence`／`detect_scenes`／`detect_beats`）、模板化＋批次渲染、transcript 式長轉短。

## 貢獻與文件

- [`CLAUDE.md`](CLAUDE.md) —— 給 agent 看的專案規則（也是這個 codebase 所有尖銳邊角的地圖）
- [`HANDOFF.md`](HANDOFF.md) —— 目前狀態、每件事怎麼驗證、已知取捨
- [`docs/superpowers/specs/`](docs/superpowers/specs/) —— 設計定案；[`docs/superpowers/plans/`](docs/superpowers/plans/) —— 實作計畫

歡迎 issue 與 PR——見 [CONTRIBUTING.md](CONTRIBUTING.md)（貢獻需簽署一份輕量 CLA）。

## License

[AGPL-3.0-only](LICENSE)。你可以自由使用、修改與自架 vidcut；若你把修改後的版本做成網路服務對外提供，AGPL 要求你向該服務的使用者公開你修改的原始碼。
