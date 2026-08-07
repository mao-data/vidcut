# vidcut

AI 原生的直式短影音時間軸編輯器（1080×1920）：AI 走 MCP 剪片、人在瀏覽器 UI 監修。
本檔與 `HANDOFF.md` 是這個 repo 的權威來源，**優先於訓練知識**；有疑問先搜這個 repo。

## 架構要點

單一 Node 程序在 **:3845** 同時服務靜態 UI、`/media`、`/mcp`、`/ws` —— 沒有分離的前後端伺服器。
Server 服務的是 **`ui/dist`（build 產物）**，不是 Vite dev server。

```
shared/   @vidcut/shared  型別 + 純函數（server/ui 共用）
server/   @vidcut/server  ProjectStore、命令層、ffmpeg、whisper、MCP、WS、render
ui/       @vidcut/ui      React + Vite：時間軸、A/B 播放器、Inspector、面板
```

## 指令

```bash
npx tsx server/src/index.ts projects/demo   # 起 server，載入既有專案
npm run demo                                # ⚠️ 會「重新產生」projects/demo，覆蓋既有內容
npm run dev:ui                              # UI 熱重載（另開終端機；port 不保證 5173，以 vite 啟動訊息為準，只綁 IPv6 localhost）
npm test                                    # 全部（真 ffmpeg + 真 whisper；機器空閒時約 70 秒）
npm run typecheck                           # 三 workspace tsc
npm run lint && npm run format:check        # 應乾淨；紅的都是真問題，不要當雜訊放過（format 用 npm run format 修）
npm run verify:panels                       # 真瀏覽器回歸：面板控制項（需 server 在跑 + ui/dist 最新）
npm run verify:canvas                       # 真瀏覽器回歸：畫布縮放/拖曳/吸附（同上；會寫回 projects/demo）
npm run verify:wysiwyg                      # 真 render vs 預覽截圖比對（自起臨時 server，不碰 demo；需 python3/Pillow）
bash scripts/gauntlet.sh                    # 全層驗證一條龍；當下數字以它為準
```

- **改完 UI 原始碼必須 `npm run build -w @vidcut/ui`**，否則 :3845 上跑的還是舊版。
  只有 `npm run dev:ui` 那條路不用 build。
- **不要用 `npm run demo` 當 verify 腳本的前置**——它會重建 demo 專案。
- verify 腳本各自的前提、環境變數（`VIDCUT_VIEWPORT`/`CHROME_BIN`/`VIDCUT_WYSIWYG_PORT`…）
  與所有瀏覽器量測陷阱，見 `.claude/rules/ui-verification.md`。

## 「預覽即成品」的實際範圍（別當全域保證用）

**非 karaoke 字幕與 overlay（含文字 overlay）成立**：字幕輸出 PNG 逐位元組相同，
overlay 由 `npm run verify:wysiwyg` 守著（六項全綠，最大差 1.1px）。
**karaoke 字幕預覽略有偏差（描邊看起來略厚），但匯出成品是正確的**——寫文件或對外
描述一律帶限定詞，也不要跑去修那個不存在的匯出 bug。
完整範圍、成因、實測數字與字卡管線（自動換行、像素預算、幾何 schema 演進）見
`.claude/rules/wysiwyg.md`。

## 鐵則

- **任何專案狀態變更都走 `applyCommand`**（人）或 `aiWrite`→`applyCommand`（AI）。
  不要旁路直改 doc。新增一種編輯操作是**三步，第三步不會自動發生**：
  1. `shared/src/types.ts` 的 `Command` 加 variant
  2. `commands.ts` 加驗證與 case（驗證一律寫在這層，不要寫在 MCP 或 UI）
  3. **`mcp.ts` 手動 `registerTool` 並同步 `instructions`** —— 漏了第三步，
     AI 就永遠碰不到這個能力（前例：`addClip` 做完八輪 TDD 卻沒人能用，
     因為只做了 1、2 步）
- **`projects/*/.env` 與各專案密鑰不得提交或印出內容。**
- **改了工具行為或語意，必須同步更新 `server/src/mcp.ts` 的工具描述與 instructions。**
  MCP 描述是 AI 使用者唯一的文件，過期描述會直接害它踩坑
  （前例：get_frame 描述殘留 roadmap 字句，AI 因此誤判 overlay 沒設定成功）。

## Git

- 這個 repo 有自己的 `.git`（GitHub `mao-data/vidcut`），在專案目錄內執行 git。
- **不要 `git add -A`**：這個工作區常有多個 session 同時進行，全加會把別人改到一半的
  檔案掃進你的 commit。只 stage 你自己動過的路徑。
- 除非使用者要求，不要自行 commit 或 push。

## 交叉參考

- `HANDOFF.md` —— 先讀這份，含各檔案職責與已完成/未驗證的分界
- `docs/ROADMAP.md` —— 上線計劃與可行方向
- `docs/superpowers/specs/` —— 設計定案；`docs/superpowers/plans/` —— 實作計畫
- `.claude/rules/wysiwyg.md`、`.claude/rules/ui-verification.md` —— 檔案範圍限定的
  深度規則（帶 `paths:` frontmatter，動到相關檔案時才載入）
