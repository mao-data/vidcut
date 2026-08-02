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
