# EVIDENCE — vidcut 全功能驗證

依 `docs/superpowers/specs/2026-08-01-full-verification.md`（使用者 2026-08-01 核准全套執行）。
**Spec approval: obtained**（使用者核准後才動工）。

一鍵重跑本報告的每個數字：`bash scripts/gauntlet.sh`
下列所有數字皆出自**最後一次程式碼修改之後的單一次乾淨執行**。

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
換掉 `render.ts`／`ingest.ts` 原本四處 `join(projectDir, media.path)` 的硬接法。

## 行為 → 測試對映

| 行為                                                                                                                                                                                                                           | 測試                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveMediaPath`：相對接在專案下／絕對原樣回傳／`..` 正規化／空字串回專案本身                                                                                                                                                | `server/test/paths.test.ts`（4 條，Task 1）                                                                                                             |
| 四處呼叫端換成 `resolveMediaPath`（render.ts ×3、ingest.ts）                                                                                                                                                                   | `server/test/ingest.test.ts`「可以 ingest 專案資料夾外的絕對路徑」；`server/test/render.test.ts`「輸出吃專案外絕對路徑的素材」（Task 1／2）             |
| `asr.ts` 同型缺口（Task 1 審查發現、升級為 Task 2 範圍）                                                                                                                                                                       | Task 2 新增測試（本 Task 未動 `asr.ts`，沿用既有覆蓋）                                                                                                  |
| `scanSourceFolder`：白名單副檔名、大小寫、排除隱藏檔、不遞迴、大小/mtime、symlink 收錄、斷 symlink 略過、非 ASCII/空白檔名、略過子目錄、目錄不存在丟錯、傳入檔案丟錯、位元組序穩健排序                                         | `server/test/sourceFolder.test.ts`（12 條，Task 4）                                                                                                     |
| `GET /api/source`：列出檔案、`imported` 標記（含相對路徑素材）、400（目錄不存在／沒帶 dir）                                                                                                                                    | `server/test/source-api.test.ts`（5 條，Task 5；commit `9dccca1`=前 4 條、`4103b35`=第 5 條殺 `resolveMediaPath` 缺口）                                 |
| `ingestMedia` 接受絕對路徑、同絕對路徑冪等回同 id                                                                                                                                                                              | `server/test/ingest.test.ts`「可以 ingest…」「同一個絕對路徑重複 ingest 回同一個 id」                                                                   |
| `addClip` command：append 到主軌尾端、未知 mediaId 拒絕、duration≤0 拒絕、in+duration 超界拒絕、剛好用滿允許、浮點誤差 1e-6 容差                                                                                               | `server/test/commands.test.ts`「addClip」describe 區塊（6 條，Task 3；含審查後補的浮點邊界測試）                                                        |
| `POST /api/import`：匯入進 `doc.media` 且原檔不複製、`addToTimeline` 接到主軌尾端、壞檔進 `failed[]` 其餘繼續、400（缺 dir/names）、`basename` 防 traversal（相對／絕對兩種敵意輸入）、逐支序列處理不變式（`maxInFlight===1`） | `server/test/import-api.test.ts`（7 條，Task 6；審查後補誘餌檔堵假殺、補序列不變式觀測測試）                                                            |
| MCP `import_media` 說明更新（接受絕對路徑）                                                                                                                                                                                    | 透過 `server/test/mcp-tools.test.ts` 的 `import_media` 呼叫間接覆蓋（工具本身只是 `ingestMedia` 的薄殼，行為驗證落在 `ingest.test.ts`）                 |
| ingest 中途失敗清掉半成品 `derived/<id>/`                                                                                                                                                                                      | `server/test/ingest.test.ts`「ingest 失敗不留下半成品 derived 目錄」「（補 Step 3 的殺傷力）proxy 編碼寫檔失敗時…也會被清掉」（Task 7）                 |
| render 輸出前缺檔預檢，錯誤訊息 `/^render: 找不到素材原檔：/`                                                                                                                                                                  | `server/test/render.test.ts`「素材原檔不見時，輸出丟出含路徑的明確錯誤」（Task 7）＋本 Task 新增「frozen clip 的素材原檔不見時…」（守住預檢的**位置**） |

## Baseline 與最終 GAUNTLET

**開工前**（commit `6cb9107`，Task 7 收尾）：測試數為 **397**（shared 27／server
200／ui 170）——引用自 `task-7-report.md` 該次 `bash scripts/gauntlet.sh --fast` 的
實際輸出（`Tests 27 passed (27)` / `Tests 200 passed (200)` / `Tests 170 passed (170)`，
tsc/eslint/prettier/隨機順序/秘密掃描皆 PASS），**非本 Task 重新執行的數字**。
`--fast` 只跳過最後一關突變測試，其餘關卡 Task 7 已證實不受影響（見
`task-7-report.md`「問題與發現」第 3 點），所以測試數與格式/型別結果可信；但也代表
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
紅色輸出（`expected 3 to be 1`），於是正式收進清單而非留成文字記錄，見
task-8-report.md 第 2.3 節的完整過程與紅燈輸出。

## Failure Model 覆蓋情況

依 spec 的「錯誤處理」表逐條核對：

| 情況                             | 規劃行為                                   | 覆蓋狀態                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 素材夾不存在／非目錄             | `400 { error }`                            | **已覆蓋**——`source-api.test.ts`「目錄不存在回 400」；`sourceFolder.test.ts`「目錄不存在時丟錯」「傳入的是檔案而非目錄時丟錯」                                              |
| 素材夾無權限                     | `400 { error }`（與上面同一條 catch 路徑） | **已知限制**——與「目錄不存在」共用同一個錯誤處理分支，但沒有專屬測資模擬權限拒絕；Task 5 審查時已記錄的既有 minor deferred 項目，非本次新增缺口                             |
| 單一檔 probe 失敗                | 進 `failed[]`，其餘繼續                    | **已覆蓋**——`import-api.test.ts`「壞檔進 failed，其餘繼續」；真實執行層額外實測 `nope.mp4`（不存在的檔）進 `failed[]`，其餘兩支正常匯入                                     |
| ingest 中途失敗                  | 清掉該支 `derived/<id>/`，不留半成品       | **已覆蓋**——`ingest.test.ts` 兩條 + 本 Task 新增 `ingest-cleanup` 突變把它納入自動回歸                                                                                      |
| 已匯入但原檔被移走：素材庫標離線 | 列素材時對解析後路徑做一次 `existsSync`    | **已知限制／階段 2 範圍**——這屬於素材庫 UI 面板（spec 階段 2），階段 1 後端沒有這個 API 欄位，非本次遺漏，屬設計上延後                                                      |
| 已匯入但原檔被移走：輸出前檢查   | 輸出前檢查缺檔並回明確錯誤                 | **已覆蓋**——`render.test.ts` 兩條斷言 `/^render: 找不到素材原檔：/`（既有一條測非 frozen clip、本 Task 新增一條測 frozen clip，堵住預檢位置的回歸）+ `render-precheck` 突變 |
| 審核進行中                       | 沿用既有守衛，不另立規則                   | **未變更，不在本次範圍**——本階段沒有新增寫入路徑繞過 `applyCommand`／`aiWrite`                                                                                              |

## 跳過與已知限制

- 併發匯入同一支素材：`ingestMedia` 冪等檢查是 read-then-write（先查 `doc.media` 有無
  該 `path`，查無才動手 ingest），未覆蓋兩個並發請求同時匯入同一支素材的競態。
- 巨大素材夾無上限、磁碟寫滿：未覆蓋。
- 既有的 8 條順序相依測試（`store-undo` / `store-durability`）：本次未觸碰，非新增。
- `commands.ts:155`（`updateClip`）與 `commands.ts:497`（`updateAudio`）另有兩處
  與 `addClip`（`commands.ts:218`）相同形狀的 `+ 1e-6` 浮點容差，`.superpowers/sdd/
2026-08-03-media-import-backend/progress.md` 裡 Task 3 遺留一則「Task 8 做突變時
  一併查」的備註。本次 controller 給的四點修正明確只把範圍限定在 `addClip`
  （`addclip-bounds`），為了不擅自擴大變更範圍，這裡只記錄觀察、未新增測試或
  mutant，留給後續 Task 決定是否要補。
- `GET /api/source?dir=` 的「無權限」400 分支沒有專屬測資（見上表）。

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

完整 curl 請求與回應貼在 `task-8-report.md` 第 5 節。這一層沒有跳過。

## 需要你親自驗

- 用真實手機素材（非 `testsrc2` 合成片）跑一次完整匯入，確認各種常見編碼／容器
  （HEVC、直式手機拍攝的旋轉 metadata）下 `ingestMedia` 的 proxy/filmstrip/peaks
  都正常產出。
- 確認外部素材（零複製引用）輸出的畫質與原檔一致（本次驗證只測了「有沒有輸出」，
  沒有逐幀比對畫質）。
- 素材夾內含大量檔案（數百支以上）時 `GET /api/source` 的實際延遲——目前沒有上限
  防護，也沒有效能測試。
