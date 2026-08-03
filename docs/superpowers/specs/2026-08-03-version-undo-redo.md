# 版本語意修正＋游標式 undo/redo — SPEC

日期：2026-08-03。Tier 2。
授權：使用者核准（標頭版本＋進度旁路：「這部分可以」；undo 1+2＋「直接撤掉上一個
行為」的游標語意：「做1 2」）。

## 背景（已診斷）

- 標頭「demo · v149」其實是專案修訂號，被誤讀為軟體版本；且被 `render progress`
  灌爆（149 筆歷史中 73 筆是進度）、server 重啟歸零。
- undo 把「撤回」寫成新 mutation：連按 Cmd+Z 在最後一步來回擺盪、退不到更早；
  undo 對象含非編輯（進度/審核/封面），常「按了沒反應」。

## 行為

### B1 標頭顯示軟體版本

- root `package.json` 加 `"version": "0.1.0"`（單一來源）；vite `define`
  注入 `__APP_VERSION__`；標頭改 `vidcut v0.1.0 · <專案名>`，不再顯示修訂號
  （修訂號的家是 Activity）。App 對 `s.version` 的訂閱移除。

### B2 渲染進度走旁路（不再版本化）

- `render()` 不再 `mutate('render progress')`；改經 module 級 emitter
  `renderProgressBus` 發 `(progress: number)`。
- `wsHub` 訂閱並廣播新 WS 訊息 `{type:'renderProgress', progress}`（shared 型別加 variant）。
- UI：project store 加 ephemeral `renderProgress: number | null`（不入 doc）；
  ws.ts 收訊息更新；ExportMenu 進度優先讀它（running 時），done 仍讀 doc。
- 不變式：渲染一支片後，歷史**不得**出現 `render progress` 標籤；版本增量僅
  start(+1)+done(+1)。`render start/done/error` 維持版本化（真實狀態轉換）。

### B3 修訂號持久化

- 落盤格式改 `{...doc, rev: <version>}`；load 時剝離 `rev` 恢復 `#version`
  （doc 本體不含 rev）。重啟後版本從上次值續走。舊檔無 rev → 0（相容）。

### B4 游標式 undo/redo（僅編輯）

- store 增 `#undoStack` / `#redoStack`（各上限 200）。
- **可撤回的定義**：該筆 mutation 的所有 patch 根路徑 ⊆ {`tracks`,`canvas`}。
  media 匯入、render/review/cover 狀態變更不可撤回、不進堆疊、也不清 redoStack。
- `undo(source, steps=1)`：自 undoStack 逐筆 pop，各以一筆 mutation 套用
  inversePatches，label `undo: <原label>`、source 用呼叫者；pop 出的entry 進
  redoStack。空堆疊回 null。**連按 = 一路往回退**（不再擺盪）。
- `redo(source, steps=1)`：對稱反向，label `redo: <原label>`。
- 新的可撤回編輯（非 undo/redo 產生）→ 清空 redoStack（標準分叉語意）。
- undo/redo 產生的 mutation 不進 undoStack（由內部旗標隔離，不遞迴）。
- Command 層：`undo` 傳遞 source（修 AI undo 被標 human）；新增 `redo` variant
  ＋MCP `redo` 工具；UI Activity 加 Redo 鈕、App 加 Cmd+Shift+Z。
- **reviews 退回改造**：原本用 `undo(version差)` 回滾（新語意下會誤 pop 更早的
  編輯）——改用新方法 `revertSince(version)`：取歷史中 version 之後的全部
  entry，合併套用 inverse 為一筆 `review rollback` mutation。reviews 既有測試
  （rejected 回滾）必須維持通過。

## 不變式

- 既有 341 測試零新增失敗（尤其 reviews.test.ts、mcp-tools 的 undo 測試）。
- 零新依賴。WS 協定僅「新增」訊息型別（舊 client 收到未知型別已被忽略）。

## 設定計畫

- 無新工具/依賴。git 沿用 checkpoint 節奏（只 stage 本案動過的路徑，遵守
  CLAUDE.md 不 `git add -A`）。mutants 新增：undo 走錯堆疊／redo 未被新編輯
  清空／可撤回分類反轉／進度改回版本化／rev 不落盤／wsHub 不廣播進度。
- 完成後 `npm run build -w @vidcut/ui` ＋ 重啟 :3845 server（server 碼有動）。

## 已知限制

- undo 堆疊在 server 記憶體，重啟即清空（修訂號會續走，但可撤回步數歸零）——
  與市售編輯器行為一致，不落盤。
- `steps>1` 的 undo/redo 逐筆各記一筆 mutation（非合併），Activity 會看到多列。
