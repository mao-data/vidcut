# vidcut UI 重設計（視覺系統 × 版面微調 × 動效）

2026-07-30。經 brainstorming（含瀏覽器 mockup 比選）定案；mockup 存於
`.superpowers/brainstorm/42534-1785406672/content/`（gitignored，僅本機參考）。

## 背景與問題

現況是「工程師驗證功能用」的 UI，從未被設計過：

- 87 個 inline `style={{}}`、零 CSS 檔、25+ 個無系統色碼（playhead 是 `red`、吸附線 `#ff0`）
- 原生瀏覽器 button/select/input 直接裸用（macOS 淺色控件配深底特別突兀）
- 唯一結構是到處 1px `#333` 邊框；無 hover/focus 狀態；圖示是 emoji
- 波形：50 桶/秒、單層 max、非 DPR canvas（Retina 模糊）
- 除拖曳讓位外零動效

## 使用者已確認的方向（依序比選過）

| 決策     | 選擇                                                | 備註                                 |
| -------- | --------------------------------------------------- | ------------------------------------ |
| 範圍     | 換皮＋動效＋版面一起調                              | 但版面比選後選了保守案               |
| 視覺方向 | **C · 現代 web 工具**（Linear/Descript 系）         | 深藍紫底、玻璃面板、紫漸層強調、光暈 |
| 波形位置 | **片段下緣波形帶**（上 60% filmstrip、下 40% 波形） | CapCut 同款；定格幀顯示平線          |
| 波形畫法 | **峰值＋RMS 雙層**（外淡紫峰值、內亮紫 RMS）        | DAW 級；一眼分辨講話 vs 瞬態         |
| 版面     | **保守優化**：現有骨架微調                          | 詳見 §2                              |

## 目標

打開 vidcut 看起來像一個 2026 年的產品，而非工程原型；同時「AI 在動、人在看」
的核心體驗（活動可見、審核攔截、即時同步）不被削弱。

## 非目標（明確不碰）

- server／命令層／MCP 的任何行為
- 播放引擎（A/B 雙 video 排程）與拖曳數學（`dragMath.ts`）
- 版面骨架大改（單側欄、CapCut 鏡像案已否決）
- Tailwind 或 CSS-in-JS 框架（用純 CSS 變數即可）

## 1 · 設計系統：`ui/src/theme.css`

單一 CSS 檔＋design token（CSS 自訂屬性），class 為主、inline 只留動態值
（位置、寬度、進度）。token：

```
背景層級   --bg:#0d0e16   面板玻璃 --surface:rgba(255,255,255,.04~.08)（漸層 #151726→#12131d 打底）
           卡片 --card:#272d49   邊線 --line:rgba(255,255,255,.08~.14)
文字       --text-1:#e6e7f0  --text-2:#9ba0b8  --text-3:#5d6275
強調       --accent:#8b5cf6  漸層 #8b5cf6→#6366f1  --accent-soft:rgba(139,92,246,.2)
語意       音訊 #0ea5e9/#7dd3fc（青）  成功 #34d399  危險 #f87171  字幕高亮 #fbbf24
           活動來源：AI=紫系、人=青系
圓角       面板 10px、卡片/片段 9px、控件 6–8px
字體       系統字疊（-apple-system, PingFang TC…）；時間碼一律 font-variant-numeric: tabular-nums
尺寸       字級 11/12/13/15；間距 4 的倍數
```

控件：button（主=紫漸層、次=玻璃、危險=紅）、select、input、range 全自訂：
hover 提亮＋微上移、focus 紫色 ring、disabled 降透明。捲軸細版深色。

圖示：**lucide-react** 全面取代 emoji（✂→`Scissors`、❄→`Snowflake`、
🔊→`AudioWaveform`、🎬→`Clapperboard`、🧲→`Magnet`、↶→`Undo2`…）。

## 2 · 版面（保守案）

骨架不動（屬性左・預覽中・右欄・時間軸底）。變更：

- **右欄 → 「字幕 ⇄ 活動」分頁**（字幕預設；tab 上顯示數量 badge）
- **RenderBar 刪除**：匯出主按鈕（含解析度/畫質/fps 的 preset 下拉）＋渲染進度條移到頂欄右側；完成後顯示「開啟成品」連結；封面鈕併入下拉
- **播放控制（⏮ ▶ ⏭）＋時間碼** 從預覽下方移進時間軸工具列左側
- **審核條**：不常駐。AI request_review 時從頂部滑入（overlay，不擠壓版面）
- **左右面板可收合**（⟨⟩ 鈕），收合狀態記在 view store（不持久化）
- Inspector 的快捷鍵表收進「?」彈出層，省高度

## 3 · 時間軸重繪

- 片段：圓角 9px、上 60% filmstrip、下 40% 波形帶（半透明黑底）
- 波形資料：ingest 的 peaks 升級 **100 桶/秒**（`PEAK_SAMPLES_PER_BUCKET` 160→80），
  並**新增每桶 RMS 陣列**。peaks JSON 變成 `{sampleRate, samplesPerBucket, peaks, rms}`。
  **舊專案沒有 `rms` → 自動退回單層包絡**，不重跑 ingest 也不壞
- 波形繪製：鏡像包絡（上下對稱＋中線）、峰值層 `rgba(167,139,250,.30)`＋
  RMS 層 `rgba(196,181,253,.85)`；canvas 按 `devicePixelRatio` 繪製
- 選取＝紫描邊＋外光暈；定格幀＝平線＋Snowflake badge；靜音片段波形降透明
- 音訊軌：青色系全高 RMS 波形（`#0ea5e9` 底、`#7dd3fc` 核心）
- playhead：紫漸層 2px＋光暈＋圓形頭；吸附指示線改紫；刻度 `tabular-nums`

## 4 · 動效（GSAP）

依賴：`gsap` + `@gsap/react`（`useGSAP`，均免費商用）。原則：
**事件性動作用 GSAP、微互動用 CSS transition**、`prefers-reduced-motion` 全域尊重
（`gsap.matchMedia`）。清單：

| 對象                | 動效                           |
| ------------------- | ------------------------------ |
| 審核條              | 從頂部彈性滑入/收合（overlay） |
| 右欄分頁切換        | 內容 fade+8px slide            |
| 面板收合/展開       | 寬度 tween＋內容 fade          |
| toast               | 進出場（下緣浮起）             |
| 渲染完成            | 匯出鈕 pulse 一次＋進度條收尾  |
| 字幕列表當前句      | 高亮背景平滑移動               |
| hover/按鈕/選取描邊 | 純 CSS transition              |
| 既有拖曳讓位動畫    | 不動（已驗收）                 |

## 5 · 資料與相容

- peaks JSON 目前沒有共用型別（ingest 產出、`Timeline.tsx` 自己宣告本地 interface）。
  藉這次在 `shared` 新增 `PeaksFile` 型別（`{sampleRate, samplesPerBucket, peaks, rms?}`），
  ingest 與 UI 兩端共用；`rms` optional → 舊檔相容
- ingest 重算邏輯加測試（峰值/RMS 數值正確、桶數正確）
- demo 專案重建即得新波形；使用者既有專案不強制重 ingest

## 6 · 驗收

- 現有 143 測試全過；ingest 新測試過；typecheck/lint/build 乾淨
- 視覺以 dev server 實看為準（Vite HMR），最終由使用者驗收「打開像個產品」
- 行為零迴歸：拖曳、審核閉環、渲染、字幕編輯操作全部照舊

## 7 · 風險

| 風險                          | 緩解                                                       |
| ----------------------------- | ---------------------------------------------------------- |
| 一次改太多視覺難定位迴歸      | 分層 commit：theme.css＋控件 → 版面 → 時間軸 → 動效        |
| GSAP 與 React 生命週期洩漏    | 一律 `useGSAP`（自動 cleanup），不手寫 `gsap.to` in effect |
| 玻璃感（半透明+blur）效能     | 只用在頂欄/面板底，不用在每個片段；時間軸維持不透明色      |
| lucide 圖示尺寸與中文行高不齊 | 統一 16px、`vertical-align:-2px` 基準                      |
