# HANDOFF — vidcut 開發交接

> 目前做到哪、怎麼驗、已知限制、下一步。
> 最後更新：M1–M4 + T1 全部完成（tags `m1-done`…`m4-done`、`t1-done`）。

## 現況總覽

| 里程碑         | 狀態         | 內容                                                               |
| -------------- | ------------ | ------------------------------------------------------------------ |
| M1 看得到      | ✅ `m1-done` | ProjectStore + WS 同步 + ffmpeg ingest + 唯讀時間軸 + A/B 無縫預覽 |
| M2 改得動      | ✅ `m2-done` | 命令層 + trim 拖拉 + 排序 + Inspector 編輯 + undo + 活動面板       |
| M3 AI 接上     | ✅ `m3-done` | MCP server（15 工具）+ request_review 審核閉環 + 編輯脈絡回報      |
| M4 渲染        | ✅ `m4-done` | ffmpeg 從 project.json 輸出 1080×1920 成品 + 進度 + UI 渲染鈕      |
| T1 CapCut 快贏 | ✅ `t1-done` | 見下節                                                             |

**自動化狀態全綠**：97 個測試（shared 5 / server 65 / ui 27）、typecheck 三 workspace 乾淨、ESLint 0 問題、UI 可 build。全部走真 ffmpeg 與真 MCP/WS transport 驗證過。

## T1（參考 CapCut 的快贏功能，tag `t1-done`）

依 [`docs/research/2026-07-29-capcut-gap-analysis.md`](docs/research/2026-07-29-capcut-gap-analysis.md) 的 Tier 1 全數實作：

- **粗剪主力**：S/Ctrl+B 播放頭分割、Q/W 刪除播放頭左/右（磁性軌自動閉合）、F 定格幀。
- **時間軸手感**：Ctrl+滾輪以游標為錨縮放、吸附（片段邊界/playhead/整秒，黃線指示，N 開關）、Shift+Z 全覽、工具列 ±/Fit/吸附鈕、刻度密度隨縮放調整。
- **快捷鍵**：空白播放暫停、←/→ 逐幀（Shift 加速 10 幀）、Cmd+Z 復原。**在輸入框內打字時全部停用**。
- **音訊軌完成**：片段右鍵抽出聲音（片段轉靜音）、音量/淡入淡出/ducking（播放時自動壓低影片原聲到 0.25）、渲染走 amix 並截到成片長度。
- **Canvas blur 填充**：橫素材放進 9:16 時用模糊放大填滿代替黑邊（渲染 boxblur + 預覽端獨立背景層）。
- **匯出選項**：1080/720/4K 檔位、畫質（crf 18/20/24）、fps（24/30/60）、hevc；合成一律在畫布尺寸做完才縮放，overlay/字卡不會錯位。
- **封面**：任意時間點設封面；已有成品時從成片抽（所見即所得）。
- **新 MCP 工具（共 21 個）**：`timeline_op`（split/deleteBefore/deleteAfter/freeze 四合一）、`extract_audio`、`set_audio`、`update_audio`、`set_canvas_fit`、`set_cover`，`render` 新增匯出參數。

**下一步（Tier 2 AI-native 殺手鐧）**：偵測工具組（`detect_silence`/`detect_scenes`/`detect_beats` → 回傳時間戳給 AI 決策）、whisper 逐字稿＋自動字幕＋字幕 list view、**模板化＋批次渲染**、transcript 式長轉短。優先建議：beat 偵測 + 模板化（對 ranking 片管線立刻有感）。

## 明天第一件事：親眼驗收（我驗不了「體感」與 Claude Code 實連）

我驗證了「邏輯正確、程式能跑、端到端 transport 通」，但**播放流暢度、成品觀感、Claude Code 真實連線**要你的眼睛與環境。

### A. 開起來看

```bash
cd ai-video-cut
npm run demo        # 終端機 A：建 demo + 起 server（127.0.0.1:3845，MCP 在 /mcp）
npm run dev:ui      # 終端機 B：http://localhost:5173
```

驗收（重點在體感）：

1. 時間軸 5 clip（縮圖 + 波形；No.3 無音軌 → 平線），按 ▶ **切換有無黑幀/停頓**（M1 最關鍵）。
2. 拖 clip 左右邊緣 trim、拖 clip 本體換順序、點 clip 在左欄改屬性、Cmd+Z 復原、右欄活動記錄。
3. 底部「🎬 渲染成品」→ 進度條 → 完成後「開啟成品」連結播放，確認畫面/音訊/overlay。
   （字幕不會燒進成品——見下方限制。）

### B. 接 Claude Code（M3 的重點價值）

```bash
# server 要開著（npm run demo 或 npm run dev:server -- projects/demo）
claude mcp add --transport http vidcut http://127.0.0.1:3845/mcp
```

然後在 Claude Code 裡對它說「用 vidcut 讀專案、把第 3 段縮短一秒、然後 request_review」。
你會在瀏覽器 UI 看到變更即時發生、頂部跳出審核條，按核准後 AI 那邊的 `request_review` 就回傳。
（我用 in-process client 與真 HTTP client 都驗過這條迴路，但沒有你的 Claude Code 環境，這步請親測。）

## 環境限制與字幕（已解決）

**本機 Homebrew ffmpeg 8.1.2 是精簡 bottle，沒有 `drawtext`／`libfreetype`／`libass`**（formula 本身不宣告 freetype 依賴，`brew reinstall` 也救不了；只有 drawbox/overlay/colorize）。

**字幕已用 PNG 字卡路徑解決**（2026-07-29）：render 時 runtime 偵測 drawtext——

- 有 drawtext → 原生 `drawtext` 燒字。
- 無 drawtext（本機）→ 用 **Pillow 把每條 caption 畫成透明 PNG 字卡**（`server/scripts/text_card.py`，CJK 字型 fallback），再用既有 `overlay` 濾鏡按時間合成。已端到端驗證：純黑底上字幕開啟時有字、關閉時無字、時間正確。`render` 回 `captionsBurned:true`。

需要 `pip3 install pillow`（已裝，12.3.0）。哪天換成含 freetype 的 ffmpeg，會自動改走原生 drawtext，不用改碼。重度文字（排名標題、迷因標籤）仍走 overlay PNG（與 `make_overlays.py` 一致），這條本來就正常。

## 已知取捨（非 bug）

- `undo` 為逐步 undo，「撤 undo = redo」是簡化；要正式 redo stack 之後再擴。
- request_review 用「阻塞 + UI 核准 + 保活 + 逾時」；**elicitation URL mode**（Claude Code 直接彈瀏覽器審核頁）列為後續增強——因無法自動驗證故未做，可用 v2 SDK `@modelcontextprotocol/server` + codemod 遷移時一起上。
- 退回（reject）目前回滾「review 開啟後的全部變更」到 sinceVersion；若人在審核期間也改了東西會一起被回滾（reject = 丟掉這一輪）。
- 播放/渲染字級換算：預覽用 `fontSize/3` 粗估，未與渲染逐像素對齊。
- Safari 未測（開發用 Chrome）。
- MCP 用 v1 SDK 1.30.0（穩定）；v2（2.0.0）功能更多但兩天前才發，之後可用官方 codemod 升級。

## 架構與程式碼地圖

單一 Node 程序（`server/`）綁 `127.0.0.1:3845`，一 port 服務：靜態 UI、`/media/*`（Range）、`/mcp`（MCP Streamable HTTP）、`/ws`（狀態同步）。專案狀態 = `project.json`，**所有變更走 `ProjectStore.mutate()` 單一路徑**。

```
shared/src/types.ts       全部型別（spec §3）+ Command/WS 協議
shared/src/timeline.ts    純時間軸計算（locate/overlayWindow…）
server/src/store.ts       ProjectStore：唯一真相來源、immer patch、history、undo、原子存檔
server/src/commands.ts    applyCommand：人機共用的驗證過的編輯命令層 ★
server/src/aiWrite.ts     AI 寫入守衛（審核中擋 + ifVersion 過期偵測）→ commands
server/src/reviews.ts     ReviewManager：request_review 的核心（阻塞/核准/退回回滾/逾時）
server/src/editorContext.ts 人的選取/playhead（給 get_editor_context）
server/src/mcp.ts         21 個 MCP 工具 + /mcp 掛載 ★
server/src/ingest.ts      proxy/filmstrip/peaks 產生（spec §8.1）
server/src/render.ts      project.json → ffmpeg filter_complex 成品 + blur/定格/音訊混音/匯出選項/封面 ★
server/scripts/text_card.py  文字 → 透明 PNG 字卡（Pillow）
server/src/ffmpeg.ts      runFfmpeg/probe
server/src/frame.ts       抽幀給 AI「看」
server/src/wsHub.ts       WS：full/patch/command/context/reviewResolve/render
server/src/index.ts       startServer + CLI
ui/src/stores/            project（patch 套用）/ playback / selection / view（縮放吸附）/ activity / toast
ui/src/ws.ts              WS client：命令/脈絡/審核/渲染 送出 + 重連
ui/src/player/            planAt（純函數大腦）+ Player（A/B 引擎）
ui/src/timeline/          scale + dragMath（純函數）+ Timeline（trim/排序/選取/縮放/吸附）
ui/src/panels/            Inspector / Activity / ReviewBar / RenderBar
```

★ = 改動時最常碰、最核心的檔案。

**改動鐵則**：任何專案狀態變更都走 `applyCommand`（人）或 `aiWrite`→`applyCommand`（AI）；不要旁路直改 doc。要加新編輯操作 = 在 `shared` 的 `Command` 加一個 variant + `commands.ts` 加驗證 + case，UI 與 MCP 自動都能用（DRY 的關鍵）。

## 開發指令

```bash
npm test          # 全部（含真 ffmpeg，約 15 秒）
npm run typecheck # 三 workspace tsc
npm run lint      # ESLint（目前 0 問題）
npm run format    # Prettier 寫入
npm run demo      # 建 demo + 起 server
npm run dev:ui    # Vite dev（proxy 到 :3845）
```

## 下一步建議（依價值排序）

1. **親驗播放體感 + Claude Code 實連**（上面 A、B）。有問題記錄現象給我。
2. **Tier 2 AI-native 殺手鐧**（見 gap analysis）：優先 **beat 偵測**（切點對拍，質感立刻上檔次）與 **模板化 + 批次渲染**（ranking 片變成換素材就好）。
3. **skill 整合**：把 `ranking-video-generator` 步驟 3–5 尾段改走 vidcut（import_media → set_timeline → set_overlays → request_review → render）；掃描/峰值/選段不動。詳見 `docs/superpowers/plans/2026-07-29-vidcut-m4.md` 末節。
4. 其他增強：whisper 逐字稿＋自動字幕、**elicitation URL mode**、多分頁綁定（Vyra 式 Connect MCP）。

設計與計畫全文：`docs/superpowers/specs/` 與 `docs/superpowers/plans/`。
