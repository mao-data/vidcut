# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

主要目標使用者是**短影音創作者**：已經在用（或願意用）Claude Code 等 MCP client 的人，想把粗剪、上字幕、混音這類苦工交給 AI，自己保留審美與最終裁量權。**開發者／AI 工具鏈玩家是刻意經營的早期採用者**——他們會接 MCP、回報問題、貢獻 PR，是通往創作者市場的橋。

使用情境：在自己的機器上（macOS / Linux；Windows 走 WSL）跑本機 server，一邊跟 AI agent 對話、一邊在瀏覽器 UI 監修時間軸。素材是私人的、留在本機。

## Product Purpose

vidcut 是**本機優先的直式短影音（1080×1920）時間軸編輯器**，核心理念：**AI 跟人共用同一條時間軸、同時編輯**。AI 透過 31 個 MCP 工具剪片（匯入、粗剪、字幕、overlay、混音、輸出），每步變更經 WebSocket 即時出現在瀏覽器；人拖一下字幕、修一刀 trim、留一句審核意見，AI 讀回並繼續。它*不是* prompt 生影片的產生器，而是人在迴路中的剪輯協作。

成功定義（使用者確認）：**open-core 商業化**——開源版（AGPL）建立信任與採用，vidcut-pro（cloud 商業線）是營收來源。

## Positioning

鄰近產品無法照抄的主張：

- **AI 原生、非 AI 附加**：AI 是一等公民編輯者，走與人相同的序列化命令路徑（`applyCommand`），不是掛在傳統 NLE 旁的 copilot 面板。
- **人在迴路的審核閉環**：`request_review` 暫停寫入 → 人在 UI 核可或批註 → AI 讀 `get_feedback` 繼續。
- **字幕／overlay 所見即所得**：預覽與成品用同一張光柵化字卡（PNG 逐位元組相同），由像素級回歸測試（`verify:wysiwyg`）守著。
- **本機且私密**：單一 Node 程序綁 `127.0.0.1:3845`，素材零複製引用、不出使用者的機器。
- **CJK 字幕能力**：CJK 感知自動換行（中文逐字折、行首禁則標點）、whisper 逐詞 karaoke 高亮——對華語創作者是實質差異化。

## Operating Context

- 單一 Node 程序服務四種流量：靜態 UI（`ui/dist` build 產物）、`/media`、`/mcp`、`/ws`；`project.json` 是唯一真相來源。
- 使用者的工作流是「對 agent 說話 + 在瀏覽器監修」雙螢幕式協作；素材匯入目前只走 AI（`import_media`），UI 的 Media 面板在 roadmap 上。
- 依賴真 ffmpeg、Python 3 + Pillow（字卡光柵化必要）、whisper.cpp（選裝，自動字幕用）。
- 開源線與商業線共用一個 `.git`、兩個 remote（origin=AGPL / pro=專有），方向只允許 main → cloud-p0；`.githooks/pre-push` 是守門。

## Capabilities and Constraints

已確認功能（詳見 `README.md`／`README.zh-TW.md`）：時間軸剪輯（split／trim／排序／定格／undo-redo）、A/B 無縫預覽、whisper 自動字幕與逐詞 karaoke、WYSIWYG 字卡、文字／圖片 overlay、音訊軌（抽音／旁白／BGM／ducking）、blur 填充、多格式匯出（burn/embed/sidecar/off 字幕）、封面、審核閉環、AI 編輯動畫回饋層。

刻意的設計限制：

- **單專案、單使用者、僅 localhost**（目前刻意如此；多人與 cloud 屬 pro 線）。
- 畫布固定 1080×1920 直式。
- karaoke 字幕**預覽**描邊略厚，**匯出成品正確**——對外描述一律帶限定詞，不要去修不存在的匯出 bug。
- Windows 未測試（字卡管線 spawn `python3`），走 WSL。

術語：clip／caption（字幕，有 SRT 匯出與 karaoke）與 overlay（畫面文字卡，無 SRT）是不同概念；素材是「零複製引用」不是複製匯入。

未決的產品事實：UI 手動新增字幕的需求細節（時長、拆/合、入口位置，見 `docs/ROADMAP.md` 第 6 項）；`addToTimeline` 匯入純音訊的分流（`addAudio` command，待產品決策）。

## Brand Commitments

- 名稱 **vidcut**（小寫）；GitHub `mao-data/vidcut`（AGPL-3.0-only）／`mao-data/vidcut-pro`（永久 private）。
- **語言策略（使用者確認）：英文為主、繁中並行**——國際市場優先，UI 文案英文；README 等文件維持雙語。
- 聲音／個性：**誠實優先**（README 有「已知限制」節、EVIDENCE.md 逐項綁 commit 記錄驗證數字；對外宣稱一律可查證、帶限定詞）。
- 既有資產：`docs/assets/hero.png`（README hero 圖）。

## Evidence on Hand

- `EVIDENCE.md`：全功能驗證記錄——數百條測試、手動突變測試（全滅）、真實渲染執行記錄，逐節綁 commit SHA；`bash scripts/gauntlet.sh` 可一鍵重跑。
- `npm run verify:wysiwyg`：「預覽＝成品」的像素級證據（六個 case）。
- `npm run demo` 自帶合成素材的可玩 demo（不需自備素材）。
- **沒有的東西（未來工作不得虛構）**：使用者見證／testimonials、採用數字、star 數、定價、pro 版功能清單與上線日期。

## Product Principles

1. **人監修、AI 代勞**——每個新能力都要同時可被人（UI）與 AI（MCP）觸達；審核閉環是信任的基礎，不是可選配件。
2. **誠實優先**——對外每句宣稱都可查證；限制寫在明處（README「已知限制」是產品的一部分）。
3. **本機與隱私是承諾**——開源版的素材與專案不出使用者機器；cloud 能力屬 pro 線，不模糊這條界線。
4. **預覽即成品**——WYSIWYG 是以測試守住的性質，任何新功能不得破壞它（動畫、字卡改動都要過 `verify:wysiwyg` 這關）。
5. **開源版是完整產品，不是 demo**——open-core 的信任來自開源版真的能用；pro 賣的是 cloud／協作，不是把基本功能鎖起來。

## Accessibility & Inclusion

- 已有全域 `prefers-reduced-motion` 支援（AI 編輯動畫層退化為瞬切）。
- CJK 使用者是明確服務對象：字卡管線的 CJK 換行、Noto CJK 字型 fallback 鏈是產品要求，不是 nice-to-have。
