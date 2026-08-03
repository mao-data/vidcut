# MCP 層優化（五項）— SPEC

日期：2026-08-02。範圍：`server/src/mcp.ts`（＋必要的測試檔）。
授權：使用者核准了優化清單（「好 用/old-coder把優化都做」）；細部規格為自主撰寫，
以本文件作事後審閱之依據。Tier 2（一般功能，無金流/資安/併發面）。

## 背景

Claude Desktop 走 `mcp-remote` 橋接已可連上 vidcut，但：
1. `get_frame`/`set_cover` 只回本機 URL——Desktop 的模型抓不到 `127.0.0.1`，AI 等於沒有眼睛。
2. 應用層錯誤（stale ifVersion、review 進行中…）回一般文字，未標 `isError`，模型難以辨識失敗。
3. 字幕/overlay 只有整組替換工具；命令層其實已有細粒度命令（`updateCaption` 等）卻未曝光。
4. 讀取類工具沒標 `readOnlyHint`，client 權限 UX 較差。
5. `transcribe` 把全量 words 塞進 structuredContent，長影片會炸 token。

## 行為（每條映射到測試）

### B1 get_frame 回傳影像 content block
- 成功時 `content` 含 `{type:'image', mimeType:'image/jpeg', data:<base64>}`，
  base64 解碼後前兩 byte 為 JPEG magic（0xFF 0xD8）；同時保留文字摘要與
  `structuredContent.url/path`（Claude Code 等本機 client 仍可用路徑）。
- 該時間無 active 片段 → 文字錯誤 + `isError: true`（併入 B3）。

### B2 set_cover 回傳影像 content block
- 同 B1（讀 `output/cover.jpg`）；失敗（空時間軸）→ `isError: true`。

### B3 應用層錯誤標 isError
- 所有經 `aiWrite` 的工具失敗時（stale ifVersion、review 進行中、id 不存在、越界）
  → 結果 `isError === true`，錯誤文字不變。
- `set_timeline` 的三種手寫錯誤路徑（review 中／stale／unknown mediaId、越界）同上。
- `import_media`、`render`、`set_cover` 的 catch 路徑同上。
- 成功路徑 `isError` 不得為 true。
- 不變式：既有測試中對錯誤「文字內容」的斷言全部維持通過（只加 flag，不改訊息）。

### B4 細粒度編輯工具（曝光既有命令層命令，全部支援 ifVersion）
- `update_caption(id, patch{text?,start?,duration?,style?,tokens?}, ifVersion?)`
  — 只改指定字幕；`tokens: []` 清除逐詞時間戳（命令層既有語意）；
  `style` 提供時整組替換（與命令層一致）。
- `update_overlay(id, patch{start?,anchor?,duration?,position?}, ifVersion?)`
- `add_overlay(overlay, ifVersion?)`、`remove_overlay(id, ifVersion?)`、`remove_audio(id, ifVersion?)`
- id 不存在 → 命令層錯誤，`isError: true`；其他軌道項目不受影響。
- stale `ifVersion` → 被 aiWrite 擋下（以 update_caption 驗一次代表五工具共用路徑）。

### B5 讀取類工具標 readOnlyHint
- `tools/list` 中 `get_project`、`get_history`、`get_feedback`、`get_editor_context`、
  `get_frame`、`transcribe` 的 `annotations.readOnlyHint === true`。
  （get_frame/transcribe 只寫 derived/ 快取檔，不動 project.json——EVIDENCE 註記。）
- 寫入類工具（`update_clip`、`set_captions`、`render` 等）不得標 `readOnlyHint: true`。

### B6 transcribe 長逐字稿截斷
- `words.length > 1000` 時：`structuredContent.words` 只含前 1000 詞、
  `wordsTruncated: true`、`wordCount` 仍為總數、`jsonPath` 照舊（全量在檔案裡）。
- `words.length ≤ 1000`：全量回傳、`wordsTruncated` 為 false 或缺席。
- `auto_caption` 不受影響（它回 captions，不回 words）。
- 測試以 mock `./asr.js` 邊界（whisper 為外部程序，屬合法 mock 邊界）。

## 不變式
- 既有 313 測試（shared 27 / server 128+ / ui 157）零新增失敗。
- 不新增任何依賴。不改 UI、不改命令層、不改渲染。
- `instructions` 更新提到細粒度工具（小修用 update_caption，別整組重送）。

## 設定計畫
- 無新工具、無新依賴。測試新增 `server/test/mcp-optim.test.ts`。
- git：沿用既有 checkpoint 節奏（SPEC → 各 GREEN → EVIDENCE），推 GitHub。
- `scripts/mutants.json` 新增本功能突變（isError 旗標、截斷、ifVersion 佈線、
  readOnlyHint、JPEG 回傳），gauntlet 全跑。

## 已知限制（不做）
- 影像 block 不做尺寸上限控制（proxy 幀 q3 約數十～兩百 KB，可接受）；
  超大來源若成問題再議。
- 不做 `update_clip` 以外的 video 軌細粒度新工具（已存在）。
- transcribe 截斷閾值 1000 為工程判斷值，未做成參數。
