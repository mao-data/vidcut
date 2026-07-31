# 左右面板拖曳伸縮

2026-07-30 使用者核准。小型功能，spec 即當時呈現的設計原文。

## 行為

- 左右面板與中欄交界各一條 6px 隱形熱區：hover 亮細紫線、游標 `col-resize`，拖曳改寬度
- 範圍：左 200–420px、右 240–500px；拖到 **<140px 直接收合**（⟨⟩ 收合鈕保留並存）
- 雙擊把手＝回預設寬（左 260 / 右 320）
- 寬度存 view store＋**localStorage**（跨 session 記住）；收合狀態維持不持久化
- 拖曳中停用 grid 的 0.25s 過渡（避免黏手），放開恢復；pointer capture（與時間軸 trim 同模式）

## 實作

- `ui/src/timeline/../stores/view.ts`：`leftWidth/rightWidth` + setter（含 clamp 與 localStorage 讀寫）
- `ui/src/panelResize.ts`：純函式 `resolvePanelDrag(side, rawPx)` → `{ open, width? }`（可測：clamp、收合門檻）
- `ui/src/PanelResizer.tsx`：把手元件（雙擊 reset、拖曳中回報 resizing 給 App 關過渡）
- `App.tsx`：grid 欄寬改讀 store；內層固定寬同步
- 不碰：面板內容元件、時間軸、server

## 驗收

純函式測試（clamp/門檻）＋現有測試全綠＋typecheck/lint/build 乾淨＋截圖確認版面無迴歸；拖曳手感由使用者驗。
