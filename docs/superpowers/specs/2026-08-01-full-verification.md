# vidcut 全功能驗證（old-coder / evidence-first）

> **歷史文件（2026-08-02 的設計定案）**：記錄當時的決策與理由，**不隨程式碼更新**。
> 現況以 `CLAUDE.md`／`HANDOFF.md` 為準。

2026-08-01 使用者核准全套執行（「全跑」）。

**分級**：整體 Tier 2；持久化與 undo 路徑升 **Tier 3**（資料遺失是本 app 唯一不可逆的失敗）。

## 基準線（執行前實測）

169 tests green（server 97 / shared 27 / ui 45），26 個測試檔，零既有失敗。
`npm run typecheck`、`npm run lint` 乾淨。→ 關卡標準為「零新增失敗」。

## 關鍵發現：既有測試的結構性盲區

169 個測試全是伺服器邏輯或純函式邏輯。UI **元件層零測試**（`jsdom`、
`@testing-library/react` 未安裝）。使用者本週親自回報的每個 bug 都在這個盲區內：
冷載入白屏（React #185）、拖曳放手閃回、右欄按鈕被切、extract_audio 無聲、
只有影片可拖。故本次驗證的主體是「補上這一層」，而非重跑既有測試。

## 功能盤點

- **桶 1｜已有可執行驗證**：19 個 command、ProjectStore patch/undo、render 管線
  （含真跑 ffmpeg）、ASR、review 流程、aiWrite 版本守衛、/assets 上傳、
  時間軸/拖曳數學、播放 plan、面板寬度。
- **桶 2｜有程式碼但零自動驗證**：所有 UI 元件；23 個 MCP tool 只有 5 個測試；
  `/media` Range 僅 1 個測試。
- **桶 3｜本質上自動化不了**：聲音是否真的響、GSAP 手感、成片觀感、
  真實 Claude Code MCP 連線 → 產出人工勾選清單，不假裝已驗。

## 要新寫的測試

| 檔案                                | 驗什麼                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `App.test.tsx`                      | doc=null 冷載入不崩（白屏回歸盔甲）、連線標示、左右欄收合、分頁切換、快捷鍵送出對應 command                          |
| `Timeline.drag.test.tsx`            | 片段 trim/拖序、字幕 move+trim、音訊 move+trim、疊圖絕對式/錨定式、放手 pending 不閃回、吸附                         |
| `Player.test.tsx`                   | 音訊 `<audio>` 生成與 src、窗內外 play/pause、音量×淡變、clip.volume=0 靜音、ducking 0.25、定格不播、疊圖/字幕時間窗 |
| `Inspector.test.tsx`                | 四種選取的欄位與送出的 patch、到片尾切換、刪除鈕                                                                     |
| `CaptionList.test.tsx`              | 改字送出且清 tokens、刪除、樣式套全部、karaoke 高亮                                                                  |
| `ExportMenu.test.tsx`               | 預設檔、render options、進度、設封面                                                                                 |
| `ReviewBar.test.tsx`                | 核准／核准並留言／沒留言不能退回                                                                                     |
| `panels-smoke.test.tsx`             | 每個面板在 doc=null 與 demo doc 下都能 render                                                                        |
| `mcp-tools.test.ts`                 | 補齊未測 MCP tool                                                                                                    |
| `store-durability.test.ts` (Tier 3) | 原子落盤、存檔序列化、undo N 步、history 上限、損毀 JSON 載入                                                        |

## RED 紀律（本任務的誠實核心）

測試驗的是既有行為，會一寫就綠——那本身證明不了任何事。每個測試檔綠燈後，
**在實作裡種 mutant → 親眼看測試變紅 → 還原 → 重新綠燈**。
這一步同時充當突變測試層。EVIDENCE 逐條記錄每隻 mutant 與殺它的測試。

## Setup plan（使用者已授權）

新增 devDependencies（皆為 UI workspace）：

- `jsdom` — 元件測試的 DOM 環境，vitest 官方選項
- `@testing-library/react` — render/查詢，否則需手刻 React 19 測試渲染器
- `@testing-library/user-event` — 正確的 pointer/鍵盤事件序列（拖曳測試需要）
- `@vitest/coverage-v8` — 改動行覆蓋率，vitest 3 同版 provider

**不裝** stryker（對本 repo 過重）→ 改用上述手動 mutant 程序。
新增檔案：`ui/vitest.config.ts`、`scripts/gauntlet.sh`（一鍵重跑所有關卡）、
`scripts/mutants.md`（mutant 清單，供報告重現）。
Git：SPEC 一次 commit、每個測試檔綠燈一次 commit、最後 push 到 `mao-data/vidcut`。

## 關卡

全測試套件（零新增失敗）／tsc／eslint／改動行覆蓋率／手動突變／隨機順序抓 flaky／
真實執行（起 server + headless 開 UI + 跑一次 render 出 mp4）／依賴稽核（`npm audit` +
新增套件授權）／秘密掃描（diff 不得含 .env 內容）。

## 明確不保證

桶 3 各項。EVIDENCE 附使用者親驗清單（每項寫明怎麼點、該看到什麼）。

## 產出

1. 本 SPEC
2. 約 60 個新測試，全綠
3. `EVIDENCE.md`：功能→測試對映、每關卡實際數字、每隻 mutant 生死、
   跳過的層與理由、人工驗證清單
