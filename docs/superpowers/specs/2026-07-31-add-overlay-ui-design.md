# 手動新增／編輯疊圖（overlay）

> **歷史文件（2026-07-31 的設計定案）**：記錄當時的決策與理由，**不隨程式碼更新**。
> 現況以 `CLAUDE.md`／`HANDOFF.md` 為準。

2026-07-31 使用者核准（「title 要換」情境：加、調、刪都不需經 AI）。

## 行為

- **新增**：時間軸工具列「➕ 疊圖」→ 選圖檔（image/*）→ POST 上傳存進專案 `assets/`
  →（檔名淨化、重名自動編號）→ `addOverlay`：start=playhead、duration=3s、
  position={x:0.5, y:0.1, scale:1} → 自動選取
- **編輯**：Inspector overlay 區補「開始時間」「長度」欄位＋「到片尾」checkbox
  （勾＝duration:null、右緣釘片尾）＋「刪除疊圖」鈕
- 時間拖曳沿用上一功能（絕對式平移 start；錨定式改 offset）

## 命令層

- `addOverlay { overlay: OverlayItem }`：驗證 duration（>0 或 null）、anchor clipId 存在、
  start/anchor 至少有一；append 到 overlays
- `removeOverlay { id }`：不存在回錯
- MCP 不加新工具（AI 用 set_overlays 已足夠；command 層本來就雙方共用）

## 上傳端點

`POST /assets?name=<filename>`（binary body，20MB 上限）→ 寫入 `projectDir/assets/`，
回 `{ relPath }`。檔名去除路徑成分（防 traversal）；重名 `name-1.png` 遞增。
僅綁 127.0.0.1（既有安全模型不變）。

## 驗收

命令層測試（add 驗證/append、remove）；上傳端點測試（寫檔、traversal 防護、重名）；
全綠＋lint/typecheck/build；UI 操作由使用者驗。
