# EVIDENCE — vidcut 全功能驗證

> **這是驗證記錄，不是現況描述**：每個數字都綁定當時的 commit SHA，**不隨程式碼更新**。
> 要知道現在的狀態，跑 `bash scripts/gauntlet.sh`。現況描述以 `CLAUDE.md`／`HANDOFF.md` 為準。

依 `docs/superpowers/specs/2026-08-01-full-verification.md`（使用者 2026-08-01 核准全套執行）。
**Spec approval: obtained**（使用者核准後才動工）。

一鍵重跑本報告的每個數字：`bash scripts/gauntlet.sh`
下列所有數字皆出自**最後一次程式碼修改之後的單一次乾淨執行**。

**引用慣例**：本報告只引用**repo 裡實際存在的東西**——原始碼、測試、`scripts/mutants.json`、
可重跑的指令。開發過程用的 SDD 過程檔（任務 brief、實作者報告、progress ledger）放在
被 `.gitignore` 的 `.superpowers/`，**不隨分支保留**，所以本報告一律不引用它們；凡是只
存在於過程檔的事實，都已把**內容本身**寫進本報告，並在該處標明「（過程檔，不隨分支
保留）」。看到這個標記＝那句話無法用 repo 核對，只能當作記錄採信；沒有這個標記的每一
句都應該能就地重跑或就地查證。

| 項目   | 值                                    |
| ------ | ------------------------------------- |
| source | `b769331`（`mao-data/vidcut`, main）  |
| node   | v22.18.0                              |
| tsc    | 5.9.3                                 |
| vitest | 3.2.7                                 |
| ffmpeg | 8.1.2                                 |
| 分級   | 整體 Tier 2；持久化／undo 路徑 Tier 3 |

---

## 1. 測試總覽

| 範圍     | 執行前  | 執行後  | 新增     |
| -------- | ------- | ------- | -------- |
| shared   | 27      | 27      | 0        |
| server   | 97      | 128     | +31      |
| ui       | 45      | 128     | +83      |
| **合計** | **169** | **283** | **+114** |

零既有失敗、零新增失敗。

## 2. 功能 → 驗它的測試

| 功能                             | 驗證                                                               |
| -------------------------------- | ------------------------------------------------------------------ |
| 冷載入不白屏                     | `panels-smoke.test.tsx`（8 元件 × 有/無專案）、`App.test.tsx`      |
| 五種軌道拖曳＋trim               | `Timeline.test.tsx`（17）                                          |
| 放手不閃回、連拖不吃位移         | `Timeline.test.tsx` pending 兩則                                   |
| 播放／音訊軌／ducking／定格      | `Player.test.tsx`（10）                                            |
| 快捷鍵（空白/S/Q/W/F/N/⌘Z/箭頭） | `App.test.tsx`                                                     |
| Inspector 四種選取的每個欄位     | `panels.test.tsx`（Inspector 10）                                  |
| 字幕列表編輯／清 tokens／樣式    | `panels.test.tsx`（CaptionList 7）                                 |
| 匯出設定／封面／進度／錯誤       | `panels.test.tsx`（ExportMenu 4）                                  |
| 審核核准／退回必填留言           | `panels.test.tsx`（ReviewBar 4）                                   |
| 19 個 command                    | `commands.test.ts`、`commands-t1.test.ts`（既有）                  |
| 23 個 MCP tool                   | `mcp.test.ts`（既有 5）＋ `mcp-tools.test.ts`（新 18）→ **全覆蓋** |
| 專案檔持久化／undo（Tier 3）     | `store-durability.test.ts`（12）                                   |
| 渲染管線                         | `render.test.ts`、`render-t1.test.ts`（含新的等比縮放）            |
| ASR／逐詞時間戳                  | `asr.test.ts`、`captions-karaoke.test.ts`（既有）                  |
| 面板寬度／吸附／時間換算         | `panelResize.test.ts`、`dragMath.test.ts`、`scale.test.ts`         |

## 3. 關卡結果

| 關卡       | 指令                                     | 結果                                                            |
| ---------- | ---------------------------------------- | --------------------------------------------------------------- |
| 全測試套件 | `npm test`                               | **283 passed**（27／128／128），0 failed                        |
| 型別       | `npm run typecheck`                      | PASS，0 errors（3 個 workspace）                                |
| Lint       | `npm run lint`                           | PASS，0 problems                                                |
| 格式       | `npm run format:check`                   | PASS                                                            |
| UI 覆蓋率  | `vitest run --coverage`                  | Lines **85.6%**（2432/2841）、Branches 84.04%、Functions 63.18% |
| 突變測試   | `node scripts/mutate.mjs`                | **27/27 killed**（+1 等價對照組如預期存活）                     |
| 隨機順序   | `vitest --sequence.shuffle`（1337/42/7） | PASS（無 flaky／順序相依）                                      |
| 真實執行   | 起 server + headless UI + 實際渲染       | PASS（見 §5）                                                   |
| 依賴稽核   | `npm audit`                              | **0 vulnerabilities**（修前：1 high，dev-only）                 |
| 秘密掃描   | `git grep` 於追蹤檔                      | PASS，無命中；無 `.env` 被追蹤                                  |

### 突變測試明細（27 隻，全部被殺）

每隻都是「在實作裡種一個真的 bug → 跑對應測試 → 必須變紅 → 還原」。
清單在 `scripts/mutants.json`，可逐隻重跑（`node scripts/mutate.mjs <id>`）。

- **Player／plan（6）**：拿掉淡入增益、音訊窗恆成立、`clip.volume=0` 不靜音、
  ducking 失效、音訊改用原始檔、字幕不過濾時間窗
- **Timeline／dragMath（5）**：拖曳位移歸零、拿掉左邊界 clamp、pending 立即放掉、
  錨定 offset 忘記扣片段起點、音訊 trim-in 未連動 source in
- **App／CaptionList（4）**：**還原當初白屏真兇**（selector 回傳新陣列）、
  拿掉輸入框守衛、Shift 不跳 10 幀、回報 playhead 恆為 0
- **面板（5）**：改字不清 tokens、沒留言也能退回、錨定疊圖誤送絕對 start、
  「到片尾」不送 null、刪除後未取消選取
- **Store／commands／render（7）**：非原子落盤、存檔不串接、undo 未逆序、
  空變更也記版本、非排列順序不再被拒、抽聲音後未靜音、單邊尺寸不等比
- **等價對照組（1）**：`store-corrupt-load` 語意不變 → **如預期存活**。
  放它在清單裡是為了證明引擎會如實回報存活，而不是對什麼都喊「殺掉」。

## 4. 過程中找到並修掉的缺陷（5 項）

寫測試的目的就是找出這些；每一項都有回歸測試守著。

1. **音訊同步在 A/B 影片交換那輪被跳過**（`Player.tsx`）
   影片 effect 在交換路徑提前 `return`，音訊校正整輪沒跑——跨片段邊界 seek 時，
   出窗的音訊不會被暫停。播放中每幀重跑會自我修正（約 16ms），所以肉眼難察。
   → 音訊同步拆成獨立 effect，不變量變成無條件。
2. **匯出只給單一維度會產出變形成品**（`render.ts`）
   `RenderOptions.width` 文件寫「等比縮放」，實作卻各軸獨立：1080×1920 畫布給
   `{width:360}` 得到 360×1920。UI 預設檔都成對給值，**但 MCP 的 render 工具
   把兩個參數獨立開放給 AI**，AI 只給一邊就會默默交出壓扁的片子。
   → 依畫布比例推算另一邊（取偶數），紅燈測試先行。
3. **`ActiveAudio.src` 是死欄位**（`plan.ts`）——`<audio>` 的 src 另有來源。突變測試揪出。→ 刪除。
4. **`shiftStart(start, delta)` 的 delta 參數在所有呼叫點都是 0**（`dragMath.ts`）——
   簽名在說謊。→ 改名 `clampStart(start)`。
5. **我新寫的 MCP 測試有順序相依**——共用可變狀態，隨機順序即失敗。
   既有 17 個檔案在隨機順序下皆通過（基準線乾淨），問題是我引入的。
   → 每個測試從重置後的基準狀態開始。

另修：`ui/coverage/` 未忽略導致格式檢查失敗；秘密掃描掃到它自己的正則（自我命中）；
`npm audit` 的 1 個 high（dev-only）已修為 0。

## 5. 真實執行（非只有測試框架）

以正式建置的 UI 由真實 server 提供服務：

- `GET /` → 200；`GET /api/project` → 回傳專案 JSON
- `GET /media/...` 帶 `Range` → **206 Partial Content**（`<video>` seek 的前提）
- headless Chromium 載入 → 完整介面渲染（980,293 個非黑像素；截圖已核對面板、
  波形、字幕、疊圖、音訊軌皆在位）
- 經 WebSocket 觸發渲染 → `{"status":"done","progress":1,"lastOutput":"output/render_9.mp4"}`
  → `ffprobe`：h264 + aac、25.000s、1.73 MB
  （**此步驟正是缺陷 2 的發現處**——修正後同樣參數輸出 360×640）

## 6. 已知限制與跳過的層

- **Property-based 測試：未做**。`fast-check` 不在依賴內，SPEC 的 setup plan 也沒列，
  臨時加會超出已核准的授權範圍。dragMath／時間換算這類純函式最適合它，
  屬未來可補強項。
- **突變工具（stryker）：未裝**，依 SPEC 改用手動突變（27 隻，清單在 repo 內可重跑）。
  手動突變覆蓋的是我挑的失敗模式，不是工具窮舉出的全部。
- **突變歸屬**：殺掉一隻 mutant 的是「最先失敗的那個測試」，所以 27/27 驗證的是
  **整體套件**，不是每個檔案各自獨立有效。
- **UI 函式覆蓋率 63.18%** 低於行覆蓋率，主要是事件處理器與 GSAP 回呼未被觸發。
  最低的幾個檔案：`waveform.ts` 17.6%（canvas 繪製，jsdom 無實作）、
  `ws.ts` 20.7%（WebSocket 連線層，測試中被 mock 掉）、`stores/view.ts` 58.3%。
- **未驗**：桶 3 各項，見下。

## 7. 需要你親自驗（自動化驗不到的）

| #   | 怎麼做                                                                            | 該看到／聽到什麼                                                                                                      |
| --- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | 開 demo 專案按播放                                                                | 2–7 秒間**聽得到**抽出的 `🔊 No.1` 音訊；volume=0 的片段安靜（測試只驗到 DOM 的 volume/play 狀態，headless 沒有喇叭） |
| 2   | 選中音訊 chip → 勾 ducking → 播放                                                 | 音訊響起時影片原聲明顯變小                                                                                            |
| 3   | 拖曳字幕／音訊／疊圖                                                              | 跟手、放開不閃回、吸附時有紫線                                                                                        |
| 4   | 拖左右面板邊緣                                                                    | 平滑縮放、到最小不自動收起、按鈕不被切                                                                                |
| 5   | 播放時觀察整體流暢度                                                              | 時間軸長片段多時不卡（本次改的訂閱粒度）                                                                              |
| 6   | ➕疊圖 上傳一張 PNG                                                               | 出現在疊圖軌、可拖、Inspector 可改時間                                                                                |
| 7   | 匯出一支成品並播放                                                                | 畫面比例正確、字幕位置與預覽一致、音量合理                                                                            |
| 8   | `claude mcp add --transport http vidcut http://127.0.0.1:3845/mcp` 後請 AI 剪一段 | AI 的編輯即時出現在 UI；審核條可核准／退回                                                                            |

## 8. 這份報告能保證什麼、不能保證什麼

**能**：283 個測試涵蓋上表每一項功能路徑；27 隻刻意植入的 bug 全被抓到，
代表這些測試在斷言真實行為而不是在裝樣子；隨機順序下結果穩定；
產品能真的啟動、服務、渲染出可播放的成品。

**不能**：關卡只能證明程式滿足**規格所表達的**約束，無法證明規格表達了**所有重要的事**。
聲音品質、動效手感、成片觀感這類仍必須由你親眼親耳確認（§7）。

---

# EVIDENCE 追加 — AI 編輯動畫層（2026-08-02）

依 `docs/superpowers/specs/2026-08-02-ai-edit-fx.md`。
Spec approval：設計（效果/節奏/觸發規則）經對話核准後，使用者指示「直接用
/old-coder 開工」——SPEC 在該預授權下逕行執行，未再等待逐條核准。Tier 2。

## 行為 → 測試對映

| SPEC 條目                                                          | 測試                                 |
| ------------------------------------------------------------------ | ------------------------------------ |
| A1–A7 patch 分析（整軌替換/單欄位/重排/新增/刪除/minStart/非軌道） | `fx/aiPatches.test.ts`（9）          |
| B8–B10 動畫窗開關/自清/連發合併                                    | `stores/editFx.test.ts`（5）         |
| C11–C12 只有 ai 觸發、human 不觸發                                 | `stores/project.fx.test.ts`（3）     |
| D13–D16 容器 ai-anim／光暈交替／骨牌 stagger／**拖曳中抑制**       | `timeline/Timeline.fx.test.tsx`（5） |
| D17 scrollTargetFor（可見不捲/1/3 定位/clamp/量測不到不捲）        | 同上（4）                            |
| E18–E19 Player 進場／Activity 新列滑入                             | `panels/fx.test.tsx`（3）            |

新增 29 測試；RED-first（兩個 stub 先看 13 紅、元件接線先看 5+2 紅）。
例外：`scrollTargetFor` 4 個測試因實作先行而立即綠——其非空泛由 mutant
`fx-scroll-visible` 證明（拿掉可見判斷 → 測試變紅）。

## 關卡（單一最終乾淨執行，commit `0d0adae` 前後見 git log）

| 關卡                  | 結果                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 全測試套件            | **312 passed**（shared 27／server 128／ui 157），0 failed                                                                                                                      |
| tsc／eslint／prettier | PASS／PASS／PASS                                                                                                                                                               |
| UI 覆蓋率             | Lines 86.3%（2584/2994）、Branches 85.15%                                                                                                                                      |
| 突變                  | **35/35 killed**（+1 等價對照組如預期存活）；本功能新增 8 隻全滅                                                                                                               |
| 隨機順序              | ui/server 皆 PASS                                                                                                                                                              |
| 依賴稽核              | 0 vulnerabilities（**零新依賴**，捲動用 gsap 現有能力）                                                                                                                        |
| 秘密掃描              | PASS                                                                                                                                                                           |
| 真實執行              | production build 由真 server 服務、冷載入完整渲染（1,147,161 非黑像素）；shipped CSS bundle 內含全部 fx 規則（fx-glow-a/b、fx-enter、fx-slidein、ai-anim、--fx-spring 各就位） |

## 本功能的 8 隻 mutants（全滅）

ai gate 開給 human／動畫窗永不關／連發不合併／新增誤判修改／
**拖曳中也掛動畫（1:1 跟手破壞）**／stagger 歸零／光暈不交替／可見仍捲動。

## 跳過與已知限制

- **reduced-motion 未寫單元測試**（jsdom 不套用 media query）：由既有全域
  `prefers-reduced-motion` 規則（`!important`）涵蓋，屬 CSS 靜態事實；親驗項。
- **刪除項無退場動畫**（React 立即 unmount；SPEC 已排除本輪範圍）。
- **動畫觀感自動化驗不到**：class/參數/觸發全數已測；「絲滑與否」見下。
- CDP 動畫中截幀探針因 headless 連線問題放棄，未納入證據（不假裝跑過）；
  以「bundle 含規則＋接線測試」替代，信心層級如實較低一級。

## 使用者親驗清單（fx 專屬）

1. 讓 AI 連線做一次編輯（改字幕時間）→ chip 應**滑行**過去（帶一點回彈）並亮紫暈 1 秒。
2. 請 AI 跑 auto_caption → 整排字幕應**依序彈入**（骨牌），非同幀全現。
3. AI 改視窗外的項目 → 時間軸應先平滑捲過去再亮暈。
4. AI 編輯的**同時**拖你自己的 chip → 你的拖曳必須完全跟手、無延遲感。
5. 系統開「減少動態效果」→ 以上全部退化為瞬切。

---

# 補記三：MCP 層五項優化（2026-08-02）

Spec：`docs/superpowers/specs/2026-08-02-mcp-optimizations.md`。Tier 2。
Spec 核准：使用者核准優化清單（「好 用/old-coder把優化都做」）；細部規格自主撰寫，本檔供事後審閱。
來源狀態：commit `195ccf5`（gauntlet 於其工作樹執行；EVIDENCE 本身於次一 commit）。

## 行為 → 測試對映（server/test/mcp-optim.test.ts，20 條，全數先紅後綠）

| 行為                                                                           | 測試                                                                                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| B1 get_frame 內嵌 JPEG（含 magic bytes、URL 保留）                             | `get_frame returns an inline JPEG image block plus the URL`                                                              |
| B2 set_cover 內嵌 JPEG＋coverPath                                              | `set_cover returns an inline JPEG image block…`                                                                          |
| B3 stale／not-found／unknown mediaId／review 中／import 失敗／無片段 → isError | B3 describe 六條                                                                                                         |
| B3 成功路徑不標 isError                                                        | `a successful write is not flagged isError`（RED 時即綠＝負向不變式，由 `mcp-writereply-always-err` 突變武裝證明可失敗） |
| B4 update_caption 單句修改／tokens:[] 清除／unknown id／stale ifVersion        | B4 describe 前四條                                                                                                       |
| B4 update_overlay／add_overlay／remove_overlay／remove_audio                   | B4 describe 後三條                                                                                                       |
| B5 六個讀取工具 readOnlyHint:true；寫入工具不得標                              | B5 describe 兩條                                                                                                         |
| B6 >1000 詞截斷（capped/flag/總數/jsonPath）；≤1000 全量                       | B6 describe 兩條                                                                                                         |

RED 過程：B3 六紅一綠 → GREEN；B1/B2 兩紅 → GREEN；B4 五紅二「假綠」
（工具未註冊時 SDK 的 tool-not-found 恰含 not found＋isError，GREEN 後語意轉正，
並由 `mcp-ifversion-drop` 突變證明會失敗）；B5 一紅一綠（負向）；B6 一紅一綠（現狀）。

## 最終乾淨 GAUNTLET（最後一次程式碼修改後全新執行）

| 關卡                  | 結果                                                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全測試套件            | **332 passed**（shared 27／server 148／ui 157），0 failed                                                                                                                                                |
| tsc／eslint／prettier | PASS／PASS／PASS                                                                                                                                                                                         |
| UI 覆蓋率             | Lines 86.3%（2584/2994）——本輪只動 server                                                                                                                                                                |
| 突變                  | **41/41 killed**（+1 等價對照組如預期存活）；本功能新增 6 隻全滅：isError 旗標／成功也標錯／ifVersion 佈線／readOnlyHint／截斷關閉／mime 錯                                                              |
| 隨機順序              | ui/server 皆 PASS                                                                                                                                                                                        |
| 依賴稽核              | 0 vulnerabilities（零新依賴）                                                                                                                                                                            |
| 秘密掃描              | PASS                                                                                                                                                                                                     |
| 真實執行              | 以新碼重啟正式 server（:3845, projects/demo），實打 `/mcp`：tools/list 回 **28 工具**、5 個細粒度工具在列、6 個 readOnlyHint 正確；live 呼叫 get_frame 回 42,465 bytes 內嵌 JPEG（magic bytes 驗證通過） |

## 跳過與已知限制

- get_frame／transcribe 標 readOnlyHint 但確實會寫 `derived/` 快取檔——不動 project.json，
  視為讀取；此為判斷而非事實，如需嚴格語義可拿掉。
- 影像 block 無尺寸上限（proxy 幀約數十 KB；超大來源未防護，spec 已列不做）。
- transcribe 截斷閾值 1000 為工程判斷值，非參數。
- 中途發現並修正：perl 批次替換曾把 writeReply 自身改成無窮遞迴、又漏掉三處跨行呼叫
  （set_overlays/set_captions/set_audio 一度未標 isError）——均在同輪 GREEN 內修復，
  最終狀態以上表全綠為準。

---

# 補記四：預覽音訊 seek 風暴修正（2026-08-02）

Spec：`docs/superpowers/specs/2026-08-02-preview-audio-sync.md`。Tier 2。
Spec 核准：診斷報告＋計劃已呈使用者，回覆「好」。來源狀態：commit `6404b20`。

## 診斷（修正前，同環境基線）

- 使用者回報：預覽同時有影片聲＋旁白時「混雜的雜音」；AskUserQuestion 確認僅預覽。
- 已量測排除：削波（模擬混音峰 -6.07 dB；成品 VO 窗峰 -5.58 dB、flat factor 0）、
  ducking 未生效、取樣率不符。
- **證實根因**：headless 探針 4.5s 播放錄得 seeking VIDEO 41 + AUDIO 41、
  waiting 41+40，間隔 ~83ms——rAF 主時鐘與媒體時鐘無耦合，>60ms 即硬 seek，
  seek 後解碼重啟延遲使偏差再超標 → 永久循環，兩條斷續音軌疊加＝雜音。

## 行為 → 測試對映

| 行為                                                                               | 測試                                            |
| ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| syncAction：≥0.25s seek／≤0.02s 復速／其間比例 0.5 調速、clamp ±8%（含全部邊界值） | `ui/src/player/sync.test.ts`（5 條，stub 先紅） |
| 播放中 audio 小漂移只調 playbackRate、不寫 currentTime                             | `Player.sync.test.tsx` 第 1 條（先紅）          |
| 播放中大漂移硬 seek 且 playbackRate 復位 1                                         | 第 2 條（先紅）                                 |
| 暫停時維持精準 snap（回歸護甲，RED 時即綠，由 player-sync-wiring 突變武裝）        | 第 3 條                                         |
| active video 同策略（測試首版誤設 fixture 的 in 值，修測試非實作）                 | 第 4 條（先紅）                                 |

## 最終乾淨 GAUNTLET＋驗收

| 關卡                                                               | 結果                                                                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 全測試套件                                                         | **341 passed**（shared 27／server 148／ui 166），0 failed                                                |
| tsc／eslint／prettier                                              | PASS／PASS／PASS                                                                                         |
| UI 覆蓋率                                                          | Lines 86.33%（2615/3029）                                                                                |
| 突變                                                               | **45/45 killed**（+1 等價對照）；本功能 4 隻全滅：門檻／方向反轉／死區／接線退化                         |
| 隨機順序／依賴稽核／秘密掃描                                       | PASS／0 vulnerabilities／PASS                                                                            |
| **驗收探針**（`node scripts/audio-probe.mjs`，重建 UI 後最終執行） | seeking **82 → 2**（僅 video 起播與 A/B 交換的正常對齊）、audio **0** 次 seek、waiting 81 → 1 → **PASS** |

新依賴：`playwright-core`（devDep，驗收探針驅動 headless Chromium；瀏覽器用既有
ms-playwright 快取）——spec 設定計畫已列，npm audit 0 vulnerabilities。

## 跳過與已知限制

- 探針跑在 headless（無實體音訊裝置），為同環境前後對照，非聽感絕對證明；
  ±8% 調速在極端媒體時鐘故障下退化為 ~0.5s 一次 seek（仍遠優於 83ms 一次）。
- DUCK_LEVEL=0.25 的殘留原聲（旁白下 -19 dB 峰值可聞）**未動**——待使用者
  修後親聽，若仍嫌吵再調（一行常數）。

## 使用者親驗

重新整理瀏覽器（UI 已重建），播放 0–4s：旁白＋影片聲應乾淨無斷續刮擦聲；
拖 playhead 應立即到位；若旁白底下的環境聲仍嫌吵，回報後調 DUCK_LEVEL。

---

# 補記五：版本語意＋游標式 undo/redo（2026-08-03）

Spec：`docs/superpowers/specs/2026-08-03-version-undo-redo.md`。Tier 2。
Spec 核准：使用者核准標頭＋進度旁路（「這部分可以」）與 undo 1+2、
「直接撤掉上一個行為」的游標語意（「做1 2」）。來源狀態：commit `90a5fbd`。

## 診斷（修正前）

跑中的 server 近 149 筆歷史：**73 筆 `render progress`**、27 筆 undo、
真編輯僅 20 餘筆。三個具體缺陷：修訂號被進度灌爆且掛在標頭像軟體版本、
server 重啟歸零、undo 因「撤 undo 自己＝redo」而在最後一步來回擺盪且會撤到
非編輯狀態（按了畫面沒反應）。

## 行為 → 測試對映

| 行為                                                             | 測試                                              |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| B1 標頭顯示語意化軟體版本、不顯示修訂號                          | `ui/src/app-version.test.tsx` 第 1 條（先紅）     |
| B2 進度走旁路 bus：歷史不含 render progress、版本僅 +2、事件照發 | `server/test/render.test.ts` 整合測試（先紅）     |
| B2/B5 UI 收 renderProgress 不推進版本；render patch 清暫態進度   | `app-version.test.tsx` 第 2、3 條（先紅）         |
| B3 rev 落盤、重載續走、doc 本體不含 rev                          | `server/test/store-undo.test.ts` B3 段（先紅）    |
| B4 連按 undo 一路往回退（不擺盪）                                | `store-undo.test.ts` 第 1 條（先紅）              |
| B4 undo 記錄具名 `undo: <原label>`、source 為呼叫者              | 第 2 條（先紅）                                   |
| B4 redo 對稱、新編輯清空 redo（分叉）                            | 第 3、4 條（先紅）                                |
| B4 非編輯 mutation 不進 undo 範圍、也不清 redo                   | 第 5 條（先紅）                                   |
| B4 revertSince 逆序回滾（審核退回）                              | 第 7 條（先紅；**後經突變發現盲點並補強**，見下） |
| B5 Activity Redo 鈕送出 redo 命令                                | `app-version.test.tsx` 第 4 條（先紅）            |
| MCP redo 工具（重做／無可重做標 isError）                        | `server/test/mcp-tools.test.ts` 兩條（先紅）      |

## 最終乾淨 GAUNTLET

| 關卡                  | 結果                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全測試套件            | **355 passed**（shared 27／server 158／ui 170），0 failed                                                                                                            |
| tsc／eslint／prettier | PASS／PASS／PASS                                                                                                                                                     |
| UI 覆蓋率             | Lines 86.38%（2627/3041）                                                                                                                                            |
| 突變                  | **51/51 killed**（+1 等價對照）；本案新增 6 隻全滅：undo 推回原堆疊（＝舊擺盪 bug）／新編輯不清 redo／可撤回分類失效／rev 不落盤／進度改回版本化／標頭改回顯示修訂號 |
| 隨機順序              | ui/server 皆 PASS（server 另以 seed 1337/42/7 各驗一次）                                                                                                             |
| 依賴稽核／秘密掃描    | 0 vulnerabilities／PASS                                                                                                                                              |

## 真實執行驗證（重建 UI＋重啟 server 後，對 :3845 實打 MCP）

- 三筆編輯 E1→E2→E3 後**連按 undo ×3**，歷史顯示
  `undo: edit E2`／`undo: edit E1`／`undo: edit No.5 扶手走鋼索`
  ——**每次撤掉不同的一步，確認不再擺盪**；label 回到原值。
- `redo` ×1 正確取回 E1（version 7）。
- `project.json` 落盤含 `rev: 7`；**重啟 server 後 get_project 回 `v7`**（不歸零）。
- shipped bundle 含 `0.1.0` 字串（標頭走 define 注入）。
- 驗證後已把 demo 的 clip label 還原為原值（rev 8）。

## 過程中的問題與處理（如實記載）

1. `store.test.ts` 有一條斷言舊語意（註解明寫「撤 undo 自己＝redo，可接受」）。
   這是 SPEC 明確變更的行為，已改為斷言新語意並註明出處——非放寬。
2. 新增的「nothing to redo」測試**隨機順序下失敗**：redo 堆疊是 store 級狀態，
   fixture 重置含 render 欄位故不算可撤回編輯、不會清它。改以「先做一筆真編輯
   （分叉語意會清 redo）」讓測試自足，非放寬斷言。
3. 三隻既有突變因 store.ts 改寫而 `find` 失效（引擎如實報 ERROR 而非默默跳過），
   已更新指向新程式碼。其中 `store-undo-order` 更新後**存活**——揭露我的
   revertSince 測試盲點（單筆陣列變更時順序無關）。補強為「同陣列多筆連續變更」
   後該突變即被殺死。這是突變測試抓到測試本身缺陷的實例。

## 已知限制

- undo/redo 堆疊在 server 記憶體，重啟清空（修訂號會續走）——與市售編輯器一致。
- 舊 project.json 無 `rev` → 首次載入為 0，之後續走（相容行為，實測確認）。
- `steps>1` 的 undo/redo 逐筆各記一筆 mutation，Activity 會顯示多列。

## 使用者親驗

重新整理瀏覽器：標頭應顯示 `vidcut · v0.1.0 · demo`；連按 Cmd+Z 應一路往回退、
Cmd+Shift+Z（或 Activity 的 Redo 鈕）往前；渲染時版本號不再狂跳、Activity 不再被
進度洗版。

---

# 補記：素材匯入 階段 1（零複製引用）2026-08-03

Spec：`docs/superpowers/specs/2026-08-03-media-import-design.md`（階段 1：後端能力）。
分七個 Task（各有獨立審查與修復迴圈）+ 本 Task（8）補齊突變覆蓋與本節。
來源狀態：commit `6cb9107`（Task 1–7 最終）+ 本 Task 新增的 `scripts/mutants.json`／
`EVIDENCE.md`／`server/test/render.test.ts`。

核心決策：`MediaAsset.path` 的語意擴充——相對路徑＝專案內（既有行為），絕對路徑＝
外部零複製引用。樞紐是 `server/src/paths.ts` 的 `resolveMediaPath(projectDir, path)`，
換掉原本硬接的 `join(projectDir, media.path)`。**呼叫點實際是 8 處，不是 4 處**
（前版此處寫「四處」，已修正——見下方逐處守護表）：
`render.ts:201/222/407/431/523`（5 處）、`ingest.ts:33`（1 處）、`asr.ts:89/96`（2 處）。

> **合併 main 後為 9 處**：`withProbedChannels`（渲染前補測 `audioChannels`）是合併
> 時新生的呼叫點，`main` 那邊原本寫成 `join`。見文末「補記：合併 main（純音訊匯入）」。

## 行為 → 測試對映

| 行為                                                                                                                                                                                                                           | 測試                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveMediaPath`：相對接在專案下／絕對原樣回傳／`..` 正規化／空字串回專案本身                                                                                                                                                | `server/test/paths.test.ts`（4 條，Task 1）                                                                                                             |
| 9 處 `resolveMediaPath` 呼叫點換掉硬接的 `join(projectDir, media.path)`（合併前 8 處）                                                                                                                                         | 見下方「`resolveMediaPath` 呼叫點逐處守護情形」，逐處列出各自的測試／mutant                                                                             |
| `scanSourceFolder`：白名單副檔名、大小寫、排除隱藏檔、不遞迴、大小/mtime、symlink 收錄、斷 symlink 略過、非 ASCII/空白檔名、略過子目錄、目錄不存在丟錯、傳入檔案丟錯、位元組序穩健排序                                         | `server/test/sourceFolder.test.ts`（12 條，Task 4）                                                                                                     |
| `GET /api/source`：列出檔案、`imported` 標記（含相對路徑素材）、400（目錄不存在／沒帶 dir）                                                                                                                                    | `server/test/source-api.test.ts`（5 條，Task 5；commit `9dccca1`=前 4 條、`4103b35`=第 5 條殺 `resolveMediaPath` 缺口）                                 |
| `ingestMedia` 接受絕對路徑、同絕對路徑冪等回同 id                                                                                                                                                                              | `server/test/ingest.test.ts`「可以 ingest…」「同一個絕對路徑重複 ingest 回同一個 id」                                                                   |
| `addClip` command：append 到主軌尾端、未知 mediaId 拒絕、duration≤0 拒絕、in+duration 超界拒絕、剛好用滿允許、浮點誤差 1e-6 容差                                                                                               | `server/test/commands.test.ts`「addClip」describe 區塊（6 條，Task 3；含審查後補的浮點邊界測試）                                                        |
| `POST /api/import`：匯入進 `doc.media` 且原檔不複製、`addToTimeline` 接到主軌尾端、壞檔進 `failed[]` 其餘繼續、400（缺 dir/names）、`basename` 防 traversal（相對／絕對兩種敵意輸入）、逐支序列處理不變式（`maxInFlight===1`） | `server/test/import-api.test.ts`（7 條，Task 6；審查後補誘餌檔堵假殺、補序列不變式觀測測試）                                                            |
| MCP `import_media` 說明更新（接受絕對路徑）                                                                                                                                                                                    | 透過 `server/test/mcp-tools.test.ts` 的 `import_media` 呼叫間接覆蓋（工具本身只是 `ingestMedia` 的薄殼，行為驗證落在 `ingest.test.ts`）                 |
| ingest 中途失敗清掉半成品 `derived/<id>/`                                                                                                                                                                                      | `server/test/ingest.test.ts`「ingest 失敗不留下半成品 derived 目錄」「（補 Step 3 的殺傷力）proxy 編碼寫檔失敗時…也會被清掉」（Task 7）                 |
| render 輸出前缺檔預檢，錯誤訊息 `/^render: 找不到素材原檔：/`                                                                                                                                                                  | `server/test/render.test.ts`「素材原檔不見時，輸出丟出含路徑的明確錯誤」（Task 7）＋本 Task 新增「frozen clip 的素材原檔不見時…」（守住預檢的**位置**） |

### `resolveMediaPath` 呼叫點逐處守護情形

全分支審查（最終輪）點出前七輪的「四處」是錯的，實際 8 處呼叫點，其中兩處
（`render.ts:222`、`render.ts:431`）過去完全沒有測試守著——把它們換回
`join(projectDir, media.path)`，全套 server 測試（當時 201 條）照樣全綠。下表逐處列出
現況守護：

| #   | 呼叫點          | 用途                                            | 守護                                                                                                                                                                                                                               |
| --- | --------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `render.ts:201` | 一般（非 frozen）片段的 ffmpeg input            | `render.test.ts`「輸出吃專案外絕對路徑的素材」整合測試（真 ffmpeg，Task 1）                                                                                                                                                        |
| 2   | `render.ts:222` | 獨立音訊項（旁白/BGM/抽出的聲音）的 input       | **全分支審查最終修復輪新增**（非 Task 8 本身，見文末新增的獨立章節）：`render.test.ts`「uses an absolute audio-item media path…(render.ts:222)」（`buildRenderArgs` 純函數斷言）＋ `render-audio-input-path` mutant（已實跑，殺）  |
| 3   | `render.ts:407` | 輸出前缺檔預檢（`existsSync`）                  | `render.test.ts`「素材原檔不見時…」兩條（含 frozen 變體）＋ `render-precheck` mutant                                                                                                                                               |
| 4   | `render.ts:431` | 定格幀（frozen frame）擷取來源                  | **全分支審查最終修復輪新增**（非 Task 8 本身，見文末新增的獨立章節）：`render.test.ts`「frozen clip 用專案外絕對路徑素材時仍能定格擷取成功（render.ts:431）」整合測試（真 ffmpeg）＋ `render-frozen-src-path` mutant（已實跑，殺） |
| 5   | `render.ts:523` | `extractCover` 無成片時退回來源素材             | **等價突變，不加測試/mutant**——理由在合併 main 後換了一套，見下方「合併後等價理由的變更」。                                                                                                                                        |
| 6   | `ingest.ts:33`  | ingest 入口讀原檔做 probe/proxy/filmstrip/peaks | `ingest.test.ts`「可以 ingest 專案資料夾外的絕對路徑」「同一個絕對路徑重複 ingest 回同一個 id」                                                                                                                                    |
| 7   | `asr.ts:89`     | ASR 混音的片段 input                            | `asr.test.ts`「uses an absolute clip media path as-is instead of joining it under projectDir」                                                                                                                                     |
| 8   | `asr.ts:96`     | ASR 混音的獨立音訊項 input                      | `asr.test.ts`「uses an absolute audio-item media path as-is instead of joining it under projectDir」                                                                                                                               |

| 9 | `render.ts` `withProbedChannels` | 渲染前補測 `audioChannels`（合併 main 後新增） | `render.test.ts`「外部絕對路徑的 mono 素材也補得到 audioChannels」＋ `render-probe-channels-path` mutant（已實跑，殺） |

另有一處同型的接法：`server/src/frame.ts:20,30`（`extractFrame`，AI `get_frame` 用）
過去是 `loc.media.proxyPath ?? loc.media.path` 直接 `join`，與第 5 項同一形狀、同一等價理由。
全分支審查最終修復輪已改成 `resolveMediaPath`（防禦性一致化，不可達故不加 mutant——
加了會存活，違反 anti-gaming 規則）。

### 合併後等價理由的變更（第 5 項與 `frame.ts`）

合併 `main` 前的理由是「`ingestMedia` 是唯一寫 `doc.media` 的地方，且**必寫**
`proxyPath`，所以 `proxyPath ?? path` 恆為相對路徑」。**這個前提被 `main` 推翻了**：
純音訊素材跳過 proxy，`proxyPath`／`filmstripPath` 不再寫入（`ingest.ts` 的
`audioOnly` 分支）。若純音訊素材能出現在 `locate()` 看得到的地方，`?? path` 就會落到
可能是絕對路徑的 `path`，`join` 與 `resolveMediaPath` 行為就不同了。

**等價結論仍成立，但改由守衛支撐**：`locate()` 只看 `tracks.video`
（`shared/src/timeline.ts:30-33`），而上視訊軌只有兩條路，兩條都擋掉 audio-only——

- `addClip` command（`commands.ts:216`，本次新增）→ mutant `addclip-audio-only` 守著
- MCP `set_timeline`（`mcp.ts:334`，`main` 新增；它不是 command，是既有的直接 `mutate` 例外）

其餘動 `tracks.video` 的 command（`splitAt`／`freezeFrame`／`deleteBefore`…）都只作用在既有 clip 上，不會引進新的 `mediaId`。所以 `loc.media` 恆非 audio-only、`proxyPath`
恆存在，第 5 項與 `frame.ts` 維持等價、維持不加 mutant。**這個論證現在有測試撐著**
（拿掉 `addClip` 守衛 → `addclip-audio-only` 轉紅），不再只是靠「ingest 必寫」的巧合。

## Baseline 與最終 GAUNTLET

**開工前**（commit `6cb9107`，Task 7 收尾）：測試數為 **397**（shared 27／server
200／ui 170）——出自 Task 7 收尾那次 `bash scripts/gauntlet.sh --fast` 的實際輸出
（`Tests 27 passed (27)` / `Tests 200 passed (200)` / `Tests 170 passed (170)`，
tsc/eslint/prettier/隨機順序/秘密掃描皆 PASS），**非本 Task 重新執行的數字**（過程檔，
不隨分支保留；要複核請在 `6cb9107` 上自行重跑）。`--fast` 只跳過最後一關突變測試，
其餘關卡不受它影響，所以測試數與格式/型別結果可信；但也代表
Task 7 沒有跑過完整版 `gauntlet.sh`——**完整版（含突變）在 `6cb9107` 上從未執行過**，
不能宣稱「全綠」。真正的開工前缺口是**突變覆蓋率**：Task 1–7 新增的素材匯入程式碼
（`paths.ts`／`addClip`／`sourceFolder.ts`／`/api/source`／`/api/import`／ingest
清理／render 預檢）完全沒有 `scripts/mutants.json` 條目守著，而且 Task 7 審查另外
抓到一個結構性盲點：把 render 的缺檔預檢搬到凍結幀擷取之後，`render.test.ts` 6/6
仍全綠（全文無 `frozen` 字樣）。這兩項（突變覆蓋掛零、預檢位置無回歸防護）就是本
Task 要補的「既有缺口」——不是紅字測試，而是「假綠」：測試都通過，但沒有東西證明
它們真的在斷言。

**最終乾淨 GAUNTLET**（本 Task 最後一次程式碼／測試修改之後，`bash scripts/gauntlet.sh`
完整版，唯一引用的一次執行）：

| 關卡                  | 結果                                                                                                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本                  | node v22.18.0／npm 11.5.2／tsc 5.9.3／vitest 3.2.7／ffmpeg 8.1.2／source `b5dc706`                                                                                                                                                                          |
| tsc／eslint／prettier | PASS／PASS／PASS                                                                                                                                                                                                                                            |
| 全測試套件            | **398 passed**（shared 27／server 201／ui 170），0 failed——較 Task 7 收尾時的 397 多 1（本 Task 新增的 frozen 回歸測試）                                                                                                                                    |
| UI 覆蓋率             | Lines 86.38%（2627/3041）——與 Task 7 完全相同，本 Task 未動 UI                                                                                                                                                                                              |
| 突變                  | **63 隻：62 killed + 1 equivalent control**（`store-corrupt-load`，既有非本次新增，如實存活）；0 存活未處理者                                                                                                                                               |
| 隨機順序              | ui／server 皆 PASS                                                                                                                                                                                                                                          |
| 依賴稽核              | 未新增依賴（`git diff --stat` 僅 `scripts/mutants.json`／`EVIDENCE.md`／`server/test/render.test.ts`，無 `package.json`）；手動 `npm audit --audit-level=high` 額外確認 2 個既有 high（`fast-uri` 3.0.0–3.1.4），與 Task 7 記錄的 baseline 一致，非本次新增 |
| 秘密掃描              | PASS                                                                                                                                                                                                                                                        |

`scripts/mutants.json` 由 52 隻增至 **63 隻**（不是 brief 原文的 46→54；controller 已
核對現況並修正此數字）。

## 本功能的 11 隻 mutants

8 隻照 brief 逐字追加（find 字串與現有原始碼逐字核對過，全部一致）：

| id                     | 改了什麼                     | 被誰殺                                                                   |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `paths-absolute`       | 絕對路徑也被接到專案底下     | `paths.test.ts`「絕對路徑原樣回傳」                                      |
| `addclip-media-exists` | 拿掉 mediaId 存在檢查        | `commands.test.ts`「未知 mediaId 被拒絕」                                |
| `addclip-bounds`       | 拿掉超界檢查（`if (false)`） | `commands.test.ts`「in + duration 超出素材長度被拒絕」                   |
| `addclip-duration`     | 允許 `duration<=0`           | `commands.test.ts`「duration <= 0 被拒絕」                               |
| `scan-hidden`          | 不排除隱藏檔                 | `sourceFolder.test.ts`「排除隱藏檔」                                     |
| `scan-isfile`          | 目錄也當檔案收               | `sourceFolder.test.ts`「略過子目錄本身」                                 |
| `scan-sort`            | 不排序                       | `sourceFolder.test.ts`「localeCompare 與位元組順序不同時仍正確排序」     |
| `import-basename`      | 拿掉 `basename` 防 traversal | `import-api.test.ts`「names 帶絕對路徑時同樣被 basename 擋下（誘餌檔）」 |

controller 指示再補 3 隻（Task 6／7 的新邏輯，複審時已實測「殺得掉」）：

| id                | 改了什麼                                                                                      | 被誰殺                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `import-serial`   | `/api/import` 的序列 `for...await` 迴圈整段改寫成 `Promise.all(names.map(async ...))`（併行） | `import-api.test.ts`「/api/import 逐支序列處理 names[]，不會併行呼叫 ingestMedia」；斷言 `maxInFlight===1`，突變後實測 `expected 3 to be 1` |
| `ingest-cleanup`  | 拿掉 `ingest.ts` 失敗時的 `rm(derivedAbs, { recursive: true, force: true })`                  | `ingest.test.ts`「proxy 編碼寫檔失敗時，mkdir 之後才建立的 derived 目錄也會被清掉」；斷言 `existsSync(derived/<固定id>)===false`            |
| `render-precheck` | `render.ts` 的缺檔預檢短路成 `if (false)`                                                     | `render.test.ts` 斷言 `/^render: 找不到素材原檔：/` 的兩條測試（既有一條＋本 Task 新增的 frozen clip 回歸測試）                             |

**`import-serial` 的特別記錄**：brief／controller 原本預期這隻可能是「結構改寫，
`scripts/mutate.mjs` 的 find/replace 表達不出來」，允許只在此處寫等價說明、不硬塞進
`mutants.json`。實際嘗試後發現**可以表達**——`mutate.mjs` 的 find/replace 是任意長度
字面字串比對，可以把整個 19 行的 `for` 迴圈區塊（含 try/catch 本體）當一個 find，
替換成語意等價、只改頭尾兩行的 `Promise.all` 版本。手動驗證時觀察到與複審者一致的
紅色輸出（`expected 3 to be 1`），於是正式收進清單而非留成文字記錄。它現在是
`scripts/mutants.json` 裡的一筆，任何人都能用 `node scripts/mutate.mjs import-serial`
就地重現這段紅燈。

## Failure Model 覆蓋情況

依 spec 的「錯誤處理」表逐條核對：

| 情況                             | 規劃行為                                   | 覆蓋狀態                                                                                                                                                                                                                                                                |
| -------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 素材夾不存在／非目錄             | `400 { error }`                            | **已覆蓋**——`source-api.test.ts`「目錄不存在回 400」；`sourceFolder.test.ts`「目錄不存在時丟錯」「傳入的是檔案而非目錄時丟錯」                                                                                                                                          |
| 素材夾無權限                     | `400 { error }`（與上面同一條 catch 路徑） | **已知限制**——與「目錄不存在」共用同一個錯誤處理分支，但沒有專屬測資模擬權限拒絕；Task 5 審查時已記錄的既有 minor deferred 項目，非本次新增缺口                                                                                                                         |
| 單一檔 probe 失敗                | 進 `failed[]`，其餘繼續                    | **已覆蓋**——`import-api.test.ts`「壞檔進 failed，其餘繼續」；真實執行層額外實測 `nope.mp4`（不存在的檔）進 `failed[]`，其餘兩支正常匯入                                                                                                                                 |
| ingest 中途失敗                  | 清掉該支 `derived/<id>/`，不留半成品       | **已覆蓋**——`ingest.test.ts` 兩條 + 本 Task 新增 `ingest-cleanup` 突變把它納入自動回歸                                                                                                                                                                                  |
| 已匯入但原檔被移走：素材庫標離線 | 列素材時對解析後路徑做一次 `existsSync`    | **已知限制／階段 2 範圍**——這屬於素材庫 UI 面板（spec 階段 2），階段 1 後端沒有這個 API 欄位，非本次遺漏，屬設計上延後                                                                                                                                                  |
| 已匯入但原檔被移走：輸出前檢查   | 輸出前檢查缺檔並回明確錯誤                 | **已覆蓋**——`render.test.ts` 兩條斷言 `/^render: 找不到素材原檔：/`（既有一條測非 frozen clip、本 Task 新增一條測 frozen clip，堵住預檢位置的回歸）+ `render-precheck` 突變                                                                                             |
| 審核進行中                       | 沿用既有守衛，不另立規則                   | **未變更，不在本次範圍**——新增的入口中，寫入 doc 的時間軸操作（`POST /api/import` 的 `addClip`，`app.ts:69`）走 `applyCommand('human', …)`，已逐行確認；素材登記（`ingestMedia`，`ingest.ts:143` 的 `store.mutate('ai', …)`）沿用既有例外、不入 command 層，spec 已核准 |

## 跳過與已知限制

- 併發匯入同一支素材：`ingestMedia` 冪等檢查是 read-then-write（先查 `doc.media` 有無
  該 `path`，查無才動手 ingest），未覆蓋兩個並發請求同時匯入同一支素材的競態。
- 巨大素材夾無上限、磁碟寫滿：未覆蓋。
- 既有的 8 條順序相依測試（`store-undo` / `store-durability`）：本次未觸碰，非新增。
- `updateClip` 與 `updateAudio` 另有兩處與 `addClip` 相同形狀的 `+ 1e-6` 浮點容差，
  只有 `addClip` 那處有 `addclip-bounds` 守著，另外兩處無 mutant 覆蓋（Task 3 就記下
  「Task 8 做突變時一併查」，見 `docs/ROADMAP.md` 第 11 條）。本次 controller 給的
  四點修正明確只把範圍限定在 `addClip`
  （`addclip-bounds`），為了不擅自擴大變更範圍，這裡只記錄觀察、未新增測試或
  mutant，留給後續 Task 決定是否要補。
- `GET /api/source?dir=` 的「無權限」400 分支沒有專屬測資（見上表）。
- ~~**純音訊檔目前必然進 `failed[]`**~~ ——**合併 `main` 後已解除**（`ecc5e0f` 放寬
  `probe`、純音訊跳過 proxy/filmstrip）。純音訊現在匯得進，見文末「補記：合併 main
  （純音訊匯入）」。剩下的限制改記在下一條。
- **`addToTimeline: true` 匯入純音訊會進 `failed[]`（素材其實已匯入）**：`addClip`
  只上視訊軌且擋 audio-only，所以 ingest 成功、`addClip` 被拒 → 整支記進 `failed[]`。
  視訊軌不會被污染（`import-api.test.ts` 守著），但呼叫端看到的是「失敗」而非
  「已匯入，只是沒排上時間軸」。要讓它自動上音訊軌需要一個新 command，屬產品決策，
  本輪不做。
- **無全域 ffmpeg 佇列**：Global Constraint「逐支序列」只在**單一** `/api/import`
  請求內成立（由 `import-api.test.ts` 的 `maxInFlight===1` 守），兩個併發
  `/api/import`、或 import 與 `render`／`transcribe` 併行時不成立——沒有跨請求的
  全域佇列。
- **`/api/import` 在「ingest 成功但 `addClip` 失敗」時把整支記進 `failed[]`，但
  `doc.media` 已有該素材、`derived/<id>/` 已產出**；重試會因 `ingestMedia` 的冪等
  檢查（同 `path` 回既有 id）回同一個 id，然後再撞一次同樣的 `addClip` 失敗，永遠
  再失敗一次。觸發條件是 `probe.duration` 為 0（`addClip` 的 `duration > 0` 檢查會
  拒絕）。

## 真實執行驗證（scratchpad 自建乾淨專案，非 `projects/demo`）

`:3845` 當時被另一個 session 佔用，`server/src/index.ts` 的 CLI 又不接受自訂 port，
改寫一支 4 行腳本直接呼叫 `startServer(dir, port)`（該函式本身支援自訂 port），
指到 `:3900`，專案目錄用全新空目錄（`ProjectStore.load` 對不存在的 `project.json`
會自動建空專案，僅印警告，不影響），素材夾內用 `ffmpeg testsrc2` 現產兩支
`.mp4`（2s／1s，320×568，h264）。

- `GET /api/source?dir=<素材夾>` → 回傳兩支檔案，`imported:false`。
- `POST /api/import`（`names` 含一支不存在的 `nope.mp4`，`addToTimeline:true`）→
  兩支成功進 `ok[]`（各自分配 `mediaId`），`nope.mp4` 進 `failed[]`（真實
  `ffprobe exited 1: ... No such file or directory` 錯誤）。
- 再打一次 `GET /api/source`：已匯入的兩支 `imported` 變 `true`。
- `GET /api/project`：`doc.media[*].path` 就是素材夾內的原始絕對路徑（零複製，
  沒有被複製進專案目錄）；`doc.tracks.video` 已有兩個 clip（`addToTimeline` 生效）。
- `derived/<mediaId>/{proxy.mp4,filmstrip.jpg,peaks.json}` 兩支都確實在專案目錄內
  產出（真 ffmpeg，非 mock）。

這一層沒有跳過。上面五條就是那次執行的完整結果記錄；逐條 curl 的原始請求／回應是過程
檔，不隨分支保留，但整套程序（自訂 port 起 server → `testsrc2` 造素材 → 三支 API 依序
打）在上一段已寫成可照做的步驟，重跑不需要那份記錄。

## 需要你親自驗

- 用真實手機素材（非 `testsrc2` 合成片）跑一次完整匯入，確認各種常見編碼／容器
  （HEVC、直式手機拍攝的旋轉 metadata）下 `ingestMedia` 的 proxy/filmstrip/peaks
  都正常產出。
- 確認外部素材（零複製引用）輸出的畫質與原檔一致（本次驗證只測了「有沒有輸出」，
  沒有逐幀比對畫質）。
- 素材夾內含大量檔案（數百支以上）時 `GET /api/source` 的實際延遲——目前沒有上限
  防護，也沒有效能測試。

---

# 補記：素材匯入 階段 1 — 全分支審查最終修復輪（2026-08-03）

依全分支審查（讀完整 diff + 打突變實跑）的四項必修 + 五項一併修小項。
本輪不改任何素材夾白名單或音訊 ingest 行為（使用者已決定另案處理）。

## 必修一：`render.ts` 兩處 `resolveMediaPath` 呼叫點零測試守護

審查者實測：把 `render.ts:222`（獨立音訊項 input）與 `render.ts:431`（定格幀擷取來源）
的 `resolveMediaPath(projectDir, media.path)` 手動改回 `join(projectDir, media.path)`，
當時全套 server 測試（201 條）**兩隻突變都存活**。

**紅燈證據**（新測試先寫、對兩處手動套用 mutant 後跑 `npx vitest run test/render.test.ts`）：

```
× buildRenderArgs > uses an absolute audio-item media path as-is instead of joining it under projectDir (render.ts:222)
  → expected [ '-ss', '1', '-t', '3', '-i', …(32) ] to include '/outside/vo.mp3'
× render (integration) > frozen clip 用專案外絕對路徑素材時仍能定格擷取成功（render.ts:431）
  → ffmpeg exited 254: Error opening input: No such file or directory
    /var/folders/.../vidcut-ext-frozen-proj-.../var/folders/.../vidcut-ext-frozen-.../ext-frozen.mp4
 Test Files  1 failed (1)
      Tests  2 failed | 7 passed (9)
```

還原後（`resolveMediaPath` 恢復）：`Test Files 1 passed (1)`，`Tests 9 passed (9)`。

新增測試：

- `server/test/render.test.ts`「uses an absolute audio-item media path as-is instead of
  joining it under projectDir (render.ts:222)」——`buildRenderArgs` 純函數斷言，不跑 ffmpeg。
- `server/test/render.test.ts`「frozen clip 用專案外絕對路徑素材時仍能定格擷取成功
  （render.ts:431）」——整合測試，真 ffmpeg，外部絕對路徑素材 + `frozen:true` 的 clip。

新增 mutants（`scripts/mutants.json`）：`render-audio-input-path`、`render-frozen-src-path`。
`node scripts/mutate.mjs render-audio-input-path render-frozen-src-path`：

```
✔ render-audio-input-path  …純函數斷言必須抓到
✔ render-frozen-src-path  …整合測試（真 ffmpeg）必須抓到

2/2 mutants killed
```

## 必修二：`addClip` 的 `cmd.in < 0` 守衛無測試

`in=-1, duration=1` 會通過超界檢查（`-1+1=0 <= 素材長度`），若無此守衛會讓 ffmpeg 收到
`-ss -1`。紅燈證據（手動拿掉 `commands.ts:217` 的守衛後跑該條測試）：

```
× addClip > 負的 in 被拒絕（in=-1, duration=1 若無此守衛…）
  AssertionError: expected true to be false
```

還原後：`Tests 21 passed (21)`。

新增測試：`server/test/commands.test.ts`「addClip」describe 區塊「負的 in 被拒絕…」。
新增 mutant `addclip-in-negative`（拿掉守衛整行）：

```
✔ addclip-in-negative  …負的 in 被拒絕的斷言必須抓到
```

## 必修三：EVIDENCE 呼叫端數字修正

「補記：素材匯入 階段 1」節前言與行為對映表原寫「原本四處 `join(projectDir,
media.path)`」；實際 `resolveMediaPath` 呼叫點是 **8 處**：`render.ts:201/222/407/431/523`、
`ingest.ts:33`、`asr.ts:89/96`。已在該節就地修正數字，並新增「`resolveMediaPath`
呼叫點逐處守護情形」表逐處列出測試／mutant；`render.ts:523`（`extractCover`）標為
等價突變（`proxyPath ?? path`，`proxyPath` 因 `ingestMedia` 必寫而恆存在，故該處在
今日可達輸入下 `resolveMediaPath` 與 `join` 行為相同），不加無意義測試/mutant。

## 一併修的小項

1. **`server/src/frame.ts:20,30`**（`extractFrame`）換成 `resolveMediaPath`——與
   `render.ts:523` 同一運算式、同一防禦性一致化理由，今日不可達（`ingestMedia`
   是唯一寫 `doc.media` 的地方且必寫 `proxyPath`）。未加 mutant（會存活，違反
   anti-gaming 規則）。`npx vitest run test/mcp-tools.test.ts -t get_frame` 與
   `npx tsc --noEmit -p server` 皆通過，確認未破壞既有行為。
2. **spec 文字修正**：`docs/superpowers/specs/2026-08-03-media-import-design.md`
   的「不做（YAGNI）」段落拿掉「仍拒絕 `..`」（程式碼裡沒有這個檢查，也不需要——
   `dir` 本來就吃任意絕對路徑，`..` 不會多給權限，沒有安全後果）。
3. **`HANDOFF.md` 程式碼地圖**補上 `server/src/paths.ts`、`server/src/sourceFolder.ts`
   兩行，並新增 `server/src/app.ts` 一行（原本整個程式碼地圖沒有這個檔案，
   即使它是 `/api/project`／`GET /api/source`／`POST /api/import`／`POST /assets`／
   `/media/*` 的掛載點）。
4. **EVIDENCE failure model 措辭修正**：「審核進行中」列原寫「本階段沒有新增寫入
   路徑繞過 `applyCommand`／`aiWrite`」，改為區分兩種入口的誠實措辭——時間軸操作
   走 `applyCommand('human')`，素材登記沿用既有 `ingestMedia` 的 `store.mutate`
   （spec 已核准的既有例外，不入 command 層）。
5. **EVIDENCE 已知限制補三行**：純音訊檔必進 `failed[]`（連帶「引用外部 BGM/旁白」
   整條路不通）、無全域 ffmpeg 佇列（僅單一 `/api/import` 請求內序列）、
   ingest 成功但 `addClip` 失敗時的重試會永遠再失敗一次（`probe.duration===0` 觸發）。
   純記錄，未動程式碼。
6. **`docs/ROADMAP.md`「可行方向」補兩條**：音訊素材支援（放寬 probe、純音訊跳過
   proxy/filmstrip）；Origin/Host header 檢查（`GET /api/source` 在 DNS rebinding 下
   可被任意網頁觸發目錄列舉——本分支新增的能力面）。

## 明確未做的事（依 controller 指示）

- 未動素材夾白名單、未實作音訊 ingest。
- 未動 `scripts/gauntlet.sh`，未放寬任何關卡。
- 未動 `commands.ts:155`（`updateClip`）與 `:497`（`updateAudio`）的 `1e-6` 容差。
- 未為不可達分支（`frame.ts`）加會存活的 mutant。

## 最終乾淨 GAUNTLET（本輪最後一次程式碼／文件修改之後，`bash scripts/gauntlet.sh` 完整版）

第一次執行（於 `frame.ts` 格式化修正**之前**啟動）在「格式 (prettier --check)」關卡回報
FAIL——`server/src/frame.ts` 的新 import／註解未跑過 prettier（那輪的修復指示裡
「新測試一律先跑到紅再實作」只涵蓋 §必修一/二兩條測試的紅燈證明，不涵蓋收尾的格式關卡；
發現後立刻 `npx prettier --write` 修正，非放寬關卡）。修正後重跑一次完整版，是下表**唯一
引用的一次**：

| 關卡                     | 結果                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本                     | node v22.18.0／npm 11.5.2／tsc 5.9.3／vitest 3.2.7／ffmpeg 8.1.2／source `b6adcfb`                                                                                                                                                                                                                                                                                                    |
| 型別檢查（tsc ×3）       | PASS                                                                                                                                                                                                                                                                                                                                                                                  |
| Lint（eslint）           | PASS                                                                                                                                                                                                                                                                                                                                                                                  |
| 格式（prettier --check） | PASS                                                                                                                                                                                                                                                                                                                                                                                  |
| 全測試套件               | **401 passed**（shared 27／server 204／ui 170），0 failed——server 較本輪修復前多 3（新增 render.ts:222 純函數測試＋render.ts:431 整合測試＋addClip in<0 守衛測試）                                                                                                                                                                                                                    |
| UI 覆蓋率                | Statements/Lines 86.38%（2627/3041）、Branches 85.48%（748/875）、Functions 65.28%（126/193）——與修復前相同，本輪未動 UI                                                                                                                                                                                                                                                              |
| 隨機順序                 | ui／server 皆 PASS                                                                                                                                                                                                                                                                                                                                                                    |
| 依賴稽核                 | `npm audit --audit-level=high` 沿用既有 baseline（`fast-uri` 3.0.0–3.1.4，兩個既有 high，非本輪新增；gauntlet.sh 對此關卡不設 pass/fail gate，只如實印出）                                                                                                                                                                                                                            |
| 秘密掃描                 | PASS                                                                                                                                                                                                                                                                                                                                                                                  |
| 突變測試                 | **65 killed + 1 equivalent control**（`store-corrupt-load`，如實存活）＝`scripts/mutants.json` 全部 66 隻；本輪新增 3 隻（`render-audio-input-path`／`render-frozen-src-path`／`addclip-in-negative`）全部在此次完整執行內被殺，`gauntlet.sh` 的 `tail -3` 只印最後一隻（`addclip-in-negative`），完整逐隻輸出見下方「必修一/二」章節內單獨執行 `node scripts/mutate.mjs <id>` 的紀錄 |
| 總結                     | `GAUNTLET: 全數通過`                                                                                                                                                                                                                                                                                                                                                                  |

## 本輪 commit

上表 GAUNTLET 於 `b6adcfb`（工作區含本輪未提交修改）執行；本輪修改只涉及測試檔、
`scripts/mutants.json` 與文件，不動任何 `server/src/render.ts`／`server/src/commands.ts`
的實作程式碼（審查認定「程式碼本身是對的，缺的是守護」）；`server/src/frame.ts` 是
本輪唯一動到的實作檔（小項 1 的防禦性一致化）。本輪 commit 是 `1d2049d`，動到的路徑
即該 commit 的 diff（`git show --stat 1d2049d`）。

**複審（`b6adcfb..1d2049d`）**：合併前最後一關，2026-08-03 完成。在**真正的 HEAD
`1d2049d`**（非上表的 `b6adcfb` 工作區狀態）實跑完整 `bash scripts/gauntlet.sh`：
`GAUNTLET: 全數通過`、401 測試（shared 27／server 204／ui 170）、
`65/65 mutants killed (+1 equivalent control survived as expected)`——與上表逐格吻合。
必修一另做獨立驗證：把 `render.ts:222` 與 `:431` 兩處同時改回
`join(projectDir, media.path)`，跑全套 204 條 server 測試 → `Tests 2 failed | 202 passed`，
紅的恰為本輪新增那兩條（一條 `AssertionError … to include '/outside/vo.mp3'`、
一條 `ffmpeg exited 254: Error opening input`）——即全分支審查者當初實測「兩隻都存活」
的同一實驗，現已守住。

> UI 覆蓋率的 Branches 一格在同一 commit、同一乾淨工作區連跑兩次會得到
> `748/875` 與 `749/876`（v8 覆蓋率分支計數非決定性）；Statements／Lines／Functions
> 三項完全穩定。上表引用的是其中一次的真實數字。

## 補記：合併 main（純音訊匯入）

`main` 的 `ecc5e0f`（mono 升混 −3dB 修正／純音訊匯入／MCP 描述同步）與本分支平行開發，
動到同一批檔案。合併 commit `15c81a6`，四處衝突逐一手工疊合：

| 檔案             | 兩邊各自長出的東西                                    | 疊合方式                                                                                                                                                |
| ---------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingest.ts`      | 本分支：try/catch 失敗清理（Task 7）／main：audioOnly | 保留 try/catch，把 audioOnly 疊進去。**判定與丟錯移到 `mkdir` 之前**——main 原本放在之後，無可用串流時會留下空的 `derived/` 目錄，與 Task 7 相牴觸       |
| `render.ts`      | 本分支：缺檔預檢／main：補測 `audioChannels`          | 預檢排在補測之前（補測的 `catch` 會吞錯，先擋才給得出明確訊息）。**並把 main 新寫的 `join(projectDir, m.path)` 換成 `resolveMediaPath`**——第 9 個呼叫點 |
| `mcp.ts`         | `import_media` 描述兩邊各自改寫                       | 合併兩邊事實（零複製絕對路徑＋純音訊跳過 proxy），依 CLAUDE.md「改行為必同步 MCP 描述」鐵則                                                             |
| `ingest.test.ts` | import 清單                                           | 取聯集                                                                                                                                                  |

### 合併長出來的兩個整合缺口（都用 TDD 補，commit `d30aace`）

1. **`addClip` 沒擋 audio-only**。main 的守衛只在 MCP 的 `set_timeline`（`mcp.ts:334`），
   但 `addClip` 是本分支新增的**第二條**上視訊軌的路，且 `POST /api/import` 的
   `addToTimeline` 直接呼叫它——匯入一支 `.mp3` 就會把純音訊放上視訊軌，渲染時 ffmpeg 才炸。
   紅燈實測：`expect(r.ok).toBe(false)` → `AssertionError: expected true to be false`。
   新增 mutant `addclip-audio-only`（實跑，殺）。
2. **第 9 個 `resolveMediaPath` 呼叫點不可觀測**。渲染前補測 `audioChannels` 那段的
   `catch` 會吞掉 probe 失敗，接法退回 `join` 只會讓外部絕對路徑素材**靜默**不升混
   （成品小 3dB，無任何錯誤訊息）。抽成具名匯出 `withProbedChannels`（行為不變）才守得住。
   新增 mutant `render-probe-channels-path`（實跑，殺）。

### 音訊端到端（`import-api.test.ts`，真 ffmpeg）

- 素材夾的 `.mp3` 被 `GET /api/source` 列得到；`POST /api/import` 匯得進，
  `media.path` 是素材夾內的絕對路徑（零複製，原檔不動）、`hasVideo:false`、
  **無 `proxyPath`／`filmstripPath`、有 `peaksPath` 且檔案真的產出**。
- `addToTimeline: true` 時視訊軌保持空的，`failed[0].error` 含 `audio-only`。

**紅燈驗證（證明這兩條測的是合併產物，不是既有行為）**：在合併前的複本（`1d2049d`）
對同一支 `.mp3` 直接呼叫 `probe` 與 `ingestMedia`，兩者都丟
`no video stream in …/bgm.mp3`——合併前純音訊匯入 100% 不可能。

### 合併後的 GAUNTLET（`bash scripts/gauntlet.sh`，source `d30aace`）

| 關卡                     | 結果                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本                     | node v22.18.0／npm 11.5.2／tsc 5.9.3／vitest 3.2.7／ffmpeg 8.1.2／source `d30aace`                                                                            |
| 型別檢查（tsc ×3）       | PASS                                                                                                                                                          |
| Lint（eslint）           | PASS                                                                                                                                                          |
| 格式（prettier --check） | PASS                                                                                                                                                          |
| 全測試套件               | **412 passed**（shared 27／server 215／ui 170），0 failed——server 較合併前的 204 多 11（main 帶進 7、本輪整合修正新增 4）                                     |
| UI 覆蓋率                | Statements/Lines 86.38%（2627/3041）、Branches 85.48%（748/875）、Functions 65.28%（126/193）——未動 UI                                                        |
| 隨機順序                 | ui／server 皆 PASS                                                                                                                                            |
| 依賴稽核                 | 沿用既有 baseline（`fast-uri`，非本輪新增；gauntlet 對此關卡不設 gate）                                                                                       |
| 秘密掃描                 | PASS                                                                                                                                                          |
| 突變測試                 | **67 killed + 1 equivalent control**（`store-corrupt-load`，如實存活）＝全部 68 隻；本輪新增 2 隻（`addclip-audio-only`／`render-probe-channels-path`）皆被殺 |
| 總結                     | `GAUNTLET: 全數通過`                                                                                                                                          |

上表於 `d30aace` 執行，本節文件（EVIDENCE／HANDOFF／ROADMAP）在其後落筆——沿用
`EVIDENCE.md` 既有慣例（見「補記三」同樣寫法）：GAUNTLET 執行早於收錄它的 commit，
且該輪之後只動文件、未動任何程式碼或測試。

---

# 補記：MCP 面補完（2026-08-03）

Spec：`docs/superpowers/specs/2026-08-03-mcp-surface-completion-design.md`。分 8 個
Task（各有獨立審查與修復迴圈）+ 兩個計劃外的套件穩定性修復（Task 7b／7c，controller
決定加入，理由見下方「三」）。來源狀態：commit `7e660f3`（Task 1–8 程式碼變更最終
commit；本節文字於其後、其上落筆，未再改動任何程式碼）。

## 一、行為 → 測試對映（spec 21 條驗收條件）

### `list_source`（AC 1–6）

| AC  | 條件                                                                    | 測試（檔案:行號）                                                                                                                                      |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 素材夾有 3 支白名單檔 → 回 3 筆，含 `name`/`size`/`mtime`，依 name 排序 | `server/test/mcp-tools.test.ts:252`「列出素材夾內的白名單檔案並標記已匯入者」                                                                          |
| 2   | 其中一支已匯入 → 該筆 `imported: true`，其餘 `false`                    | `server/test/mcp-tools.test.ts:270`「已匯入的素材標 imported: true」                                                                                   |
| 3   | 已匯入的是相對路徑素材 → `imported` 仍正確（解析後比對）                | 同上（`beforeAll` 匯入的是專案內相對路徑 `a.mp4`，同一條測試覆蓋）                                                                                     |
| 4   | 目錄不存在 → `isError`，訊息可讀                                        | `server/test/mcp-tools.test.ts:277`「目錄不存在 → isError」（含 Task 4 修復輪補的 `list_source failed:` 前綴斷言，區分「工具不存在」與「目錄不存在」） |
| 5   | 250 支檔 → 只內嵌前 200 筆，`truncated: true`，`total: 250`             | `server/test/mcp-tools.test.ts:286`「超過 200 筆只內嵌前 200 筆並標 truncated」                                                                        |
| 6   | 工具 metadata 標 `readOnlyHint: true`                                   | `server/test/mcp-tools.test.ts:302`「標 readOnlyHint: true（唯讀工具）」                                                                               |

### `add_clip`（AC 7–13）

| AC  | 條件                                                                 | 測試（檔案:行號）                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 7   | 合法呼叫 → `ok`，`tracks.video` 尾端多一個 clip，回覆含新 clip 的 id | `server/test/mcp-tools.test.ts:310`「接到主軌尾端，回新 clip 的 id」                                                                                                                                                                 |
| 8   | 回覆裡的 id === `tracks.video.at(-1).id`                             | 同上（`server/test/mcp-tools.test.ts:317`）——**該斷言本身是套套邏輯**（兩邊用同一個 `.at(-1)` 讀同一份狀態，恆真）；把 `push` 改 `unshift` 時真正轉紅的是鄰行的 `label` 斷言，那條才是獨立 oracle。已登記 `docs/ROADMAP.md` 第 11 條 |
| 9   | `mediaId` 不存在 → `isError`                                         | `server/test/mcp-tools.test.ts:321`「mediaId 不存在 → isError，主軌不變」——**假綠，見下「二」第 2 點**                                                                                                                               |
| 10  | 純音訊素材（`hasVideo: false`）→ `isError`，訊息含 `audio-only`      | `server/test/mcp-tools.test.ts:334`「純音訊素材 → isError，訊息含 audio-only」                                                                                                                                                       |
| 11  | `in + duration` 超過素材長度 → `isError`                             | `server/test/mcp-tools.test.ts:328`「in + duration 超過素材長度 → isError」——**假綠，見下「二」第 2 點**                                                                                                                             |
| 12  | 審核進行中 → `isError`（`aiWrite` 守衛生效）                         | `server/test/mcp-tools.test.ts:356`「審核進行中 → isError」——**有測試守護，無 mutant 覆蓋**（理由見下「二」）                                                                                                                        |
| 13  | 過期 `ifVersion` → `isError`（`aiWrite` 守衛生效）                   | `server/test/mcp-tools.test.ts:371`「過期的 ifVersion → isError」——由 mutant `addclip-mcp-ifversion` 守                                                                                                                              |

### `setAudio` 驗證（AC 14–20）

| AC  | 條件                                                     | 測試（檔案:行號）                                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 14  | `audio: []` → `ok`，音訊軌清空（既有行為必須不變）       | `server/test/commands.test.ts:431`「audio: [] 清空音訊軌（既有行為，不得因新驗證而破壞）」                                                                                                                                                                                                                            |
| 15  | 合法 item（真實 `mediaId`、在界內）→ `ok`                | `server/test/commands.test.ts:409`「剛好用滿素材長度是允許的（1e-6 容差，與 addClip 一致）」（邊界情形，見 AC19）                                                                                                                                                                                                     |
| 16  | `mediaId` 不存在 → `ok: false`，音訊軌**維持原樣**       | `server/test/commands.test.ts:368`「mediaId 不存在 → 拒絕，且音訊軌維持原樣（不得半套寫入）」                                                                                                                                                                                                                         |
| 17  | `duration <= 0` → `ok: false`                            | `server/test/commands.test.ts:382`「duration <= 0 → 拒絕」                                                                                                                                                                                                                                                            |
| 18  | `in < 0` → `ok: false`                                   | `server/test/commands.test.ts:391`「負的 in → 拒絕」                                                                                                                                                                                                                                                                  |
| 19  | `in + duration` 剛好等於素材長度 → `ok`（1e-6 容差保護） | `server/test/commands.test.ts:409`「剛好用滿素材長度是允許的（1e-6 容差，與 addClip 一致）」——殺傷力由一次性突變證明：把 `setAudio` 那處容差改成 `- 1e-6` 重跑，僅此條轉紅、其餘 28 條（含另一條立即通過的測試）仍綠。這隻是拋棄式的、未收進 `mutants.json`，要複核請照上句手改 `commands.ts` 重跑 `commands.test.ts` |
| 20  | 多個 item 其中一個壞 → 整批拒，音訊軌維持原樣            | `server/test/commands.test.ts:418`「多個 item 其中一個壞 → 整批拒，音訊軌維持原樣」                                                                                                                                                                                                                                   |

mutant `setaudio-validate`（拿掉整段逐項驗證）守住 AC16–20 的拒絕路徑，實跑 1/1 killed（見下「四」）。

### 錯誤訊息（AC 21）

| AC  | 條件                                                                                | 測試（檔案:行號）                                                                             |
| --- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 21  | `tracks.audio` 有壞 `mediaId` 時 render → 錯誤訊息同時含 audio item id 與 `mediaId` | `server/test/render.test.ts:131`「音訊素材找不到時，錯誤訊息同時含 audio item id 與 mediaId」 |

## 二、誠實記錄無 mutant 覆蓋者

1. **`add_clip` 的「審核進行中被拒」路徑（AC12，`server/test/mcp-tools.test.ts:356`）
   ——無 mutant 覆蓋，而且本報告先前給的理由是錯的**。原本的說法是：能表達它的
   find/replace 是把 `aiWrite(store, cmd, ifVersion)` 換成 `applyCommand(store, 'ai', cmd)`，
   但 `applyCommand` 沒有被 `mcp.ts` import，突變版會在執行期丟 `ReferenceError`，於是
   先被快樂路徑測試殺掉、變成**錯誤歸因**，所以「無法做出有效 mutant」。

   **最終全分支審查推翻了這個結論**：改用動態 import 就完全繞開沒有 import 的問題——
   `replace` 寫成 `const r = (await import('./commands.js')).applyCommand(store, 'ai', cmd);`
   （`mcp.ts` 那行本來就在 `async` 回呼裡，`await` 合法）。審查者實跑後，轉紅的只有
   AC12 與 AC13 兩條守衛測試，快樂路徑全程維持綠——歸因完全正確，是一隻**有效**
   mutant。也就是說 AC12 目前沒有 mutant 覆蓋，**不是因為做不到，只是本輪沒做**。
   已把它連同上面這段可直接照抄的 `replace` 字串登記到 `docs/ROADMAP.md` 第 11 條。

2. **`add_clip` 的 AC9（`mediaId` 不存在）與 AC11（超界）是「假綠」**：這兩條測試斷言
   的是「呼叫回 `isError`」，但 MCP 的 SDK 在**工具根本不存在**時同樣回 `isError`。審查
   者把 `add_clip` 這個工具名改掉後，兩條測試照樣通過——它們無法區分「守衛擋下來」與
   「工具消失了」。相較之下 AC4（`list_source` 目錄不存在）在 Task 4 修復輪補了
   `list_source failed:` 前綴斷言，正是為了堵這個洞；`add_clip` 這兩條沒有比照辦理。
   守衛本身的行為由 `commands.ts` 層的同名測試涵蓋（`commands.test.ts` 的「未知 mediaId
   被拒絕」「in + duration 超出素材長度被拒絕」，且有 `addclip-media-exists`／
   `addclip-bounds` 兩隻 mutant 守著），所以**功能有驗證**，但 MCP 這一層的這兩條斷言
   不構成獨立保護。修法是加上訊息內容斷言，已登記到 `docs/ROADMAP.md` 第 11 條。

3. **render 錯誤訊息字串（AC21，`server/test/render.test.ts:131`）**：這條新測試本身
   就是唯一守護——它直接斷言錯誤訊息同時含 audio item id 與 `mediaId`。RED 階段觀察到
   的實際訊息是 `'render: media not found for audio bgm1'`，只含 `bgm1` 不含 `GHOST_ID`，
   所以這條測試確實看過自己失敗。再打一隻 mutant 只是把同一條斷言換句話說重述一次，
   不會多驗證到任何東西，故本案不加。

## 三、套件穩定性問題的完整因果

專案期間出現兩個症狀，**它們是同一個病**：

- **症狀 A**：`server/test/import-api.test.ts` 的 `POST /api/import` 前 6 條測試
  （第 50/63/74/85/93/129 行）偶發失敗（審查者與實作者合計約 1/5 重現率），失敗訊息
  是 `Test timed out in 5000ms.`——**不是斷言失敗**。
- **症狀 B**：gauntlet 的「隨機順序」關卡失敗——`--sequence.shuffle --sequence.seed=1337`
  下 `render (integration) > renders the demo project…` 跑了**958 秒**，撞破自己 180
  秒的 wall-clock timeout；一般循序執行同一份測試只要 32 秒、全過。

**共同根因**：`server/` 原本沒有任何 vitest 設定檔 → 測試檔預設平行執行。25 個測試檔
中 **9 個會 spawn 真 ffmpeg**，而單支 ffmpeg 的 x264 編碼預設就開滿核心數的執行緒。
實測正常執行時峰值 **7 支 ffmpeg 併發、load 16.83**（8 核機器，controller 診斷階段、
正常順序、有平行時量到的數字）。最重的測試內部要連跑約 **22 支 ffmpeg**。vitest 的
timeout 是 wall-clock 時間，所以測試沒有卡住、只是被餓死，也照樣算 timeout——這解釋
了兩個症狀為何長得不一樣（一個是 5 秒被砍、一個是 180 秒被砍）卻是同一個根因：CPU
被瓜分到測試進度極慢。

（下文「修復後如何驗證」會再出現幾個不同的併發峰值數字——8／4／16／15 支，分別來自
審查者在不同條件下的量測，跟這裡的 7 支不是同一次執行。併發峰值本身會隨當下機器負載
浮動，這些數字不互相矛盾，只是分屬不同次量測，見下方逐一標明。）

**決定性實驗**（controller 在診斷階段做的根因確認，早於 Task 7c 的正式修復與驗證）：
同一 seed（1337）只加 `--fileParallelism=false` → 238/238 全過、51 秒——證實假設成立，
才據此定案修法方向。這個 51 秒是診斷階段的單次測量，與下方「修復後如何驗證」裡實作者
正式跑出的 seed 1337 耗時（100.1 秒，仍遠低於 180 秒 timeout）不是同一次執行，數字有
落差是不同時間點機器負載不同所致，不是矛盾——兩次都是 238/238 全過、無 timeout。
（兩次都是過程檔，不隨分支保留；重跑方式就是上面那行指令。）

**兩次修復，分工不同**：

- `f109e13`（症狀 A，補 `import-api.test.ts` 前 6 條 `60_000` timeout，回歸同檔其餘
  真-ffmpeg 測試的既有慣例）是**治標**——只治了一個檔案，讓那 6 條在同樣的 CPU 競爭
  下有更寬裕的牆可以撐過去，沒有解決 CPU 被瓜分的根因。
- `7e660f3`（新增 `server/vitest.config.ts` 設 `fileParallelism: false`）才是**治本**
  ——直接消除檔案層的併發競爭，讓 ffmpeg 子行程不再互搶核心。
- **`f109e13` 可能反而推了一把**：那 6 條原本 5 秒就被 vitest 判定 timeout 並砍掉、
  提早釋放 CPU 給其他同時在跑的測試檔用；放寬成 60 秒後，它們會撐著跑完，在高競爭
  情境下佔用 CPU 的時間反而更長，讓其他測試（包含彼此之間）的競爭更久、更容易被
  拖過各自的 timeout。這是本節要求「不要只寫治本那一半」的原因：兩次修復不是簡單的
  「先小修再大修」，第一次修法本身可能加劇了第二次要解決的問題。

**修復後如何驗證**——實作者與獨立審查者各自做了不同層次的驗證，出處分開列，
避免混淆：

- **實作者**（Task 7c 實作者的驗證；過程檔，不隨分支保留）：一般循序執行 +
  `--sequence.shuffle` 的 4 個 seed
  （gauntlet 用的 1337、以及 1／42／99999），共 5 種順序組合全部 238/238 通過、無
  timeout；`npm run typecheck`／`npm run lint`／`npx prettier --check` 三項皆乾淨。
  typecheck 未受影響的原因：`server/vitest.config.ts` 不在 `server/tsconfig.json` 的
  `include: ["src", "test"]` 範圍內，新檔案不會觸發任何型別檢查問題。
- **獨立審查者**（Task 7c 審查者自己另做的量測，與上一項不是同一批數字；這些數字原本
  只存在於審查者的回報訊息裡，本報告是它們唯一的落盤處——過程檔，不隨分支保留）：
  另外自選 2 個 seed（7、2024）加上 gauntlet 用的 1337，共 3 個 seed
  覆核，皆 238/238（seed 1337／7／2024 個別最重的 render 測試分別是 10.9／10.8／
  11.7 秒）。做了**負向對照組**——把 `server/vitest.config.ts` 拿掉，在**自然條件下
  （未額外加壓）重跑兩次**：第一次 238/238 通過，wall 40.54 秒、tests 累計 104.25
  秒，併發 ffmpeg 峰值 **8 支**，最重 render 測試 18.3 秒；第二次同樣 238/238 通過，
  峰值 **4 支**，最重 render 測試 17.8 秒——同一份未修法的程式碼，兩次自然執行量到
  的併發峰值就差了一倍，**958 秒的最壞情況兩次都沒有重現**。這說明這個失敗本質是
  **機率性的**——不是每次都踩到，而是排隊時機剛好湊在一起時才會爆，跟上方「症狀 B」
  提到的「一般循序執行同一份測試只要 32 秒、全過」是同一件事的兩個面向：觸發需要
  隨機順序＋不巧的排隊時機同時發生，這正是 gauntlet 要保留「隨機順序」這一關的理由。
  也正因為自然條件下兩次都沒重現，**光憑負向對照組不足以證明修法真的有效**——審查者
  因此另外做了**8x 外部加壓對照**：對機器背景加壓 8 支 veryslow preset 的 ffmpeg 把
  CPU 徹底佔滿後量測，無修法時併發峰值衝到 **16 支**、最重 render 測試耗時
  142,954ms（142.9 秒，吃掉 180 秒 timeout 預算的 79%）；有修法時峰值 **15 支**、
  115,584ms（115.6 秒，64%）——同等外部壓力下有修法多出約 30 秒餘裕（快約 19%），
  **這才是真正證明修法有實測效果、不是巧合的那個實驗**。
- **審查者的獨立意見與此修法的邊界**（同樣出自該審查者的回報，過程檔，不隨分支保留）：`maxWorkers: 2`
  這類折衷方案不會更好——單一測試檔內部本來就會併發多支 ffmpeg 子行程，限制 worker
  數解決不了「一支 ffmpeg 吃滿所有核心」這個根本矛盾。審查者也誠實指出此修法的真實
  限制：它只涵蓋**套件自身**的檔案間並行競爭，對「開發者機器上同時有其他重活」這類
  **外部**負載沒有防護；`render.test.ts` 那條 180 秒的 wall-clock timeout 常數在較慢
  的機器上，即使有這個修法，仍可能吃緊。

**這件事對 EVIDENCE 的意義**：old-coder 的整套論述建立在「測試套件是決定性的」這個
前提上。這個不穩定在專案期間被多位審查者跨 Task 觀察到，如果默默修掉、不寫進報告，
讀者無從判斷本報告裡那些「238/238」「236/236」之類的數字在多大程度上可信。本節把
症狀、根因、兩次修復的分工、驗證方式完整攤開，
就是為了不讓這個風險被隱藏。

## 四、本案新增的 3 隻 mutant 與實跑結果

三隻都在 `scripts/mutants.json` 裡，各自可用 `node scripts/mutate.mjs <id>` 單獨重跑。

| id                      | 檔案          | 改了什麼                                             | 被誰殺                                                          | 單獨實跑結果 |
| ----------------------- | ------------- | ---------------------------------------------------- | --------------------------------------------------------------- | ------------ |
| `setaudio-validate`     | `commands.ts` | 拿掉 `setAudio` 的逐項驗證整段（find/replace 清空）  | `commands.test.ts`「setAudio 驗證」describe 全部 7 條           | 1/1 killed   |
| `listsource-truncate`   | `mcp.ts`      | 拿掉 200 筆截斷（改成 `files = all.files` 不 slice） | `mcp-tools.test.ts`「超過 200 筆只內嵌前 200 筆並標 truncated」 | 1/1 killed   |
| `addclip-mcp-ifversion` | `mcp.ts`      | `aiWrite(store, cmd, ifVersion)` 少傳 `ifVersion`    | `mcp-tools.test.ts`「過期的 ifVersion → isError」               | 1/1 killed   |

三隻皆在本節「六、GAUNTLET 表」引用的那次完整執行中，隨其餘 67 隻一起被殺（gauntlet
log 的 `tail -3` 只印出最後一隻的名稱 `addclip-mcp-ifversion`，逐隻結果彙總為
`70/70 mutants killed`）。

## 五、行為變更聲明：`setAudio` 從零驗證到逐項驗證

**這是本專案唯一的行為變更**——`8af9bf5`（`fix(commands): setAudio 補逐項驗證，與
addClip 對稱`）之前，任何不存在的 `mediaId`、負值、超界的音訊項都會被默默接受並落盤，
直到 render 時才炸；改動後這些壞資料在寫入當下就被拒絕（`ok: false`，音訊軌維持原樣，
見 AC16–20）。

查證結果分兩層——**生產程式碼**（誰會建構 `setAudio` 命令物件）與**測試**（誰呼叫
`set_audio` 這個 MCP 工具、驗證新驗證不會擋到既有用法）：

```
$ grep -rn "setAudio\|set_audio" server/src server/test | grep -v node_modules
server/src/mcp.ts:700:          'set_audio',
server/src/mcp.ts:706:      writeReply(aiWrite(store, { name: 'setAudio', audio: audio as AudioItem[] }, ifVersion)),
server/src/commands.ts:109:    case 'setAudio': {                                    # 驗證/執行端，非呼叫端
server/test/mcp-optim.test.ts:262:    await call('set_audio', { audio: [...] });      # 傳真實 mediaId
server/test/mcp-tools.test.ts:175:    await call('set_audio', { audio: [] });         # 清空音訊軌
server/test/mcp-tools.test.ts:388:      'set_audio',                                  # instructions 守衛測試裡的字串，非呼叫
```

- **生產程式碼裡建構 `setAudio` 命令物件的呼叫點只有一處**：`server/src/mcp.ts:706`
  （`set_audio` 這個 MCP 工具的 handler，`aiWrite(store, { name: 'setAudio', ... },
ifVersion)`）。`commands.ts:109` 是驗證/執行端，不是呼叫端；`shared/src/types.ts`
  的型別宣告同理不算呼叫點。
- **測試裡呼叫 `set_audio` 工具的地方有兩處**，兩處新驗證都會過（即新增的逐項驗證
  不會擋到既有的合法用法）：
  - `server/test/mcp-optim.test.ts:262`「`remove_audio` deletes one audio item」——
    先用 `set_audio` 傳一個帶真實 `mediaId`、在界內的音訊項（合法輸入，對應 AC15），
    再測 `remove_audio` 能刪掉它；`set_audio` 這一步本身在本輪全程綠燈。
  - `server/test/mcp-tools.test.ts:175`「set_audio replaces the whole audio track」——
    傳 `audio: []`（對應 AC14，既有行為必須不變），本輪全程保持綠燈、斷言未被放寬。
    （`mcp-tools.test.ts:388` 的 `'set_audio'` 字串出現在「instructions 與工具清單同步」
    守衛測試裡，檢查的是 instructions 文案有沒有提到這個工具名，不是呼叫工具，不算
    呼叫點。）
- **UI 完全不走 `setAudio`**：對 `ui/src/` 內 `'setAudio'`／`set_audio` 字面字串的搜尋
  零命中。實際讀碼確認：`ui/src/panels/Inspector.tsx` 與 `ui/src/timeline/Timeline.tsx`
  只**讀** `doc.tracks.audio`，寫音訊軌走的是細粒度 command——
  `Inspector.tsx:172` 的 `updateAudio`、`:224` 的 `removeAudio`、`:151` 的
  `extractAudio`（把某段影片的聲軌抽成獨立音訊項）；`Timeline.tsx:504` 同樣是
  `updateAudio`。這些都是與 `setAudio`（整批覆蓋音訊軌）不同的 command variant，
  UI 沒有任何路徑會建構 `setAudio` 命令物件。

換句話說：這個行為變更不會讓任何現有正常呼叫方變紅，只會讓原本就是壞資料的呼叫從
「默默接受、之後在 render 才爆炸」變成「當下就被拒絕、給出明確原因」。

**但這個補洞只補了一半，如實記在這裡**：新增的驗證只涵蓋 `mediaId`／`duration`／`in`
三個欄位，**沒有涵蓋 `start`／`fadeIn`／`fadeOut`／`volume`**，與 `updateAudio` 的驗證
並不對稱。最具體的後果是**負的 `start` 仍會被接受並落盤**——render 組濾鏡鏈時不會為
負值生成 `adelay`，該段音訊被**靜默放到 0 秒**，使用者不會看到任何錯誤。也就是說，本節
宣告要消滅的「壞資料默默落盤」這個類別，換到 `start` 欄位上依然成立。這是最終全分支
審查發現、經裁決不擋合併的項目，已登記在 `docs/ROADMAP.md` 第 11 條。

## 六、新發現但本輪不修的缺陷：暫存目錄洩漏

系統 temp 累積了 **38,754 個 `vidcut-*` 目錄／42,643 個檔案／16+GB**，磁碟一度只剩
494Mi 並造成一位審查者撞 `ENOSPC`。

- 23 個 server 測試檔會 `mkdtemp`，**只有 4 個**（`mcp-tools`／`mcp-optim`／
  `store-durability`／`store-undo`）會在 `afterEach`/`afterAll` 清理。
- 最大宗是 `vidcut-pcm-`（7,244 個），來自 `server/src/ingest.ts` 算 peaks 時建的
  PCM 暫存目錄——**那是產品程式碼，不是測試**，代表這不只是「測試沒收拾」的衛生
  問題，正式環境長跑同樣會累積。

使用者已授權清理（已清，回收 25.5GB），但**根源未修**，因為超出本次 Task 8（跑
gauntlet + 寫 EVIDENCE）的範圍。本輪 gauntlet 執行本身的磁碟前後對照可作為量級佐證：
開始前 **26Gi** 可用 → 結束後 **24Gi** 可用，單次完整跑（含全測試套件跑兩次、UI
覆蓋率、隨機順序兩輪、突變測試兩輪 71×2 次 vitest 呼叫）就用掉約 **2Gi**——這是在
`git status --porcelain` 跑完後乾淨（`mutate.mjs` 有正確自動還原每隻 mutant）的前提
下量到的，即殘留的磁碟消耗不是本輪程式碼變更留下的髒狀態，是既有的暫存目錄洩漏在
持續作用。列為已知限制，建議後續在 `docs/ROADMAP.md` 補一項技術債（`ingest.ts` 的
PCM 暫存目錄需要用完即刪，測試檔需要統一補 `afterEach`/`afterAll` 清理慣例）。

## 七、GAUNTLET 表

引用自 Task 8 的一次完整乾淨執行（`bash scripts/gauntlet.sh`，source `7e660f3`，最後
一次程式碼修改之後跑的那次，本節唯一引用的一次執行）：

| 關卡                     | 結果                                                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本                     | node v22.18.0／npm 11.5.2／tsc 5.9.3／vitest 3.2.7／ffmpeg 8.1.2／source `7e660f3`                                                                                                                                                  |
| 型別檢查（tsc ×3）       | PASS                                                                                                                                                                                                                                |
| Lint（eslint）           | PASS                                                                                                                                                                                                                                |
| 格式（prettier --check） | PASS                                                                                                                                                                                                                                |
| 全測試套件               | **435 passed**（shared 27／server 238／ui 170），0 failed——與 spec 預期完全相符                                                                                                                                                     |
| UI 覆蓋率                | Statements/Lines 86.38%（2627/3041）、Branches 85.48%（748/875）、Functions 65.28%（126/193）——本 Task 未動 UI，與前一節相同                                                                                                        |
| 隨機順序                 | ui／server（`--sequence.shuffle --sequence.seed=1337`）皆 PASS——**server 這一關先前是失敗的那關（958s 撞牆），`7e660f3` 修好了**（見上「三」）                                                                                      |
| 依賴稽核                 | 沿用既有 baseline：`fast-uri`（2 個既有 high）、`hono`（1 個既有 moderate），皆非本輪新增；`gauntlet.sh` 對此關卡不設 pass/fail gate，只如實印出                                                                                    |
| 秘密掃描                 | PASS                                                                                                                                                                                                                                |
| 突變測試                 | **70 killed + 1 equivalent control**（`store-corrupt-load`，如實存活，非本案新增）＝`scripts/mutants.json` 全部 **71 隻**；本案新增 3 隻（`setaudio-validate`／`listsource-truncate`／`addclip-mcp-ifversion`）全數在此次執行內被殺 |
| 總結                     | `GAUNTLET: 全數通過`                                                                                                                                                                                                                |

執行後 `git status --porcelain` 為空（`mutate.mjs` 正確自動還原了所有被暫時套用的
mutant，兩輪跑完未留下任何殘留變更）。

磁碟：開始前 **26Gi** 可用 → 結束後 **24Gi** 可用（見上「六」的暫存目錄洩漏量級佐證）。

---

# 補記：修掉產品程式碼的 PCM 暫存目錄洩漏（`fix-pcm-leak`）

分級 **Tier 2**（bug 修復，走完整 RED→GREEN→GAUNTLET）。上一節「六」把暫存目錄洩漏
列為「新發現但本輪不修的缺陷」，並指出其中一項**不是測試髒，是產品程式碼**。這一節
就是把那一項修掉。

## 問題

`server/src/ingest.ts` 算音訊波形（`peaks.json`）時，會先開一個 `vidcut-pcm-*` 暫存
目錄，叫 ffmpeg 把整段聲音轉成 8kHz mono s16le 原始取樣寫進 `a.pcm`，讀回來算出
`peaks`／`rms` 之後寫成 `peaks.json`。`peaks.json` 才是要保留的產物，`a.pcm` 與它的
目錄用完即廢——但**沒有任何一行刪它**。

後果不限於開發機：這是上線路徑上的程式碼，**任何使用者每匯入一支素材就漏一個目錄**，
大小約每分鐘影片 1MB，且永遠不會自己消失（macOS 對 `/var/folders` 的自動清理要同時
滿足「三天未存取」與磁碟吃緊，不能當保障）。實測這台機器上一天累積出 1,551 個
`vidcut-pcm-*`。

## RED（先看到紅，才動手）

量測方式刻意不去數全域 temp（會被其他同時在跑的程序干擾）：`server/src` 裡**只有
`ingest.ts` 用 `tmpdir()`**（`grep -rn tmpdir server/src` 僅兩處命中，皆在該檔），
所以把 `process.env.TMPDIR` 指向一個空的沙箱目錄，`ingestMedia` 跑完後那個沙箱
**必須是空的**——這是確定性量測，不受併發影響。

| 測試（`server/test/ingest.test.ts`）                           | 驗什麼                             |
| -------------------------------------------------------------- | ---------------------------------- |
| 「匯入成功後不留下 vidcut-pcm-\* 暫存目錄」                    | 成功路徑                           |
| 「peaks.json 寫入失敗時，先前建立的 PCM 暫存目錄一樣會被清掉」 | 中途丟錯的路徑（`finally` 的理由） |

失敗路徑的觸發用的是既有測試已建立的手法（`nanoidOverride` 固定 id，預先把輸出路徑
佔成目錄逼真實 ffmpeg／`writeFile` 丟 EISDIR），失敗點刻意選在 `mkdtemp` **之後**的
`peaks.json` 寫入——排在 `mkdtemp` 之前的失敗點驗不到這條路徑。兩條測試都先各自加了
「確認真的走到成功／失敗路徑」的前置斷言，避免測到空氣。

實跑 RED：兩條皆紅，訊息是 `expected [ 'vidcut-pcm-7woGio' ] to deeply equal []`
——**紅的原因正是留下的那個目錄名**，不是別的錯誤；同檔既有 9 條測試維持綠。

## GREEN

把 `mkdtemp` 之後到 `peaks.json` 寫入之間包成 `try`，清理放 `finally`：

```ts
} finally {
  await rm(pcmDir, { recursive: true, force: true });
}
```

用 `finally` 而不是「把 `rm` 排在最後一行」是關鍵：ffmpeg 失敗或 `peaks.json` 寫不
進去時，最後一行永遠跑不到，照樣漏。這與同檔 `derived/<id>` 清理踩過的是同一個坑
（那處由既有 mutant `ingest-cleanup` 守著）。實跑 GREEN：11/11 全過。

## 回歸護甲

新增 mutant `ingest-pcm-cleanup`（`scripts/mutants.json` 由 71 → 72 隻）：把 `finally`
的內容清空、保留 `finally` 區塊本身（避免變成語法錯誤而被錯誤歸因）。單獨實跑
`node scripts/mutate.mjs ingest-pcm-cleanup` → **1/1 killed**，執行後 `git status`
確認原始碼已自動還原。

---

# 補記：測試自己的暫存目錄洩漏（同分支，接續上一節）

上一節修的是**產品程式碼**那一半（`ingest.ts` 的 `vidcut-pcm-*`）。這一節修另一半：
測試自己建的暫存目錄從來沒被清過。分級 **Tier 2**。

## 問題與它為何不是「補個 afterAll」就好

`server/test` 有大量 `mkdtemp` 呼叫，配對的 `rm(recursive)` 只有 15 處。那 15 處全是同一種
模式——目錄在模組頂層建、一個檔案就一個、`afterAll` 刪它。

多數檔案不是這樣：`mkdtemp` 藏在**每條測試都會呼叫一次的 helper** 裡（典型如 `setup()`），
建完就只存在於那條測試的區域變數。到 `afterAll` 時根本沒有一個 `dir` 可以刪——有 N 個，
早就沒人記得。所以殘留量是「測試條數 × 跑過幾次」而不是「`mkdtemp` 行數」：
`commands.test.ts` 只寫了 3 個 `mkdtemp`，實測產出 **4,291 個目錄**。

## 修法

`tmpDir(prefix)` 取代 `mkdtemp(join(tmpdir(), prefix))`，但**不是**建在系統 temp，而是建在
「這一輪測試的暫存根目錄」底下；整輪跑完把那一個根目錄刪掉。三個檔案：

- `server/test/global-setup.ts`——建立本輪根目錄，經 `VIDCUT_TEST_TMP_ROOT` 傳給 worker；
  teardown 刪掉它。
- `server/test/tmp.ts`——`tmpDir()`，建在該根目錄底下（沒有這個環境變數時退回系統 temp，
  例如有人繞過 `globalSetup` 直接跑單一檔案）。
- `server/test/setup.ts`——只做一件事：本檔有測試失敗時寫下「別清」的標記。

`server/vitest.config.ts` 兩行接線（`globalSetup` + `setupFiles`）。

行為上兩個刻意的例外：**有測試失敗就整輪保留**（留下的是出事現場——`render` 整合測試
留下的就是真的 mp4），以及 **`VIDCUT_KEEP_TMP=1` 無條件保留**。

61 個呼叫點分布在 23 個測試檔，以腳本機械轉換後由 `tsc`／`eslint`／`prettier` 把關
（真的抓到兩個轉換遺留：`ffmpeg.test.ts` 與 `ws-command.test.ts` 的 `join` 變成未使用的
import，已清掉）。

## 第一版設計是錯的，被隨機順序關卡抓到

**最初的實作是「每個測試檔的 `afterAll` 刪掉本檔建的目錄」**，配一個模組層登記器。
單元測試全綠、全套 243/243、殘留 0，看起來完全成功。**gauntlet 的隨機順序關卡擋下來了**：

```
Unhandled Errors
Error: ENOENT: no such file or directory, rename
  '…/vidcut-gone-frozen-proj-AnaoJH/.project.json.tmp' -> '…/project.json'
```

243 條測試全過，卻多一個未處理錯誤讓整輪 `exit 1`；而且時有時無（重跑第二次就沒事），
單獨跑 seed 1337 也過——只有在 gauntlet 那個時機才穩定重現。

**根因**：`ProjectStore` 的落盤是 debounce 500ms 的射後不理
（`store.ts` 的 `#scheduleSave` → `void this.#save()`），而 **17 個測試檔建了 store、
只有 3 個呼叫 `flush()`**。測試檔跑完的當下往往還有一次存檔排在路上；`afterAll` 立刻
`rm -rf` 就會撞上它——`writeFile` 已寫出 `.project.json.tmp`、`rename` 之前目錄被刪掉。

這是**新設計引入的競態**，不是既有 bug：以前沒有人刪那些目錄，所以這個race 永遠不會
發生。改成 `globalSetup` 的 teardown 後，清理跑在**所有 worker 行程都結束之後**，沒有
任何還活著的行程可能正在寫，競態從根本上不存在。改完連跑三次 `--sequence.shuffle
--sequence.seed=1337`：**3/3 皆 243/243、零 unhandled error**。

附帶好處：所有測試暫存集中在單一根目錄底下。萬一整輪被強制中斷、teardown 沒跑到，
留下的是一個目錄而不是上百個散落的。

## RED

先用丟棄式探針專案確認兩件 vitest 的事實，不憑印象：`setupFiles` 註冊的 `afterAll`
**拿得到**本檔每條測試的結果（實測印出 `["通過的:pass","失敗的:fail"]`）；`globalSetup`
裡設的 `process.env` **傳得到** worker，且 teardown 在所有測試之後才跑。

主測試（`server/test/tmp-cleanup.test.ts`）用**子行程真的跑一次 vitest**，`TMPDIR` 指向
乾淨沙箱，跑完檢查沙箱。之所以開子行程：要驗的正是「整輪測試結束之後」這個時機，同一個
行程裡驗不到。子行程刻意跑**真的 `server/vitest.config.ts`**（用 `VIDCUT_TMP_FIXTURE=1`
切換 include），而不是另外拼一份設定——否則就驗不到接線有沒有真的接上。

RED（第一版設計、清理尚未接上時）紅在斷言而非 import 失敗：

```
expected [] to deeply equal [ "vidcut-leakprobe-P5lz7Q", "vidcut-leakprobe-x7tNW9" ]
```

（更早一次嘗試紅在「子行程自己就掛了」——`--include` 不是 vitest 的 CLI 選項。是測試裡
那條「假測試檔本身必須是綠的」前置斷言擋下來的，否則會把子行程崩潰誤判成洩漏已修好。）

**另兩條測試（失敗保留、`VIDCUT_KEEP_TMP`）是實作寫在前面、測試補在後面的，一寫就綠**
——如實記錄，並照規矩用一次性突變證明它們不是在測空氣，兩次都單獨施打、跑完還原：

| 一次性突變               | 結果                            |
| ------------------------ | ------------------------------- |
| 拿掉「失敗就保留」的守衛 | 只有「失敗時保留」那條轉紅      |
| 拿掉 `VIDCUT_KEEP_TMP`   | 只有「KEEP_TMP 時保留」那條轉紅 |

（中途踩過一次：`git checkout --` 對**未追蹤**的新檔無效，導致第二次施打時第一隻還在，
兩隻疊在一起。發現後改用檔案備份還原，重做了乾淨的單獨施打，上表是重做後的結果。）

## 實測效果（同一套測試，`TMPDIR` 指向乾淨沙箱）

| 版本                | 測試結果   | 跑完後殘留的 `vidcut-*` | 佔用      |
| ------------------- | ---------- | ----------------------- | --------- |
| 修法前（`58782b2`） | 240 passed | **147 個**              | **97 MB** |
| 修法後              | 243 passed | **0 個**                | 0         |

（243 = 240 + 本節新增的 3 條。修法前那個數字是 `git stash` 退回 `58782b2` 實跑量到的，
不是推估。沙箱裡剩下的唯一項目是 Node 自己的 `node-compile-cache`，不是 vidcut 產生的。）

## 回歸護甲

新增 4 隻 mutant（`scripts/mutants.json` 由 72 → 76 隻），各自單獨實跑 1/1 killed。
接線拆成兩隻分別守，因為它們壞掉的方式不同：

| id                        | 改了什麼                    | 為什麼要守                                    |
| ------------------------- | --------------------------- | --------------------------------------------- |
| `tmp-cleanup-off`         | 拿掉 teardown 的清理本身    | 洩漏復發                                      |
| `tmp-cleanup-globalsetup` | 拆掉 `globalSetup` 那行接線 | 根目錄不存在、`tmpDir` 退回系統 temp 且無人清 |
| `tmp-cleanup-setupfiles`  | 拆掉 `setupFiles` 那行接線  | 失敗標記永不寫入，出事現場照樣被清掉          |
| `tmp-cleanup-keep-failed` | 失敗時不寫標記              | 同上，但壞在邏輯而非接線                      |

後兩隻守的正是本 repo 鐵則說的「第三步不會自動發生」：邏輯寫對了、沒接上，一樣等於沒做。

## GAUNTLET（最終，`58782b2` + 本節變更）

| 關卡                     | 結果                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 版本                     | node v22.18.0／npm 11.5.2／tsc 5.9.3／vitest 3.2.7／ffmpeg 8.1.2／source `58782b2`                                           |
| 型別檢查（tsc ×3）       | PASS                                                                                                                         |
| Lint（eslint）           | PASS                                                                                                                         |
| 格式（prettier --check） | PASS                                                                                                                         |
| 全測試套件               | **440 passed**（shared 27／server 243／ui 170），0 failed——server 較上一節多 3，即本節新增的三條                             |
| UI 覆蓋率                | Statements/Lines 86.38%（2627/3041）、Branches 85.5%（749/876）、Functions 65.28%（126/193）——本節未動 UI                    |
| 隨機順序                 | ui／server（seed 1337）皆 PASS——**server 這一關先前是失敗的那關**（第一版設計的 ENOENT 競態），改設計後轉綠                  |
| 依賴稽核                 | 沿用既有 baseline，本節未新增依賴                                                                                            |
| 秘密掃描                 | PASS                                                                                                                         |
| 突變測試                 | **75 killed + 1 equivalent control**（`store-corrupt-load`，如實存活）＝`scripts/mutants.json` 全部 **76 隻**；本節新增 4 隻 |
| 總結                     | `GAUNTLET: 全數通過`                                                                                                         |

此表引用的是最後一次**程式碼**修改之後的單一次執行；該次之後只再動過本檔與
`docs/ROADMAP.md`，唯一會被文件影響的關卡 `prettier --check` 已於文件定稿後單獨重跑通過。

---

# 補記：合併 `main`（57 個 commit）之後的複驗與數字更正

上面兩節是在 `main` 還停在 `1133909` 時做的。之後 `main` 前進了 57 個 commit
（`caption-wysiwyg` 整條併入、MCP 稽核 E/F/G、Skia 光柵器），本分支落後 57、無法快轉，
於是把 `main` 合進本分支。

## 合併

三個衝突，全部在 import 區塊（`mcp-optim`／`mcp-tools`／`mcp.test.ts`）——本分支把
`mkdtemp(join(tmpdir(), …))` 換成 `tmpDir(…)` 動到 import，`main` 在同一段加了
`TextCardService`／`PillowRasterizer`／`extractCover`。解法是聯集，無語意衝突。

**真正的工作不在衝突，在合併帶進來的新呼叫點**：`main` 的 57 個 commit 帶來
`rasterizer.test.ts`（14 處）、`textCards.test.ts`（16 處）等**39 個新的 `mkdtemp` 呼叫點**，
它們全都會漏。一併轉成 `tmpDir()`，合計本分支轉換 **100 個呼叫點**。轉換後全樹只剩
`test/global-setup.ts` 一處 `mkdtemp`（就是建本輪根目錄的那一處）。

## 數字更正（如實記錄）

上一節原本寫「`server/test` 有 **91 個 `mkdtemp` 呼叫**」。**那個 91 是從錯的樹上數來的**
——盤點指令當時指向主 repo 目錄，而主 repo 當時檢出的是 `caption-wysiwyg` 分支；實際做
轉換的卻是本 worktree（基於 `main` `1133909`），只有 61 處。兩個數字分屬不同的樹，放在
同一段裡等於互相矛盾。已把該處改成不寫死數字，正確的量化改由本節提供。

## 合併後的實測（同一套測試，`TMPDIR` 指向乾淨沙箱）

| 情境                                 | 測試結果   | 跑完後殘留     | 佔用       |
| ------------------------------------ | ---------- | -------------- | ---------- |
| 若不清理（`VIDCUT_KEEP_TMP=1` 量測） | 439 passed | **266 個目錄** | **125 MB** |
| 正常（清理生效）                     | 439 passed | **0 個**       | 0          |

（34 個測試檔、439 條。「若不清理」那列直接用逃生口量，等同修法前的行為，不需要把程式碼
退回去。沙箱裡剩下的唯一項目是 Node 自己的 `node-compile-cache`。）

## 這次量測順手抓到的缺陷

用 `VIDCUT_KEEP_TMP=1` 量的那一跑出現 **1 failed** ——`tmp-cleanup.test.ts` 的第一條。
成因是子行程繼承了 `process.env`：外層設了 `VIDCUT_KEEP_TMP=1`，子行程也跟著保留目錄，
於是「整輪跑完不留下任何暫存目錄」那條假性失敗。**這是我自己測試的缺陷，不是修法失效**
——任何人用這個逃生口跑整套都會踩到。修法是在 `runFixture()` 裡把 `VIDCUT_KEEP_TMP` 與
`VIDCUT_TMP_FIXTURE_FAIL` 從繼承來的環境變數中刪掉，讓每條測試自己決定。修完兩種跑法
（一般、帶 `VIDCUT_KEEP_TMP=1`）都是 3/3 綠。

---

# 補記：五隻失效的 mutant，與讓它不會再靜默發生的關卡

合併後的第一次完整 gauntlet 在突變關卡失敗，但**不是有 mutant 存活**——是三隻報
`find 出現 0 次`。逐一用 `git show main:<file>` 比對確認：**這三隻在 `main` 上就已經
失配了，不是合併造成的**。也就是說 `main` 當時的 gauntlet 本身是紅的。

## 為什麼會失效，以及為什麼沒人發現

`scripts/mutate.mjs` 靠字面字串比對定位要突變的程式碼。正當的重構會讓 `find` 失配，
那隻 mutant 就靜默失去守備——引擎會報 ERROR，但前提是**有人跑完整突變測試**。

兩個放大這個問題的缺陷，都在 `scripts/gauntlet.sh` 自己身上：

```bash
node scripts/mutate.mjs 2>&1 | tail -3 | sed 's/^/   /'   # ← 失敗清單被截斷
node scripts/mutate.mjs >/dev/null 2>&1; check $?          # ← 同一關卡跑第二次
```

- **`tail -3` 把失敗清單截掉**：實際壞掉的是**五隻**，報告只印出三隻。另外兩隻
  （`tl-anchor-offset`、`inspector-deselect`）是後來加了 `--check` 才浮現的——換句話說，
  這份報告如果只信 gauntlet 的輸出，會漏掉 40% 的失效項目。
- **同一關卡跑兩次**（一次給人看、一次拿退出碼）：全場最慢的關卡耗時直接雙倍，
  這也是大家傾向用 `--fast` 的原因之一，而 `--fast` 整關跳過突變。

## 五隻的成因與修法

全部是 `main` 那 57 個 commit 的正當重構，`mutants.json` 沒跟上：

| id                          | 目標怎麼變的                                                 |
| --------------------------- | ------------------------------------------------------------ |
| `render-aspect`             | `exp.width`／`exp.height` 抽成 `expW`／`expH`                |
| `mcp-writereply-always-err` | `writeReply` 從 `text(…)` 改成 `result({version,changed},…)` |
| `setaudio-validate`         | 驗證抽成與 `updateAudio` 共用的 `audioRuleError`             |
| `tl-anchor-offset`          | 拿掉 `Math.max(0, …)` 夾制（offset 現在可為負）              |
| `inspector-deselect`        | Inspector 分段重構，縮排變動                                 |

每隻都對回**原本的突變意圖**（不是隨便找一行能替換的字串），更新後各自單獨實跑
`node scripts/mutate.mjs <id>` → **5 隻全部 1/1 killed**，執行後 `git diff` 確認原始碼
自動還原。

## 治本：`--check` 錨點關卡

`node scripts/mutate.mjs --check` 只驗每隻 mutant 的 `find` 在目標檔**恰好命中一次**，
不套用突變、不跑測試，秒級完成。已成為 `gauntlet.sh` 的獨立關卡，且**排在 `--fast` 會
跑到的位置**——原本的缺口正是「完整突變太慢 → 用 `--fast` → 整關跳過 → 失效可以躺很久」。

同時修掉上面兩個 gauntlet 自身的缺陷：突變關卡只跑一次；綠燈印摘要，紅燈印**全部**
壞掉的那幾隻。

**負向對照**（證明這道關卡真的擋得住，不是擺設）：把 `render.ts` 的 `expW` 改名成
`expWidth`（模擬一次正當重構後忘了更新 mutant），`--check` 立刻 exit 1 並指名
`render-aspect — find 出現 0 次`；還原後回到 `76/76` exit 0。

## 附帶更正：`main` 已補完先前記錄的 `setAudio` 驗證缺口

`docs/ROADMAP.md` 第 11 條原記「`setAudio` 只驗 `mediaId`／`duration`／`in`，負的
`start` 會被接受並在 render 被靜默放到 0 秒」。`main` 的 MCP 稽核 F 批把規則抽成
`audioRuleError(a, media)`，`setAudio` 與 `updateAudio` 共用，**含 `start >= 0`**
（`commands.ts` 該函式第一行）——該缺口已不存在，ROADMAP 條目已改寫。

（本報告先前的口頭判斷曾說「只補了一半、負 start 仍會通過」，那是只看了 `num()`
（僅驗有限數）而漏看 `audioRuleError` 的誤判，一併在此更正。）

**但有一項是真的**：`start >= 0` 這條規則**沒有任何測試釘住**
（`grep 'start must be >= 0' server/test` 零命中）。`setaudio-validate` 整段拿掉驗證
迴圈時，殺掉它的是「mediaId 不存在」那條斷言，不是負 start。已列進 ROADMAP。

## GAUNTLET（最終，`1c42788` + 本節變更）

| 關卡                   | 結果                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| 版本                   | node v22.18.0／npm 11.5.2／tsc 5.9.3／vitest 3.2.7／ffmpeg 8.1.2／source `1c42788`                  |
| 型別檢查（tsc ×3）     | PASS                                                                                                |
| Lint／格式             | PASS／PASS                                                                                          |
| 全測試套件             | **740 passed**（shared 45／server 439／ui 256），0 failed                                           |
| UI 覆蓋率              | Statements/Lines 89.59%（3351/3740）、Branches 87.38%（942/1078）、Functions 71.36%（167/234）      |
| 隨機順序               | ui／server（seed 1337）皆 PASS                                                                      |
| **突變錨點（新關卡）** | **76/76 mutants 的 `find` 都恰好命中一次**                                                          |
| 依賴稽核               | 沿用既有 baseline，本節未新增依賴                                                                   |
| 秘密掃描               | PASS                                                                                                |
| 突變測試               | **75 killed + 1 equivalent control**（`store-corrupt-load`）＝`scripts/mutants.json` 全部 **76 隻** |
| 總結                   | `GAUNTLET: 全數通過`                                                                                |

---

# 補記：Inspector 未選取狀態的 AI 區塊（2026-08-13）

依 old-coder 流程。**Tier 2**。範圍：`ui/src/panels/Inspector.tsx` 未選取時新增
`AgentStatus`（+82 行），顯示 agent 連線狀態、離線時的重連指令、最近三筆變更並標示
AI／人。純顯示層，不新增 command、不碰 MCP、不動任何既有互動。

**Spec approval：已取得**（使用者核准 SPEC 的 B1–B7 與 N1–N6 之後才開工）。
**RED 的降級如實記載**：實作在 SPEC 之前就寫好了（來自同一輪對話的 UI 診斷），
所以無法用「先看測試失敗」的原始形式。改以**變異優先**取代：先寫測試看綠，再逐一
破壞實作確認每條會轉紅（下表 7 隻，全部收進 `scripts/mutants.json` 可重跑）。
這比正規 RED 弱一級，信心層級如實下修。

## 行為 → 測試對映

全部在 `ui/src/panels/panels.test.tsx` 的 `describe('agent status (nothing selected)')`。

| 行為                                     | 測試                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------- |
| B1/B2 顯示 AI 區塊、連線時顯示 connected | `B1/B2: shows the agent block, connected when the socket is up`       |
| B2/B3 離線顯示 No agent＋重連指令        | `B2/B3: offline shows "No agent" plus the command that reconnects it` |
| B4 連線時不顯示重連指令                  | `B4: the reconnect command is hidden while connected`                 |
| B5 無歷史時的空狀態                      | `B5: says so when there is no history yet`                            |
| B6 只列最近三筆、最新在最前              | `B6: lists only the three most recent edits, newest first`            |
| B7 標示變更來源（AI／you）               | `B7: attributes each edit to the AI or to you`                        |
| N2 有選取時不顯示 AI 區塊                | `N2: the agent block is not shown once something is selected`         |
| N1 既有空狀態文字仍在                    | 既有 `prompts for a selection when nothing is selected`（續綠）       |
| N3 冷載入不白屏                          | 既有 `panels-smoke.test.tsx`（續綠）                                  |
| N4 真瀏覽器面板／畫布行為不變            | `verify:panels`、`verify:canvas`（見下）                              |
| N5 不新增相依                            | `git diff` 對四份 package.json＋lock 皆為空                           |
| N6 Activity 面板既有行為不變             | `panels.test.tsx` 的 Activity 段（續綠）                              |

## 本功能的 7 隻 mutants（全滅）

`node scripts/mutate.mjs <id>` 可逐隻重現。

| id                            | 改了什麼             | 被誰殺                |
| ----------------------------- | -------------------- | --------------------- |
| `inspector-agent-block`       | 整塊不渲染           | B1–B7（5 條同時轉紅） |
| `inspector-agent-connected`   | 連線狀態反轉         | B1/B2、B2/B3          |
| `inspector-agent-hint-always` | 連線時也顯示重連指令 | B4                    |
| `inspector-agent-order`       | 不反轉＝顯示最舊三筆 | B6（順序斷言）        |
| `inspector-agent-count`       | 取五筆而非三筆       | B6                    |
| `inspector-agent-source`      | 來源標示恆為 AI      | B7                    |
| `inspector-agent-empty`       | 空狀態文字消失       | B5                    |

## GAUNTLET（最後一次程式碼修改後的單一乾淨執行）

| 關卡               | 結果                                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 版本               | node v22.18.0／tsc 5.9.3／vitest 3.2.7／source `94ac894`                                                                                                                          |
| 全測試套件         | **755 passed**（shared 46／server 446／ui 263），0 failed                                                                                                                         |
| 型別檢查（tsc ×3） | PASS                                                                                                                                                                              |
| Lint               | PASS                                                                                                                                                                              |
| 格式               | 本次改動的四個檔案 PASS（`docs/research/…` 那筆紅是別的 session 的檔案，非本次）                                                                                                  |
| **變更行覆蓋率**   | **AgentStatus（79–161 行）未覆蓋語句 0 條＝100%**；檔案整體 85.43% 為既有基準                                                                                                     |
| 隨機順序           | ui 全套在 files＋tests 兩層都打亂下，seed 1337／42／7 皆 **263 passed**                                                                                                           |
| 突變錨點           | **86/86** mutants 的 `find` 都恰好命中一次                                                                                                                                        |
| 突變測試（本功能） | **7/7 killed**（上表），由 `scripts/mutate.mjs` 引擎逐隻實跑，工作樹以 git diff 驗證還原                                                                                          |
| 依賴稽核           | **零新增依賴**（四份 package.json 與 lock 皆無 diff）                                                                                                                             |
| 秘密掃描           | PASS（diff 內無命中）                                                                                                                                                             |
| 真實執行           | 正式 build 由真 server 服務（:3901，demo 副本）：DOM `AI agent`／畫面渲染 `AI AGENT`（`.panel-head` 的 uppercase）、`Agent connected`、`No edits yet.` 皆在，連線時不顯示重連指令 |

## 過程中的發現與處理（如實記載）

1. **`resetStores()` 沒有清 `useActivity`** —— 加了清理，但**實測證明它目前不可達**：
   每個測試都走 `seedProject()`，而 `applyServerMsg({type:'full'})` 會
   `useActivity.seed(msg.history)`（`stores/project.ts`），history 是空陣列等於已清乾淨。
   刻意寫了一支決定性探針（A 灌歷史→B 斷言乾淨），拿掉清理後**照樣全綠**；
   `--sequence.shuffle.tests` 五個 seed 也殺不掉。**沒有謊稱它是有效防護**：程式碼留著
   （不經 seedProject 直接操作 store 的測試會需要它），但註解與本節都寫明它無 mutant
   守著、改動不會有測試轉紅。
2. **一次工具誤用**：`--sequence.shuffle` 與 `--sequence.shuffle.tests` 同時傳會讓 vitest
   的 CLI 解析崩潰（`Cannot create property 'tests' on boolean 'true'`），輸出被吞、
   exit 1。**那不是測試失敗**；改用 `--sequence.shuffle.files --sequence.shuffle.tests`
   後三個 seed 全綠。記在這裡免得下一個人把它讀成回歸。
3. **真實執行時 `innerText` 找不到 `AI agent`** —— 因為 `.panel-head` 有
   `text-transform: uppercase`，畫面上是 `AI AGENT`。測試斷言的是 `textContent`
   （不受 CSS 影響）故仍正確；已在真瀏覽器上分別確認 DOM 值與渲染值。

## 已知限制

- **視覺呈現（間距、顏色、好不好看）測不出來**——由實機截圖人工確認，本節不宣稱涵蓋。
- `entries` 超過 200 筆的截斷是 activity store 既有邏輯，非本次範圍。
- 覆蓋率數字只針對 `Inspector.tsx`（`--coverage.include` 限定），不是全 UI 重跑。

## 補記:Agent Presence 階段 2——agentActivity 訊號管線(2026-08-14)

Spec:`docs/superpowers/specs/2026-08-14-agent-presence-design.md` §3.1+§3.2。零視覺變更。

**行為→測試對映**:start/end 配對(含拋錯走 finally)、callId 模組級遞增(跨
server 實例決定性——mountMcp 每請求 new 一台,closure 計數器會歸零撞號)、
bus→wsHub 端到端廣播 → `server/test/agent-activity.test.ts`(10 測);store 集合
增刪、三態推導、斷線清空、無主 end 容錯、sessionCounts → `ui/src/stores/agent.test.ts`
(21 測);訊息路由早期 return(N6:落到 patch 分支會誤判 resync)與斷線清空
→ `ui/src/stores/project.test.ts`(+2 測)。

**gauntlet(source:3350399+本階段工作樹,單次乾淨全跑)**:全測試 798 passed
(shared 46/server 465/ui 287,+33);UI 覆蓋率 89.55% statements;隨機順序×2 PASS;
突變錨點 98/98;**突變測試 97/97 killed+1 等價對照隻如預期存活**(12 隻新 mutant:
agentact-finally/-start/-seq/-wshub、agent-store-end/-offline/-latest/-nocalls/
-counts/-clear-ref、agent-disconnect-clear、agent-msg-route);型別/lint/格式/文件
引用/中文字串/秘密掃描全 PASS;audit 5 個既有 dev 依賴漏洞(本階段零新增依賴)。

**硬性驗收**:`server/test/mcp-surface-snapshot.test.ts` 9 測全綠,snapshot 檔
`git diff` 為空——registerTool 攔截層未讓工具面移動一個位元組,全程未用 `-u`。

**過程發現(如實記)**:(1) RED 期發現 MCP SDK 會把 handler 例外轉成
`{isError:true}` 回覆,原 `rejects.toThrow()` 斷言是錯的——改為釘「finally 仍發
end」+「錯誤訊息完整透傳」;(2) 拋棄式突變揪出一隻存活:集合已空時 clear() 仍
換 reference(zustand v5 下每次斷線重連讓全部訂閱者重繪),補斷言後 killed,並
收為永久 mutant agent-store-clear-ref;(3) `startServer` 開機的字型 probe 在本機
吃數十秒,該測試 timeout 調至 120s。

**已知限制**:payload 無工具參數(未來 Vyra 式文案要擴);經過秒數由元件層算
(store 只存 startedAt,避免每秒重繪全樹);callId 跨 server 重啟歸零(斷線已清
空集合故不撞;熱重載架構才需複合 id)。

## 補記:Agent Presence 階段 3——header 紙條 AgentStrip(2026-08-14)

Spec §3.3+§3.5(含字型路徑修訂註)。紙上分鏡世界的第一件編輯器實體。

**行為→測試對映**:三態渲染(offline 優先於殘留 working)、formatElapsed 補零/
負值夾制/超時累加、interval 只在 working 掛且卸載即清、點擊→callback+openRight
冪等、aria(status/polite/裝飾 svg aria-hidden)、連發取最新一筆 →
`ui/src/AgentStrip.test.tsx`(23 測)+`ui/src/stores/view.test.ts`(4 測)+
`App.test.tsx` 接線測試(+1)。斷言更新僅 1 條(Connected/Offline 文字→紙條三態
文案,經核准的規格變更,強度未弱化)。

**gauntlet(source:2f4688a+本階段工作樹,單次乾淨全跑)**:826 passed
(shared 46/server 465/ui 315,+28);覆蓋率 89.74%;隨機順序×2 PASS;錨點
112/112;**111/111 killed+1 等價對照如預期存活**(14 隻新 mutant:strip-phase-_、
strip-elapsed-_、strip-tick*、strip-click-*、strip-ring-dashed、strip-offline-class、
strip-current-call、strip-aria-live、view-openright-idempotent);其餘各層全 PASS。

**真瀏覽器驗收(主 session)**:`npm run build -w @vidcut/ui` 後 `verify:panels`
全綠;:3845 實截圖確認紙條上線(AGENT READY、膠帶、手繪圈,與 Export 鈕同列
不撐版);header 高度子代理以 CDP 實測四情境皆 45px。variable font 雙路實證
(fontTools 墨水面積 +17%、瀏覽器 document.fonts.check + 寬度差)。

**已知限制(如實記)**:working 態動畫未在真 app 截圖驗到(需 MCP 呼叫正好在飛;
由元件測試+使用者核准的互動 demo 覆蓋);prefers-reduced-motion 只在 CSS 層確認
(全域 kill 含 animation,圈另設完成態),未做 CDP emulate 實測;顏色/微轉/濾鏡
外觀無自動化守著(jsdom 測不到,刻意不寫恆真的 toHaveStyle)。設計 hook 兩條
發現(--ap-spring 彈簧、紙條 padding 過渡)經查為核准設計,已登記 sanctioned
exception 附理由。

## 補記:雙主題階段 ①——暗房調和+AgentStrip 琥珀終端換裝(2026-08-14)

Spec:`docs/superpowers/specs/2026-08-14-dual-theme-design.md` §2(暗房調和)+
`2026-08-14-agent-presence-design.md` §2/§3.3/§3.5 修訂區塊(大使館識別=「那隻
手」,載體隨主題;暗版載體=琥珀終端紙條)。配色為使用者逐輪定案:working/idle
用 D3 琥珀終端、offline 用 C 舊黃銅灰圈。

**行為→測試對映**:換裝**零行為變更**——三態推導、interval、點擊、aria 的既有
23 測全數原樣通過(斷言未動);新增 2 測釘歪框結構(SVG pathLength=1 手繪框存在
且 aria-hidden、三態皆掛框)→ `ui/src/AgentStrip.test.tsx`(25 測)。token 改值
(亮度樓梯/降飽和/對比修正)屬視覺層,jsdom 不假裝測得到,由下方實機驗收扛。

**token 帳(theme.css)**:亮度樓梯 `--bg #0d0e16→#15161d`、新 `--panel #191a22`、
新 `--bg-stage #101117`(stage 永遠最暗)、`--popover-bg →#242530`、`--surface 白
5%→6%`、`--accent #8b5cf6→#6d5bd0`(降飽和,附帶把白字對比 4.23→5.18 修過線)、
`--clip-frozen-bg →#2c2f42`;18 處殘餘硬編色收編為 token(accent-glow 族/audio
族/tint 族/link/brand-gradient-end 等);對比修正 `--text-3 →#82879c`(對 panel
4.86:1、對 bg 5.06:1)、`--accent-2 →#6264f1`(白字 4.553:1,取最近的合規值)。
琥珀紙條:idle/working `#241f16` 底+`#e8b04c` 字(8.38:1)、offline `#1f1c15` 底 +`#9c8654` 舊黃銅(4.82:1)+虛線灰圈、working 秒數 4.64:1;膠帶 ::before 移除,
由歪框 SVG(#ap-pencil feTurbulence)接替;紙/膠帶 token 保留註記「亮版紙世界
專用」。

**gauntlet(source:d9f4252+本階段工作樹,單次乾淨全跑)**:828 passed
(shared 46/server 465/ui 317,+2);UI 覆蓋率 89.78% statements;隨機順序×2
PASS;突變錨點 112/112;**突變測試 111/111 killed+1 等價對照如預期存活**
(本階段零新增 mutant——換裝零行為變更,既有 14 隻 strip mutant+全庫 112 錨點
續守);型別/lint/格式/文件引用/中文字串/秘密掃描全 PASS;audit 僅既有 dev 依賴漏洞(本階段零新增依賴)。

**真瀏覽器驗收(主 session)**:`npm run build -w @vidcut/ui`(✓ built)後
`verify:panels` 全綠;:3845 實截圖確認琥珀紙條入列 header(舊黃銅 offline 態、
歪框、與 Export 同列不撐版);全對比為實算(WCAG relative luminance),非目測。

**已知限制(如實記)**:`--text-3` 對 `--popover-bg` 為 4.26:1——popover 內語意
文字應改用 `--text-2`,現況 popover 中 text-3 僅裝飾/輔助用途,列為 advisory;
hover 態 `#2b2519` 未經對比實算(非文字底);`--card #272d49` 未入亮度樓梯(記
到階段 ②);accent 疊加族仍為 139,92,246 色相(刻意保留,見 spec §2);顏色外觀
無自動化守著,同階段 3 的既有限定。

## 補記:雙主題階段 ②——token 雙值化基建+canvas 查表+切換器(2026-08-14)

Spec:`docs/superpowers/specs/2026-08-14-dual-theme-design.md` §4+其階段 ② 實作定案
修訂區塊。**最高驗收:預設(暗版)視覺零變化**——基建不許改任何像素。

**行為→測試對映**:初始化優先序(localStorage `vidcutTheme` > prefers-color-scheme

> dark,壞值忽略、無 matchMedia 不爆)、模組載入即套用、setTheme 持久化、
> **dark 移除 data-theme 屬性/paper 設置**、冪等、往返 →
> `ui/src/stores/theme.test.ts`(14 測);CSS 變數查表取值/trim/空值回退字面值、
> 中線色三態 → `ui/src/timeline/waveform.test.ts`(7 測);主題切換觸發
> ClipBlock/AudioChip 重畫 → `ui/src/timeline/waveform.redraw.test.tsx`(2 測);
> 切換器 aria-pressed 雙態、點擊切換+寫 localStorage、英文標籤 →
> `ui/src/panels/themeToggle.test.tsx`(5 測)。既有斷言零修改
> (`git diff --stat` 測試路徑為空,redraw 測試的 RED 以拔依賴法驗證後還原)。

**零視覺變化的機械證明(不是目測)**:(1) `:root` 區塊與 HEAD 版剝除純新增的
`--wave-*` 後 3644 字元逐位元組相同;(2) dark 態不設任何屬性,預設 DOM 與基建前
相同;(3) 像素級:發現 `--headless=new --screenshot` 同 build 連拍即有 3 萬像素級
反鋸齒噪聲(不能當比對工具,教訓已入 `.claude/rules/ui-verification.md`),改用
CDP 決定性截圖(reduced-motion+transition kill+fonts.ready),同 build 噪聲底
7 像素(playhead 邊緣次像素抖動);git stash 往返實測 **HEAD build vs 本包 build
diff=7 像素、bbox 與噪聲底完全一致=零變化成立**。

**gauntlet(source:0aad8a8+本階段工作樹,單次乾淨全跑)**:856 passed
(shared 46/server 465/ui 345,+28);UI 覆蓋率 91.48% statements;隨機順序×2
PASS;突變錨點 117/117;**116/116 killed+1 等價對照如預期存活**(5 隻新 mutant:
theme-init-priority/theme-dark-attr/wave-lookup-fallback/wave-redraw-dep/
theme-toggle-aria,逐隻先手動驗證擊殺);其餘各層全 PASS;零新增依賴。

**真瀏覽器驗收(主 session)**:paper 模式實截圖確認切換生效(紙底/亮面板/
**stage 依 §3 硬性規則維持深色襯底**/波形查表換色);verify:panels ✓、
verify:canvas ✓(demo 缺 overlay 為既有共用狀態問題,MCP 臨時補跑完即拆)、
verify:wysiwyg 六 case ✓(最大差 1.0px/容差 4)——反目標「wysiwyg 不受影響」守住。

**過程發現(如實記)**:(1) spec 原文「逐字元照抄」波形常數在 CSS 側不可滿足——
prettier 強制 `0.30`→`0.3`(實測寫 0.30 會讓 format:check 紅),色值等價,雙側
註解已記;(2) paper 佔位塊比 spec §2 多蓋 `--line-strong`(紙底上片段描邊繼承
暗版白 14% 透明會隱形);(3) 波形 fallback 測試在舊常數下天然綠(RED 只有 5/7),
守護靠 wave-lookup-fallback mutant 而非 RED。

**已知限制(如實記)**:paper 佔位值未經 craft 與對比驗算(階段 ③ 全面重調,
spec 佔位橫幅已聲明勿以此評判亮版);切換器藏在 Shortcuts 彈出層,可發現性低
(刻意——零視覺變化優先,階段 ③ 再議升格);7 像素 playhead 噪聲殘差未歸零
(與主題無關的既有抖動,壓到零需凍結 playhead 渲染,不在本階段範圍)。

## 補記:雙主題階段 ③——分鏡紙桌面 craft+方向 A+兩輪使用者修正(2026-08-14)

Spec:`2026-08-14-dual-theme-design.md` §3+三個修訂區塊(實作定案/craft 補強/
使用者第二輪收回)。本節涵蓋同一工作樹上的連續四段:紙桌面 craft、Two-Hands
署名修正、craft 補強三批(Jost/材質/Caveat+濾鏡)、方向 A+使用者收回。

**設計驗收(非測試可證,如實記錄手段)**:paper 對比 44/44 實算 ≥4.5(計算器
對 8 組暗版已知值自校);紫/青 grep 驗證於 paper 全退場;暗版在「方向 A 前」
的每一批都以 CDP 決定性截圖驗零變化(批間 diff=26px 已知噪聲座標或 0);
方向 A 起暗版外觀依核准改變,但**顏色 164 token 逐字元不變**(token 定義+全檔
色值 multiset 兩道機械比對)。

**行為→測試對映**:本線行為變更極少——`--who-ai`/`--who-you` token 化
(Inspector/Activity 署名,值=原字面值)與 `.panel-edge-*`/`data-edge` 收編
(App.tsx inline→CSS,暗版值逐字元同)皆為零行為重構,既有 345 UI 測試原樣
全綠、斷言零修改;`.sc-help` wrapper 隨 Caveat 退場一併移除。

**過程發現(如實記)**:(1) Opus 首版把署名分色做反(AI=紅),主 session 對
spec Two-Hands 條款查證後修正(AI=graphite、you=紅鉛筆);(2) playhead 鉛筆
濾鏡試裝後否決——feDisplacementMap 對 2px 線是「啃」不是「抖」,1×DPR 不可見
/2×DPR 線寬 3–5px 跳動,且 playhead 逐幀改 left 是播放熱路徑;否決記入
Timeline.tsx 註解;(3) 批次 1 曾誤報暗版 2 萬像素回歸,查明為 verify:canvas
的 MCP overlay 加拆污染 demo 活動紀錄(內容差非渲染差),以單變因實驗
(@font-face 範圍單獨切換)證得 26px=噪聲;(4) headless 無系統字體讓字寬量測
全等(假陰性),棄用改 fontTools 對真 SFNS 實量;(5) Caveat 兩個 weight 檔
byte-identical(variable font,Google css2 同 URL);(6) 使用者第二輪收回
dashed/傾斜/手寫(「app 跟 landing 不一樣」),已全部撤除並記入 spec——
Caveat 檔+@font-face 保留(零消費者=不下載,留給階段 4 議)。

**gauntlet(source:92ffa12+本線全部工作樹,單次乾淨全跑)**:856 passed
(shared 46/server 465/ui 345);UI 覆蓋率 91.49%;隨機順序×2 PASS;錨點
117/117;**116/116 killed+1 等價對照如預期存活**(本線零新增 mutant——
視覺層變更,行為由既有 mutant 續守);其餘各層全 PASS;零新增依賴(Caveat
為靜態資產+OFL 授權檔)。中途一次 gauntlet 被使用者修正指示中停,殘留
mutant(mcp.ts truncation slice)以 git diff 驗明後還原,最終數字來自其後的
完整乾淨全跑。

**真瀏覽器驗收(主 session)**:verify:panels/canvas/wysiwyg 三連綠(canvas
的 demo 缺 overlay 以 MCP 臨時補、跑完即拆);暗版/paper 最終截圖經使用者過目
核准(拉直+實線版)。

**已知限制(如實記)**:paper 虛線收回後分隔線色隨 `--line`(0.18)比批次 2
的 0.22 淡一階,使用者未再議,以現狀為準;切換器仍藏 Shortcuts 彈出層
(可發現性 vs 零變化的取捨,階段 ③ 後可再議);Caveat/`--hl` 等保留 token
現無消費者;暗版世界觀(B/C/D 候選)為下一線,本包不含。

## 補記:暗版世界觀——剪接室暗房 C4-d(2026-08-16)

Spec:`2026-08-14-dual-theme-design.md` 新增 §6(取代 §2「紫世界身分不變」)。
使用者經兩輪 mock 定案(B/C/D 選 C;C1–C4 收斂為 C4;再收斂為降對比+無粗線+
無齒孔的 d 版),暗版整體換裝為剪接室暗房:炭黑階梯+白蠟筆+紅蠟筆標記系統,
紫/青全面退役,兩主題正式同屬紙世界宇宙(Two-Hands 換支筆)。

**行為→測試對映**:零行為變更——純 token 值改動+3 個新 token
(`--select-edge`/`--playhead-tail`/`--brand-gradient-start`,因語意分家與 paper
零變化而生)+1 個掛勾 class(`.cap-current`,當前字幕列左標,inset box-shadow
避免 border 擠位)。既有 345 UI 測試斷言零修改全綠;`waveform.ts` 的紫/青字面值
為 jsdom 回退機制**刻意保留**(`waveform.test.ts` 釘的是回退機制非顏色)。

**paper 零變化(硬性驗收)**:主 session CDP 逐像素 diff **=0**;實作側另有
機械證明(剝註解解析全部 CSS 規則比對:paper 30 個選擇器逐字元相同,僅新增
3 個 token 且值=各消費者原解析值;共用規則改動走 `:root:not([data-theme])`
或被 paper 更高 specificity 蓋掉)。

**對比實算(WCAG,半透明先 alpha 合成)**:語意文字零失敗——text-1 對
bg/panel/popover 13.69/12.80/11.26;紅蠟筆文字階 `#da7565` 對 panel 5.20/chip
4.63/popover 4.57;`--who-ai` 8.21;炭黑字對 chalk 主鈕 13.05;圖形 ≥3(選中
紅框對 card 3.15、playhead 對 panel/card/frozen 3.62/3.15/3.02)。**順手修掉
既有缺陷**:白字對 `--approve-2` 一直只有 3.31,換炭黑字後 4.61。

**過程發現(如實記)**:(1) playhead 取消漸層改整條實心紅——壓深端對 card
2.60 不合規、提亮後漸層感消失,兩頭堵死,且蠟筆本就畫得均勻;(2) `--danger`
與紅蠟筆相對亮度比 1.00 無法區辨,提亮至 `#fb8a8a`(色相/飽和/亮度比 1.36
三軸拉開);(3) `--clip-frozen-bg` 被 playhead 對比反向鎖住上限,雙側註解
互標;(4) 前一輪 gauntlet 因使用者修正指示中停,殘留 mutant(mcp.ts)以
git diff 驗明後還原。

**gauntlet(source:46451a0+本包工作樹,單次乾淨全跑)**:856 passed
(shared 46/server 465/ui 345);隨機順序×2 PASS;錨點 117/117;**116/116
killed+1 等價對照如預期存活**(零新增 mutant——純視覺層);其餘各層全 PASS;
零新增依賴。

**真瀏覽器驗收(主 session)**:verify:panels/canvas/wysiwyg 三連綠(canvas
的 demo 缺 overlay 照例 MCP 臨時補、跑完即拆);暗版新世界截圖經使用者過目
核准(「先ok」)。

**已知限制(如實記)**:「先ok」=保留後續微調空間(紅用量/蠟筆亮度/底深淺
均為單 token 改動);`--playhead-tail` 在暗版現與筆尖同值(等待亮版以外的
消費者);text-3 對 popover 4.32 維持「浮出層限用 text-2」的既有限定。

## 補記:Agent Presence 階段 4——索引卡+取消選取路徑(2026-08-16)

Spec:`2026-08-14-agent-presence-design.md` §3.4+新修訂區塊(載體 A 案琥珀終端卡
/署名不用手寫體/「卡外紫藍」句過時聲明/deselect 補洞)。含使用者發現的既有缺陷
修復:選取的設定路徑 9 條、清除路徑僅 3 顆刪除鈕——選過即回不到 Inspector 閒置區。

**行為→測試對映**:Escape 取消選取(清選取/不送 command/打字中不清/帶修飾鍵
不清,沿用 onKey 既有 guard 體例)→ App.test.tsx(+4);時間軸空白點擊取消
(每個空白層都清/點 clip 不清/尺規 seek 不被搶且保留選取/拖曳落空白不清,
`data-tl-blank` opt-in 白名單——currentTarget 判斷會漏掉「軌道列右側大片空白」)
→ Timeline.test.tsx(+5);索引卡三態(offline 保留接回指令/idle 讀數列/working
`▸ tool mm:ss`)、與 header 同源推導、interval 只在 working 掛、署名分色 →
panels.test.tsx 等(合計 +21,366 UI 測試全綠,斷言零弱化);shortcuts.ts 同步
`Esc — Deselect`(CLAUDE.md 鐵則)。

**復用而非複製**:RING_PATH 與 formatElapsed 自 AgentStrip export——同一支筆的
同一個圈,複製會默默分岔且 jsdom 驗不到形狀;#ap-pencil defs document 級可及,
卡不重複宣告(真瀏覽器截圖確認濾鏡作用)。

**對比實算 21 對全過**,其中兩個實算逼出的設計修正:(1) 卡與面板明度比
1.01:1(slate 對 panel)/1.00:1(紙對紙),邊界必須是結構性 1px 線按 3:1 算,
不是裝飾;(2) 署名不可用 opacity 降階——`--who-you` α0.8 對 panel 掉到 3.81,
改為同顏料降字級。ui/DESIGN.md 同步:One-Warm-Light 改寫為大使館領土規則
(strip+索引卡)、Caveat exemption 關閉、新增 AgentStatus 元件段。

**過程發現(如實記)**:(1) Opus 首版 working 態卡文字未跟上 header(卡寫
AGENT READY/header 已 WORKING),真瀏覽器截圖抓到,修復+補 C3b 測試;
(2) 首輪 gauntlet 在突變層被訊號終止(exit 144,前十關全 PASS;疑與並行
verify 三連的資源壓力有關),殘留 mutant(render.ts 進度旁路改直寫)git diff
驗明後還原,重跑乾淨全綠;(3) offline 態真瀏覽器截圖:CDP 斷網殺不掉既有
WS,改 WebSocket 攔截法(包 constructor+載後強制 close+禁重連)截得;
(4) panels.test.tsx 的 beforeEach 補 agent store 重置(resetStores 沒收
模組級 state,前一測試的進行中呼叫會讓下一測試卡在 working)。

**gauntlet(source:9a4694d+本包工作樹,單次乾淨全跑)**:877 passed
(shared 46/server 465/ui 366,+21);UI 覆蓋率 91.61%;隨機順序×2 PASS;
錨點 122/122;**121/121 killed+1 等價**(5 新 mutant:app-escape-deselect/
tl-blank-deselect/inspector-card-working/inspector-card-tick-only-working/
inspector-card-counts,逐隻手動驗證;另 1 隻既有 inspector-agent-connected
隨換裝重新錨定);其餘各層全 PASS;零新增依賴。

**真瀏覽器驗收(主 session)**:兩主題×三態卡截圖(working 以真 MCP 呼叫
截得秒數實跳;offline 以 WS 攔截截得);verify:panels/canvas/wysiwyg 三連綠
——canvas 綠即證空白點擊未搶 clip/尺規/拖曳任何既有路徑。

**已知限制(如實記)**:working 態的 paper 版未截(色組與已審 idle 紙卡同套,
對比已實算);Esc 在 popover 開啟時的行為未特別處理(popover 自有外點關閉,
無衝突);server 曾隨機器重啟而停,以 `npx tsx server/src/index.ts projects/demo`
起回(未動 demo 內容)。

## 補記:時間軸比例調整+主軌波形帶移除(2026-08-16)

多輪使用者迭代收斂的定案:主軌=其他軌的 2 倍(ROW_H 60=2×30,overlay/字幕
/音訊軌統一 30)、工具列完全復原原尺寸(前一輪的 .tl-toolbar 縮身規則整組撤除)、
主軌 filmstrip 滿版**不再顯示波形帶**(「取消影片的音軌顯示」定案;先前「音訊軌
縮小 30%」語意有歧義——當時 demo 無音訊素材,使用者看到的其實是主軌波形帶,
兩種解讀都做出來後由使用者選定此案)、影片塊上下各 2px 浮在列裡(與字幕 chip
同款,A 案)。時間軸帶總高與改版前持平。

**波形機制保留而非拆除**:clipWave 查表/--wave-clip-* token/繪製器全保留(音訊軌
仍為唯一消費者),ClipBlock 留復原路徑註解(掛回 canvas+draw effect 參考
AudioChip)。**已知代價(如實記)**:muted(volume=0)原以波形變淡提示、frozen
原有平線指示,兩者的時間軸層級視覺線索消失(音量狀態仍在 Inspector;Snowflake
圖示仍在)。

**測試與 mutant 隨行為調整**:waveform.redraw.test 的 ClipBlock case 移除(主軌
已無 canvas,測試對象不存在;AudioChip case 保留守著同一條線,365 UI 測試,-1);
wave-redraw-dep mutant 重新錨定到 AudioChip.tsx 的 deps 行,正規擊殺驗證:帶突變
`cd ui && npx vitest run` 1 failed/還原後 1 passed。

**過程失誤(如實記)**:(1) 還原 mutant 時用 `git checkout -- AudioChip.tsx`,
把未 commit 的 AUDIO_ROW_H 改動一併洗掉——重補,之後一律定點 replace 還原;
(2) `npm test -w @vidcut/ui -- <repo根路徑>` 的 cwd 在 ui/,找不到檔案 exit 1,
看似 mutant 被殺實為假證據——改在 ui/ 內以相對路徑重做擊殺驗證。

**gauntlet(source:b45d55c+本包工作樹,單次乾淨全跑)**:876 passed(shared 46
/server 465/ui 365);UI 覆蓋率 91.51%;隨機順序×2 PASS;錨點 122/122;
**121/121 killed+1 等價對照存活如預期**;文件引用/使用者面字串/依賴稽核/秘密
掃描全 PASS;零新增依賴。

**真瀏覽器驗收(主 session)**:verify:panels/canvas 雙綠(canvas 需 t=0 有
overlay,以 MCP add_overlay 臨時加、跑畢 remove——demo 活動紀錄因此多兩筆,
內容差非渲染差);CDP 決定性截圖確認最終形態(工具列原尺寸/主軌 60 滿版
filmstrip+2px 浮動/其他軌 30)。

## 補記:軌道區塊改版——軌頭 gutter+雙軸捲動+Ctrl+滾輪修活(2026-08-16)

使用者定案三項:左側 32px sticky 軌頭欄(Film/Image/Captions/AudioLines,
size 13、--text-3、實底 --panel——不能用半透明 well 底,chip 捲過會透出;
每格高度與 1px 分隔線與右側軌道逐位元組同款)、軌道區可視高 TRACKS_VIEW_H=260
(原內容高 170,約 1.5 倍;超過縱捲,為 >4 軌鋪路;尺規 sticky top、交叉格
雙向 sticky)、gutter 在 contentRef 座標系**之外**(拖曳/吸附/尺規 seek 不動,
fit/縮放錨點/AI 捲動的「可視寬」一律 clientWidth−GUTTER_W)。Opus 實作,
主 session 獨立驗收。

**驗收挖出兩隻真 bug(皆已修,如實記)**:
(1) **Ctrl/⌘+滾輪縮放從功能加入起就是死的**(非本包引入):wheel listener
掛在空 deps 的 effect,Timeline 首渲染時 doc 未達、return null,listener
永遠掛不上且無錯誤——正是 ui-verification.md 記過的 useRef+空 deps 陷阱。
真瀏覽器探針抓到:事件到達容器(自掛 once listener 收到)但 defaultPrevented
恆 false。TDD 修復:Timeline.wheelzoom.test 先紅(mount 後才 seed doc,
縮放不發生)→ deps 改 hasDoc → 綠;新 mutant tl-wheel-attach-deps 守 deps
(帶突變 1 failed/還原 2 passed,gauntlet 確認擊殺)。
(2) **縮放錨點補償被舊佈局 clamp 吃掉**:zoomBy 後同步寫 scrollLeft,該幀
React 還沒按新 pps 重渲染,瀏覽器 clamp 到舊上限——實測 12 步放大後游標下
時間點漂 857px(舊碼同款寫法,只因從未掛上而無人知)。改遞延到 pps 渲染後
的 useLayoutEffect 套用,再補 el.clientLeft(well 的 1px 邊框,漏扣則每步
漂 1px,實測 4 步 5.19px)。最終真瀏覽器實測:**可捲區間內 4 步縮放漂移
0.19px(次像素),錨點釘住**。內容窄於視窗時無可捲空間、錨定物理上不可能,
屬幾何本質非缺陷。

**已知限制(Opus 回報,未修)**:clientWidth 含捲軸寬的既有誤差(macOS
overlay 捲軸為 0,Windows 差十幾 px)本包未處理;未來 >4 軌縱向捲軸出現後
「可視寬」會再被吃掉一截,啟用時要回頭補;Timeline.test 的尺規選取器
`[style*="cursor: text"]` 是脆弱耦合(本包保留了該 inline style)。

**gauntlet(source:087d902+本包工作樹,單次乾淨全跑)**:878 passed
(shared 46/server 465/ui 367,+2);UI 覆蓋率 91.88%;隨機順序×2 PASS;
錨點 123/123;**122/122 killed+1 等價對照存活如預期**(+1 新 mutant
tl-wheel-attach-deps);其餘各層全 PASS;零新增依賴。

**真瀏覽器驗收(主 session)**:verify:panels/canvas 雙綠(canvas 以 MCP
臨時 overlay 加拆);兩主題 CDP 決定性截圖+與改動前逐像素比對(僅 Inspector
版本讀數差,版面零變);橫捲證據照(gutter 釘左、chip 從底下捲過);縮放
錨點探針數字如上。HANDOFF/ui/DESIGN.md 同步(DESIGN.md 幾何常數行原載
ROW_H 64/SUB_ROW_H 24 為上一包漏更的舊值,本包一併修正為 60/30 並補
gutter 段)。

## 補記:時間軸微調包——板縮 10%+軌寬 6%+工具列縮+chip 實色底(2026-08-16)

使用者四項定案(原五項,③縮圖密度經澄清後撤回——filmstrip 是每秒真實影格,
重複感來自靜態素材,非 bug):TRACKS_VIEW_H 260→234(板縮 10%);工具列縱向
padding 2/8→1/7,總高 38→36(−5.3%,最接近 6% 的整數解,不動全域 .icon-btn);
ROW_H 60→64、SUB/AUDIO_ROW_H 30→32(+6.7%,取偶數整數,維持 2:1:1:1,gutter
格高同常數自動跟齊);三種時間軸 chip 由半透明 wash 改**實色底**。

**實色底做法**:--accent/--ok/--audio-wash 三 token 全 repo 僅時間軸三 chip
消費、CSS 內部零引用,原地轉型為 --*-chip-bg(不留死 token)。值=原 rgba 疊
軌道井底的合成,以截圖取樣校準(暗版井底 #1a1a1d 與算式全等;紙版有紙紋微染,
取樣值與算式差 ≤2/255,採信取樣)。六組:暗 #2e2021/#1e342e/#26282d、紙
#e7d9ce/#d9decf/#dadcd5。文字對比六組全部重算(--accent-text 4.99/5.35、
--ok-text 8.69/5.80、--audio-bright 6.49/5.46,全過 4.5),數字入 theme.css
註解;theme.css 兩處舊合成註記(#2b2e32、#daded0,疊 panel 算的近似)同步
改為疊井底的實值。驗收:改版後截圖 chip 內部三點取樣逐位元組等於定案值且
完全平坦(紙點不再透出)。

**文件同步**:ui/DESIGN.md 幾何常數行、Chips 段(三 chip 改列合成值)、
Red-Never-Fills 與 Do 清單補「實色合成也按光學色稽核,不看 alpha 通道」;
HANDOFF 時間軸行。

**gauntlet(source:9b301ff+本包工作樹,單次乾淨全跑)**:878 passed
(shared 46/server 465/ui 367);UI 覆蓋率 91.88%;隨機順序×2 PASS;錨點
123/123;**122/122 killed+1 等價對照存活如預期**;其餘各層全 PASS;零新增
依賴、零測試改動(純樣式與常數,行為未變)。

**真瀏覽器驗收(主 session)**:verify:panels/canvas 雙綠(canvas 以 MCP
臨時 overlay 加拆);兩主題 CDP 決定性截圖過目;chip 取樣驗證如上。

## 補記:時間軸再調——去框工具列+井高 200+軌高 70/35+粉彩 chip 家族(2026-08-16)

多輪使用者迭代定案:工具列去框(.tl-toolbar scoped ghost——無框無底、
hover --surface-2、Snap 開啟=--accent-soft 填色+加粗;border:0 再省 2px);
TRACKS_VIEW_H 234→200(三輪 260→234→200,「再讓空間給畫面」);軌高再放寬
~10%:ROW_H 64→70、SUB/AUDIO 32→35(維持 2:1:1:1;內容 195 ≤ 內距 198,
不觸發縱捲)。

**chip 換獨立粉彩家族**(多輪收斂的定案史,如實記):實色合成 →「飽和度再高
20%」×2 →「LightPink #FFB6C1 定色號,其他你配同調性——原本的跟背景同族,
怎麼加濃都像透的」→ 粉彩 +30% 飽和 →「太粉紅/太跳」→ 壓亮度成灰粉調
(HSV s.42 v.90;跳的來源是又亮又純,不是飽和)。最終:紙版 #e68593/#85e6a0/
#85bde6、暗版 #751e2b/#1c5e3c/#234d6b(同色相暗房深調);chip 文字同色相
極端階(--accent-chip-text 新 token:紙 #4f0f18/暗 #ffc4cd;--audio-bright
兩主題改 #123a5e/#a8cce8),六組對比 5.07–7.10 全過 4.5,值與算式入
theme.css 註解。

**設計系統修訂**(ui/DESIGN.md):Red-Never-Fills 開「粉彩 chip 家族」正式
例外(粉彩錨定 LightPink,不是標記紅;紅家族填色仍禁);Chips 段改列色板
與對比;Buttons 段記 .tl-toolbar ghost 例外;Per-Consumer 段改「三種顏料」;
frontmatter 色表同步(tape-blue-bright/non-photo-blue-deep 換值+chip 家族
八色)。HANDOFF 時間軸行同步。

**gauntlet(source:085d7b7+本包工作樹,單次乾淨全跑)**:878 passed
(shared 46/server 465/ui 367);UI 覆蓋率 91.88%;隨機順序×2 PASS;錨點
123/123;**122/122 killed+1 等價對照存活如預期**;其餘各層全 PASS;零新增
依賴、零測試改動(純樣式與常數)。

**真瀏覽器驗收(主 session)**:verify:panels/canvas 雙綠(canvas 以 MCP
臨時 overlay 加拆);兩主題 CDP 截圖逐輪過目(含臨時 overlay 展示綠 chip,
拍畢即拆);chip 取樣驗證各輪色值逐位元組等於定案值。

## 補記:版面重構——AI 全高左欄+右欄整合+時間軸右移(2026-08-16)

使用者定案(一次修正收斂:「整個移往右邊,把下面的軌道也往右移動」):header
全寬不動;其下左=AI 專區全高縱欄(三態狀態卡+完整活動流,原 Inspector AI
區塊與右欄 Activity 分頁合體),右=舞台+右欄(Captions ⇄ Properties)在上、
時間軸在下(從 AI 欄右緣開始)。原 Properties 左欄退役,其內容(Canvas fill
/選取表單/Shortcuts/閒置提示)整合進右欄 Properties 分頁;選取任何物件右欄
自動跳 Properties,取消選取不跳走。AgentStrip 留 header,點擊改為展開左欄
(openLeft,新 store action)。Opus 實作,主 session 獨立驗收。

**骨架實作要點**(Opus 報告):維持單一 CSS grid(3 欄×2 列)而非巢狀
flex——PanelResizer 以同一容器 rect 換算指標座標,拆兩層會讓左右兩式量到
不同原點;AI 欄 gridRow '1/3'、時間軸 gridColumn '2/4'。Timeline.tsx 零改動
(量自己容器,AI 欄收合時自動變寬)。

**測試搬家零弱化**:367→377(+10)。19 條 agent 測試移 AgentPanel.test.tsx;
兩條斷言實質調整均有記錄:N2 反轉(「選取後 agent 區塊消失」是舊寄居處的
副作用而非需求,改斷言反向)、B6 範圍收斂到 .panel-section(欄內現有完整
活動流,「最近三筆」斷言本意如此)。11 隻 mutant 重錨(find 逐位元組不變,
僅 file/tests/note),逐隻正規驗殺(帶突變紅/還原綠,數字入 Opus 報告);
另 5 隻鄰近 mutant 複驗未破。

**主 session 驗收**:verify:panels 首跑紅——e2e 腳本按鈕 title 還是舊版面
(Collapse properties panel 等),同步為 Collapse/Expand AI panel 與
captions/properties 後全綠(驗證器跟上新版面,非弱化);verify:canvas 綠
(MCP 臨時 overlay 加拆);行為四項真瀏覽器實測全過(點 clip→Properties
表單、Esc→閒置提示、收合→0px、點 AgentStrip→展回 260px);Esc/data-tl-blank
deselect 路徑 diff 為空;兩主題 CDP 截圖過目。

**gauntlet(source:da46842+本包工作樹,單次乾淨全跑)**:888 passed
(shared 46/server 465/ui 377);UI 覆蓋率 91.95%;隨機順序×2 PASS;錨點
123/123;**122/122 killed+1 等價對照存活如預期**;其餘各層全 PASS;零新增
依賴。

**已知事項(如實記)**:Activity 自帶的 Undo/Redo 列現坐 AI 欄中段(狀態卡
與流水帳之間),截圖判斷成立,使用者可再調;shortcuts.ts 的 Esc 條目未提
「Properties 回閒置提示」(onKey 未變,措辭候選);--wave-clip-* 仍無消費者。

## 補記:header 整併+AI 欄調寬+減線+尺規刻度(2026-08-17)

八項使用者逐項定案的微調,主 session 自做(未派 Opus):

1. **主題切換器上 header(icon-only)**:新檔 ui/src/ThemeToggle.tsx,從
   Properties 的 Shortcuts 彈出層搬出(舊落點「可發現性低」是記錄在案的已知
   限制,正式解掉)。icon 顯示按下去會去的那一面(暗房給 Sun/紙給 Moon),
   title 為唯一文字標籤。測試搬家 panels/themeToggle.test.tsx→
   ui/src/ThemeToggle.test.tsx(5 條斷言;「標籤英文」原驗 textContent,
   icon-only 為空,改驗 title 非空+無 CJK——意圖不變,檔內有記)。
   theme-toggle-aria mutant 重錨到新檔,正規驗殺:帶突變 2 failed/還原 5 passed。
2. **header 移除 `v0.1.0 · demo` 字樣**:連鎖三處如實記——header-shows-rev
   mutant 因目標碼被定案移除而**退役(123→122)**;app-version.test B1 改斷
   「標頭不顯示任何版本字樣」(not.toMatch semver,較原斷言更嚴);App.test
   'mounts again' 的 `demo` 斷言改驗 `clip one`(專案掛載改由內容證明)。
3. **AI 欄預設寬 325(+25%)**:panelResize.ts default 260→325;stores/view.ts
   loadWidths 遷移——localStorage 存的舊預設 260 視為「未自訂」丟棄,已自訂
   的其他值保留。
4. **活動流行距收密**:Activity.tsx 與 AgentPanel.tsx 的流水帳列
   padding '1px 0'+lineHeight 1.3。
5. **紙版工具列 ghost 補漏**(使用者抓到「去匡沒做?」——da46842 的漏網):
   成因是特異性,`[data-theme='paper'] button:not(.btn-primary):not(.ap-strip)`
   (0,3,1) 蓋過 `.tl-toolbar` 基本規則 (0,2,0);theme.css 補紙版 scoped 三條
   同級後出規則(icon-btn 兩型 transparent、seg.on 填 accent-soft)。
6. **減線**:CaptionList 列間 1px 線移除(列辨識靠 padding 節奏與 hover/選取
   底色);Timeline 軌道間線移除,gutter 側三格+音訊列同步(兩側 byte-identical
   地無線)。
7. **尺規底線降階**:--line-strong→--line(交叉角落格同步),保留為井內唯一
   結構線。
8. **尺規刻度**(AskUserQuestion 使用者選「4 格」):貼尺規帶底緣的豎線,
   整秒主刻度 6px/--line,每格 4 等分小刻度 3px/55% 透明度,間距隨 tickStep
   縮放自適應,不進軌道區。

**過程事件(如實記)**:包內兩次中停 gauntlet(改動追加)各留下一隻突變中
的殘留 mutant——`import-basename`(server/src/app.ts,防 path-traversal 的
basename 被拆)與 `app-react185`(CaptionList.tsx)。均由「git status 對照
包檔案清單→git diff 驗明→定點 python replace 還原(不用 git checkout,避免
洗掉未 commit 改動)→`mutate.mjs --check` 122/122 復驗」收拾。最終數字一律
取下方乾淨全跑,不取中途輪次。

**gauntlet(source:ba1d5c3+本包工作樹,單次乾淨全跑,2026-08-17)**:
888 passed(shared 46/server 465/ui 377);UI 覆蓋率 91.42%;隨機順序×2
PASS;錨點 122/122;**121/121 killed+1 等價對照存活如預期**;文件引用/
使用者面字串/秘密掃描全 PASS;零新增依賴。ui/DESIGN.md 的 Timeline region
段落(「1px borders byte-identical」因減線不再成立)於 gauntlet 完跑後同步,
prettier --check 與 docs-check 單獨複跑皆綠(如實記:該兩層的全跑數字涵蓋
的是同步前內容)。

**已知事項**:最終刻度特寫截圖因機器高負載(使用者自身程序 319% CPU、
load 16.7)CDP 連續逾時未拍成,使用者已直接在 :3845 瀏覽器過目並核可
(「可以了」);muted/frozen 的時間軸線索、scrollTargetFor/fit 未扣捲軸寬
(Windows)等既有已知限制不變。

## 補記:AI 聊天——ChatStore+WS+MCP post_chat/get_chat+左欄 Chat 分頁(2026-08-17)

使用者核准的計劃,Opus 實作、主 session 獨立驗收。

**架構定調**:聊天是人⇄AI 的 meta 溝通,**不是編輯**——不進 doc、不走
applyCommand、不進版本/歷史/undo(Cmd+Z 不該撤掉一句話)。持久化在與
project.json 同目錄的 `chat.json`(debounce 500ms+tmp→rename 原子替換,
載入全容錯:壞檔=空清單、壞單筆只丟該筆)。單則上限 `CHAT_MAX_LEN`(4000)
由 WS 與 MCP 兩個入口**共用一份常數**。WS `sendChatMessage` 驗證在命令層
(壞訊息靜默丟棄,刻意不發 commandError——那會顯示成「Edit rejected」);
broadcast 每次送整份清單(增量同步的複雜度聊天不值得再付一次);連線時
即送(空清單也送,UI 才知道「載入完成」)。MCP `get_chat`(readOnly,
limit 有 slice(-0) 分流)/`post_chat`(空白拒絕),三步鐵則第三步完成:
registerTool+instructions 同步(明示 not an editing path、不 block、
要 block 用 request_review);mcp-surface-snapshot 先讀 diff 再 -u,diff
恰為兩個新工具+一段 instructions,既有工具零變動。UI:左欄 Chat⇄Activity
分頁沿用右欄 `.seg` 語彙,**索引卡恆頂不進分頁**;Chat 無泡泡,署名分色
(--who-ai/--who-you,對比皆 ≥4.5 有記錄);草稿住 store(斷線/切分頁
重掛不吃字);offline 輸入 disabled 草稿保留;AgentStrip 未讀徽章
(`.badge` 復用,aria-label 帶數);jsdom 補 `Element.scrollTo` polyfill。

**Opus 測試**:RED-first,+40 server/+46 ui。斷言調整兩處(範圍精確化,
非弱化,均有記):AgentTabs 分頁切換斷言收斂到分頁 body(狀態卡恆頂,
整欄斷言會變成「要求卡消失」);mcp-chat 的 get_chat 補 `arguments: {}`
(MCP SDK 對 object-schema 工具一律要求,經 get_editor_context 對照證實
是測試錯不是產品錯)。Opus 自抓一個測試競態:server 的 full 與初始 chat
同 tick 送達,先消費 full 再掛 chat listener 就永遠等不到——改成連線起即
緩衝的 Conn 類+游標等待,隔離連跑 8/8 綠+全套連跑 2/2 綠(不是用 retry
或加長 timeout 蓋掉)。

**主 session 驗收抓到一個真 bug(TDD 修)**:store 的首載判準用
`prev.messages === NO_MESSAGES` 推斷——空歷史專案首份記錄就是空清單,
reference 不變,**第二份(AI 開口的第一句)被誤判成首載而不計未讀**,
恰是新專案最常見路徑;現有計數測試全用非空首份墊底所以沒咬到。修法:
顯式 `loaded` 旗標。紅測試(1 failed/15 passed)→修→16/16 綠(beforeEach
補重置新欄位屬 setup 修繕,斷言零動);新 mutant `chat-unread-first-real`
(精確重現原 bug)驗殺:帶突變紅/還原綠。127→**128 隻**。

**實機驗收**(:3845 由外部程序占用且 kill 受權限限制,改在 :3846 以
demo 複本起第二台新碼 server,:3845 不動):真 MCP 協議呼叫
(StreamableHTTP JSON-RPC)——tools/list 見兩工具、post_chat 寫入、
get_chat 讀回、limit:0 回 0 筆、空白 post isError、chat.json 落盤逐欄
正確;CDP 行為探針兩主題各 8/8:首載歷史不計未讀、MCP post_chat 後
strip 徽章=1、Chat 分頁鈕帶計數、開分頁訊息可見+清零、Enter 送出進列表
+輸入框清空、server get_chat 收到 user 訊息(author/text 正確);
兩主題截圖過目(署名分色、無泡泡、狀態卡恆頂、輸入列貼底);
VIDCUT_URL 指 :3846 跑 verify:panels 全綠。探針首輪一項紅是探針自身
regex 筆誤(`\\s`),修探針後紙輪 8/8(非產品問題,如實記)。

**環境事件(如實記)**:impeccable 設計 hook 的 `ui/.impeccable/
hook.cache.json` 只被 .git/info/exclude 擋,prettier 3 看不見 info/exclude
→ format:check 在 UI 編輯後開始紅;進 `.prettierignore`(生成物,與
snapshot 同理)。

**gauntlet(source:966b763+本包工作樹,單次乾淨全跑,2026-08-17)**:
**975 passed**(shared 46/server 505/ui 424);UI 覆蓋率 91.58%;隨機
順序×2 PASS;錨點 128/128;**127/127 killed+1 等價對照存活如預期**;
文件引用/使用者面字串/秘密掃描全 PASS;零新增依賴。本補記於 gauntlet
完跑後寫入,prettier --check 與 docs-check 單獨複跑皆綠(如實記)。

**已知限制**:聊天記錄無保留/裁剪政策(單則 4000 上限但整份無上限),
長期專案累積前值得定案;:3845 那台 server 仍跑舊碼,**要重啟才有聊天
功能**;Chat 輸入是單行 `<input>`(註解提到 Shift+Enter 留給換行是
措辭超前,實際單行——候選改進)。

## 補記:Chat 面板改版——composer 放大+引用卡+狀態卡拆分(2026-08-17)

使用者以競品截圖定案(參考 Descript Underlord/ChatGPT-Cursor composer
慣例,經 WebSearch 研究後計劃、逐項拍板),Opus 實作、主 session 獨立驗收。

**A. Composer**:`<input>` 換 auto-grow `<textarea>`(rows 3 起、
`scrollHeight` 量測、8 行封頂 136px 後內捲;useLayoutEffect+先歸零再讀,
刪字會縮);Enter 送出/Shift+Enter 真換行(順手解掉上一包「措辭超前」
已知限制);圓形 28px accent 實色送出鈕(`--accent`/`--on-accent`,
DESIGN.md「唯一實心亮塊」語彙第二個消費者;圓形為記錄在案的例外);
輸入卡 `.chat-composer`(`--panel-2` 新 token+1px 線,聚焦環
:focus-within 畫在卡上);placeholder 改指令式。**B. 引用卡**:使用者
訊息 `.chat-quote`(`--panel-2`),AI 維持無框正文——「無泡泡」定案的
單側修訂,理由與例外記進 DESIGN.md(新節+2 Don'ts);署名列兩側保留。
**C. 狀態卡拆分**:AgentStatus 加 `compact` prop(core/extras,不拆
元件避免三態推導分岔),Chat 分頁隱藏「最近三筆+No edits yet.」,
恆頂定案不動。**D**:空狀態改邀請句。`--panel-2` 兩主題實算對比全
≥4.5(暗 11.87/6.06/4.56;紙 12.94/7.77/5.48),對 `--panel` 僅
~1.08,邊界靠 1px 結構線(與索引卡同法)。

**Opus 測試**:+16 UI(RED 先行 11 紅各紅其所);斷言調整兩處均為
加嚴/範圍精確化(input→textarea 由新測試 S1 釘死「textarea 存在且無
input[type=text]」;「無泡泡」與「引用卡」斷言並存)。**Opus 自抓一隻
假斷言**:`chat-autogrow-uncapped` 首輪存活——原 S3 只斷 maxHeight
style 宣告面,看不見 JS clamp 被刪;改 stub scrollHeight 直接觀測
Math.min(51 長/1000 壓 136)後擊殺,不接受存活。mutant 128→132
(重錨 1+新 4),17/17 驗殺(含 5 隻既有 chat mutant 迴歸)。

**主 session 驗收抓到一個真 bug(紙版送出鈕 ghost 化)**:
`[data-theme='paper'] button:not(.btn-primary):not(.ap-strip)` (0,3,1)
蓋掉 `.chat-send` (0,1,0),紙上送出鈕變白底 ghost——與包2 `.tl-toolbar`
同類特異性坑,**首輪探針只驗形狀沒驗底色所以差點放過**;加嚴探針
(底色必須等於 `--accent` 實算 rgb)紅→theme.css 補紙版 scoped 同級
後出三條→綠。CDP 行為探針兩主題各 14/14:空狀態句、compact(Chat 無
No edits yet./Activity 有)、textarea 初始 51px、20 行封頂 136+內捲、
5 行 85px(真的隨內容長)、Shift+Enter 不送出草稿在、Enter 送多行+
pre-wrap 保留+送後縮回 51、AI 無引用卡、送出鈕圓形+accent 實色——
**auto-grow 與顏色都在真瀏覽器證實**(Opus 明列的兩個未驗項);兩主題
截圖過目。紙輪首見的空狀態紅為探針狀態殘留(暗輪已寫入訊息),探針
改為僅首輪驗空狀態(如實記)。

**gauntlet(source:648a632+本包工作樹,單次乾淨全跑,2026-08-17)**:
**991 passed**(shared 46/server 505/ui 440);UI 覆蓋率 91.62%;隨機
順序×2 PASS;錨點 132/132;**131/131 killed+1 等價對照存活如預期**;
其餘各層全 PASS;零新增依賴。本補記於完跑後寫入,prettier/docs-check
單獨複跑綠(如實記)。

**已知限制**:`LINE_H=17` 為 1.4×12 的取整,改字級/行高時 3/8 行目標
會微漂(常數具名有註);Shift+Enter 的合成鍵盤事件不會真的插入換行
(探針以「不送出+草稿保留」驗,真換行由多行送出案證);:3845 現由
另一 session(cloud-p0 worktree)佔用,本包驗收全程在 :3846,main 線
的新 UI 要等該 session 釋出 port 或另起 port 看。

## 補記:狀態卡搬進 Activity 分頁(2026-08-17)

使用者定案:「Agent ready 的顯示放到 activity 裡面,這樣 chat 空間更大」
——對同日早上「恆頂+compact」定案的**正式反轉**,主 session 自做(TDD)。

**實作**:AgentPanel 分頁列升到欄頂;Activity 分頁內部=完整狀態卡
(flex none 固定在頂)+活動流捲動;**Chat 分頁不渲染卡**,對話區直接
接在分頁列下。理由:三態不消失——header AgentStrip 恆在且同源推導,
卡是第二份。`compact` prop 活了一包即退役(卡只剩一個落點,永遠完整版)。
HANDOFF/DESIGN.md 兩處定案敘述同步改寫。

**TDD**:AgentTabs 四條契約斷言先反轉(恆頂→只在 Activity、DOM 順序
鏡像、compact 兩條併為「完整卡 Activity-only」),紅 3/8 各紅其所→實作
→65 條相關測試全綠;UI 總數 440→439(五條改寫為四條,規格反轉非弱化,
檔內有記)。mutant:`inspector-agent-block` 重錨到分頁內渲染點(語意
不變)、`agent-card-extras-always` 退役(目標碼消失)、新增
`agent-card-on-chat`(Chat 分頁又冒出卡=修訂失守);兩隻各 1/1 驗殺,
132 隻總數不變。

**實機驗收**(:3846,CDP 兩主題各 4/4):Activity 卡在且分頁列在上、
Chat 無卡無 No edits yet.、composer 仍在、**Chat 訊息區頂緣與分頁列
底緣重合**(空間變大的直接證據:body 高 609/608px);截圖過目。

**過程事件(如實記)**:包5 首次 gauntlet(`bt82tut6t`)顯示輪 server
套件 1 failed/504——gauntlet 套件層跑兩次(顯示輪+判定輪),判定輪綠
故印 PASS。追根:包3 的 ws-chat.test 存在真 flaky(~1/4 全跑),
`connect()` 只等 full 不等**初始 chat**,游標可能在初始空清單抵達前
讀取,`waitFor('chat', from)` 撈到初始空清單→斷言見 [](Conn 緩衝
治了「訊息比 listener 早到」,漏了鏡像「游標比初始訊息早讀」)。修
connect() 補等初始 chat;修後單檔 8/8+全套 2/2 綠(修前重現 2/6)。
依「數字取最後編輯後乾淨全跑」紀律在合併樹重跑 gauntlet。

**gauntlet(source:1021f39+包5+flake 修復,單次乾淨全跑,含顯示輪
三套全綠)**:**990 passed**(shared 46/server 505/ui 439);UI 覆蓋率
91.63%;隨機順序×2 PASS;錨點 132/132;**131/131 killed+1 等價對照**;
其餘各層全 PASS;零新增依賴。分兩筆 commit(包5、flake 修復),兩個
commit 點各有對應的 gauntlet 全綠(bt82tut6t 蓋包5 樹、本輪蓋合併樹)。
本補記於完跑後寫入,prettier/docs-check 單獨複跑綠(如實記)。

## 補記:Chat 競品化第二輪——文字分頁+人右AI左+composer 呼吸(2026-08-18)

使用者四項定案(經 WebSearch 研究競品慣例後拍板),主 session 自做(TDD,
紅 13 條先行);含**使用者自改收編**(AgentStatus 的「AI agent」panel-head
標題由使用者自行移除,收進本包,錨點復驗 132/132 未受影響)。

**A. 文字型分頁列**:`.seg` 框鈕退場,`.tab-link` 透明底文字鈕(當前
`.on` 靠字重+文字階)+`.tab-divider` 樣式化豎線(刻意不用全形「｜」
字面值——i18n 層掃 CJK 字面值,且樣式線粗細/顏色可控);右欄 .seg 不動,
兩欄分頁刻意分化。紙版第三次同型特異性坑(通用鈕規則 (0,3,1) 蓋
transparent)以 scoped 同級後出規則先行補上。**B. 左欄頂「AI」列移除**:
收合鈕搬進分頁列右端(title 不變,verify:panels 免改),新增「點擊後
leftOpen=false」行為斷言(不只驗存在,防搬家斷線)。**C. 人右 AI 左**:
訊息列 alignItems 依 author(引用卡 max-width 85%——全寬的靠右讀不出
靠右),AI 正文靠左全寬;對齊差=署名色外的第二作者線索(a11y 不只靠
顏色)。**D. composer 呼吸+更圓**:`.panel-bar` 分隔線退場,輸入卡四周
12px(對列表 8px)不再貼死欄底;composer/引用卡圓角升為 chat 專屬 14px
(--r-card 全域階不動,兩主題同值,DESIGN.md 記為 chat 語彙例外)。

**測試**:441(+2 淨:分頁樣式契約改寫、收合鈕行為、對齊各一條;
AgentPanel 兩條 `toContain('AI agent')` 隨使用者自改改驗 `.ap-card`
本體——對象換強度不減,檔內有記)。**mutant 132→134**:新
`chat-align-user-right`(對齊抹平)、`chat-tabs-collapse-wire`(收合鈕
onClick 斷線),各 1/1 正規驗殺;既有錨點全數未失配。

**實機驗收**(:3846,CDP 兩主題各 9/9):無 .seg/兩顆 tab-link/1px
豎線、舊 AI 頭列不在、收合→0px 展開→325px、user 卡右縫 8px+左留白
193px、AI 正文左縫 8px、卡寬 124≤85%、圓角 14px、底部呼吸 12px+
不在 .panel-bar;兩主題截圖過目。verify:panels 全綠(title 未變免改)。

**gauntlet(source:3763e0f+本包工作樹,單次乾淨全跑,顯示輪三套
全綠)**:**992 passed**(shared 46/server 505/ui 441);UI 覆蓋率
91.64%;隨機順序×2 PASS;錨點 134/134;**133/133 killed+1 等價對照**;
其餘各層全 PASS;零新增依賴。本補記於完跑後寫入,prettier/docs-check
單獨複跑綠(如實記)。

**已知事項**:impeccable hook 於 App.tsx 標記既有的
`rgba(248,113,113,0.4)`(danger toast 邊框)為 palette 外字面值——
非本包引入,未動,留使用者裁決;分頁文字鈕的 hover 只變文字階不帶底
(刻意,輕分頁語彙)。

## 補記:Chat 署名字樣退場(2026-08-18)

使用者定案:「講話不用放 you 或 AI,只要對話框就好」——署名列自 Chat
移除(取代前一包才立的「署名列兩側保留」,一日壽命規則如實記)。視覺
作者線索=對齊(人右/AI 左)+單側引用卡,已足;**讀屏不能只靠版面**,
作者改掛訊息列 `aria-label`(You/AI),語意不丟。`--who-*` 分色 token
只剩索引卡/活動流在用,Chat 退出。主 session 自做(TDD:aria 測試先紅
1/28 → 實作 → 28/28)。

**測試**:ui 441→440(署名列測試依規格移除、aria-label 測試接手——
規格反轉非弱化,檔內有記;「--who-* token 接線」測試改寫為「無可見
You/AI 字樣+aria 逐列正確」)。**mutant 135 隻**(+`chat-msg-aria-author`:
aria-label 被拔=作者變成明眼人限定;1/1 驗殺,帶突變紅/還原綠)。

**實機驗收**(:3846,CDP 兩主題):訊息區零 You/AI 署名 span、5 列
aria-label 值恰為 {You, AI};截圖過目(純對話框,右卡左文)。DESIGN.md
署名段落改寫(含兩條稽核判準:AI 側永不得有框、訊息列永不得丟
aria-label);HANDOFF 同步。

**gauntlet(source:2eecb97+本包工作樹,單次乾淨全跑,顯示輪三套
全綠)**:**991 passed**(shared 46/server 505/ui 440);UI 覆蓋率
91.62%;隨機順序×2 PASS;錨點 135/135;**134/134 killed+1 等價對照**;
其餘各層全 PASS;零新增依賴。本補記於完跑後寫入,prettier/docs-check
單獨複跑綠(如實記)。

**環境事件(如實記)**:main 於本包進行中被另一 session 推進一筆
`2eecb97`(CLAUDE.md 補 Mograph 行,docs only,無檔案交集);該 commit
的表格未過 prettier(乾淨 checkout 會 format:check 紅),本包順手以
獨立 style commit 補格式(純空白 diff)。

## 補記:發佈包 P0（2026-08-21）

功能:`export_publish_package`（render 成品打包供手動上傳；四平台 tiktok/youtube/instagram/facebook；kind short|video 決定警告門檻）。

**行為→測試對映**:`server/test/publish.test.ts` 21 tests（setPublish 命令 4、resolveKind 3、platformWarnings 6、metaToText 2、UPLOAD_URLS 1、buildPublishPackage 5——真檔案落盤斷言）;`server/test/mcp-publish.test.ts` 3（InMemoryTransport 真工具呼叫）;`ui/src/panels/ExportMenu.test.tsx` 3（done 無包/done 有包/idle）;`mcp-surface-snapshot` 與 `mcp-docs-sync` 閘門綠（snapshot 讀 diff 後 -u）。

**gauntlet(source:056bd80+本包工作樹,單次乾淨全跑,顯示輪三套全綠)**:**全數通過**；shared 46 / server 529 / ui 443 passed（合計 1018）；UI 覆蓋率；隨機順序×2 PASS；**134/134 mutants killed（+1 等價對照如預期存活）**；docs-check 綠（7 份斷言型文件）；其餘各層全 PASS；零新增依賴。本補記於完跑後寫入,prettier/docs-check 單獨複跑綠(如實記)。

**誠實註記**:本功能未新增 mutants（純新增模組，未列入 `scripts/mutants.json`）；gauntlet 的 prettier 層寫回數個檔案的純格式重排，以獨立 style commit 收（見前一筆 commit）；cover-exists 與空字幕兩條分支無測試（brief 原文如此，已記於 SDD ledger）。

**綁定 commit**:本段寫入時 HEAD 為 `056bd80`。
