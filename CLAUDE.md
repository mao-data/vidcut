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
npm test                                    # 全部（真 ffmpeg + 真 whisper；某次實測機器空閒時約 70 秒，未重驗）
npm run typecheck                           # 三 workspace tsc
npm run lint && npm run format:check        # 應乾淨；紅的都是真問題，不要當雜訊放過（format 用 npm run format 修）
npm run verify:panels                       # 真瀏覽器回歸：面板控制項（需 server 在跑 + ui/dist 最新）
npm run verify:canvas                       # 真瀏覽器回歸：畫布縮放/拖曳/吸附（同上；會寫回 projects/demo）
npm run verify:wysiwyg                      # 真 render vs 預覽截圖比對（自起臨時 server，不碰 demo；需 python3/Pillow）
bash scripts/gauntlet.sh                    # 全層驗證一條龍；當下數字以它為準
```

- **`gauntlet.sh` 跑的時候不要 commit。** 突變測試那層會照著 `scripts/mutants.json`
  把產品原始碼**故意改壞**、跑完該隻再還原，所以那十幾分鐘裡工作樹是會抖動的：
  `git status` 會冒出你沒動過的檔案（實例：`ui/src/player/plan.ts`，被 `player-fade`
  三隻 mutant 輪流改）。剛好卡在還沒還原時 commit，就會把一段刻意寫壞的程式碼提交
  進去，而且當下測試是紅的、你未必會注意。等 `GAUNTLET: 全數通過` 印出來再 commit。
- **改完 UI 原始碼必須 `npm run build -w @vidcut/ui`**，否則 :3845 上跑的還是舊版。
  只有 `npm run dev:ui` 那條路不用 build。
- **不要用 `npm run demo` 當 verify 腳本的前置**——它會重建 demo 專案。
- verify 腳本各自的前提、環境變數（`VIDCUT_VIEWPORT`/`CHROME_BIN`/`VIDCUT_WYSIWYG_PORT`…）
  與所有瀏覽器量測陷阱，見 `.claude/rules/ui-verification.md`。

## 「預覽即成品」的實際範圍（別當全域保證用）

**非 karaoke 字幕與 overlay（含文字 overlay）成立**：字幕輸出 PNG 逐位元組相同，
overlay 由 `npm run verify:wysiwyg` 守著（六個 case 全綠；最大差 1.1px 是某次實測，未重驗）。
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

### open-core 邊界（動 git 之前先讀這段）

這份 `.git` 同時連著兩個 remote，是**兩條授權不同的線**：

| remote   | repo                                  | 授權          | 內容                                    |
| -------- | ------------------------------------- | ------------- | --------------------------------------- |
| `origin` | `mao-data/vidcut`                     | AGPL-3.0-only | 開源線。`main`、`caption-wysiwyg`       |
| `pro`    | `mao-data/vidcut-pro`（永久 private） | 專有          | 商業線。`cloud-p0` 與 `cloud/` 底下全部 |

- **絕對不要把商業線併進開源線。** 合法方向只有 `main → cloud-p0`（商業線吸收開源
  改動）。反向一次就完了：push 完成的那一刻物件就進了 GitHub 的物件庫，force-push
  只是移動 ref，物件仍能用 SHA 直接取回，fork network 還共享物件庫——**發現得再快
  也救不回來**。這是這個 repo 唯一不可逆的失誤。
- 守門是 `.githooks/pre-push`（三層 fail-closed：祖先哨兵／內容檢查／名字白名單），
  由 `package.json` 的 `prepare` 在 `npm install` 時用 `core.hooksPath` 接上。**新機器
  或重新 clone 之後第一件事就是 `npm install`**，否則閘門不存在，而且不會有任何提示。
  自檢：`git config core.hooksPath` 應為 `.githooks`。
- 新的**開源**分支要推 origin，得把名字加進 hook 的 `ALLOWED`（這是刻意的摩擦）。
  加之前先確認它不含商業內容——前兩層會擋，但別把它們當作可以隨便加的理由。
- 貢獻者授權見 `CONTRIBUTING.md` 的 CLA：外部貢獻以 AGPL 授權給專案，並額外授權
  mao-data 用於商業版。**沒有這份 CLA，任何外部 PR 都會變成不能拿進 Pro 的程式碼。**

### 一般規則

- 這個 repo 有自己的 `.git`（GitHub `mao-data/vidcut`），在專案目錄內執行 git。
- **不要 `git add -A`**：這個工作區常有多個 session 同時進行，全加會把別人改到一半的
  檔案掃進你的 commit。只 stage 你自己動過的路徑。
- 除非使用者要求，不要自行 commit 或 push。
- **新開 worktree 的第一件事是在裡面 `npm install`。** 沒裝之前跑出來的測試與型別檢查
  結果**一律不算數**，而且它不會報錯——Node 找不到 worktree 自己的 `node_modules` 會
  往上一層解析到主 repo 的，而 `node_modules/@vidcut/shared` 是指向 `../../shared` 的
  symlink，也就是**主 repo 當前檢出的那個分支**的 shared。這個工作區常態是多個 session
  各開 worktree 各在不同分支，所以你會拿自己的 server 程式碼去對別人分支的 `shared`
  做型別檢查與測試。`shared/` 不只有型別、還有執行期程式碼，所以測試照跑、照綠——
  實測踩過一次：`tsc` 噴十幾條 `Type '"addClip"' is not assignable to ...`，同一次執行
  的「240 passed、71/71 mutants killed」全部作廢。兩邊型別剛好相容時連 tsc 都不會噴，
  就是一組看似完美、其實量錯對象的數字。
  自檢：`ls -l <worktree>/node_modules/@vidcut/shared` 必須指向該 worktree 內的 `shared`。

## 交叉參考

- `HANDOFF.md` —— 先讀這份，含各檔案職責與已完成/未驗證的分界
- `docs/ROADMAP.md` —— 上線計劃與可行方向
- `docs/superpowers/specs/` —— 設計定案；`docs/superpowers/plans/` —— 實作計畫
- `.claude/rules/wysiwyg.md`、`.claude/rules/ui-verification.md` —— 檔案範圍限定的
  深度規則（帶 `paths:` frontmatter，動到相關檔案時才載入）
