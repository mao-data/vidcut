# HANDOFF — vidcut 開發交接

> 目前做到哪、怎麼驗、已知限制、下一步。
> 最後更新：M1–M4 + T1 + T2#8（自動字幕）+ UI 重設計 + 字幕 WYSIWYG 階段 1（光柵器地基）完成。

## 現況總覽

| 里程碑         | 狀態         | 內容                                                               |
| -------------- | ------------ | ------------------------------------------------------------------ |
| M1 看得到      | ✅ `m1-done` | ProjectStore + WS 同步 + ffmpeg ingest + 唯讀時間軸 + A/B 無縫預覽 |
| M2 改得動      | ✅ `m2-done` | 命令層 + trim 拖拉 + 排序 + Inspector 編輯 + undo + 活動面板       |
| M3 AI 接上     | ✅ `m3-done` | MCP server（15 工具）+ request_review 審核閉環 + 編輯脈絡回報      |
| M4 渲染        | ✅ `m4-done` | ffmpeg 從 project.json 輸出 1080×1920 成品 + 進度 + UI 渲染鈕      |
| T1 CapCut 快贏 | ✅ `t1-done` | 見下節                                                             |
| T2 #8 自動字幕 | ✅           | whisper 逐字稿 + 自動斷句 + 逐詞高亮 + 字幕列表 UI，見下節         |
| UI 重設計      | ✅           | 深藍紫玻璃視覺系統 + 峰值/RMS 波形 + GSAP 動效，見下節             |
| 字幕 WYSIWYG 階段 1/4 | ✅（分支 `caption-wysiwyg`） | Pillow 常駐光柵器 + 字型表 + 字卡快取服務 + 字幕卡 debounce 同步，見下節。**階段 2–4（可編輯文字 overlay、預覽字卡直出、畫布拖曳）尚未開始**——目前只有後端地基，UI 沒有任何可見變化。 |

**自動化狀態**：182 個測試（shared 27 / server 155 / ui 170，數字含字幕 WYSIWYG 階段 1 新增測試；若 `npm test` 整批平行跑，`server/test/cardSync.test.ts` 的 debounce 測試偶爾會因即時渲染子行程與其他重測試（render/demo）搶 CPU 而假性失敗——單獨跑該檔或 `server` workspace 是穩定綠的，屬既有計時假設脆弱，非本次文檔改動引入）、typecheck 三 workspace 乾淨、ESLint 0 問題（`.claude/worktrees/` 下其他 session 的 34 個既有錯誤不算）、UI 可 build。全部走真 ffmpeg、真 whisper、真 Pillow 與真 MCP/WS transport 驗證過。

## 字幕 WYSIWYG 階段 1：光柵器地基（分支 `caption-wysiwyg`）

設計：[`docs/superpowers/specs/2026-08-03-caption-wysiwyg-design.md`](docs/superpowers/specs/2026-08-03-caption-wysiwyg-design.md)。目標是讓預覽字幕與匯出成品最終共用同一張 PNG；階段 1 只把「光柵器」這塊地基蓋好，**還沒有任何使用者看得到的行為變化**。

- **`text_card.py` 常駐 worker 模式**：`--worker` 讀 stdin/stdout 一行一 JSON，import PIL 與字型只付一次，之後每張卡約 7ms（相較逐次 spawn 的 50–70ms）。一次請求可同時產出「base 卡」與「全高亮卡」（karaoke 兩張圖疊 clip-path 的作法），並回傳逐詞 bounding box。**既有單卡 CLI 模式沒有變動**——`render.ts` 的匯出路徑目前仍走舊的逐次 spawn CLI，還沒接上 worker。
- **`server/src/rasterizer.ts`（新）**：`PillowRasterizer`（`id='pillow-1'`）把 worker 包成 TS 介面：`resolveFontPath`（public 可變，因為字型表要靠它自己 probe 後再回填）、`probeFont`、`rasterize`、`dispose`。
- **`server/src/fonts.ts`（新）**：`loadFontTable(rasterizer)` 啟動時用真 Pillow 逐一實測候選字型檔，**開不了的直接剔除**（本機 `/System/Library/Fonts/PingFang.ttc` 開不了，已剔除，落到 Heiti TC）；`fontResolver(table)` 給 family→路徑（完全比對，否則落到表首位，否則 undefined）。新端點 `GET /api/fonts`（回 `{id, family}[]`）與 `GET /fonts/:id`（真的把字型檔案送出，供之後 UI `@font-face` 用）。
- **`server/src/textCards.ts`（新）**：`cardKey()` 內容雜湊（含 rasterizer id，換引擎全快取自動失效）；`TextCardService.ensure()` 查快取未命中才產卡，寫 `derived/text/<hash>.{base,hl}.json/.png`。HTTP：靜態 `/text-card/*`（`immutable` 強快取）+ `POST /text-card/preview`（只產卡，不碰 doc/history/廣播，供之後打字即時預覽用）。輸入驗證完整（壞掉的 style 回 400，之前會靜默產出預設樣式的卡）。
- **`server/src/cardSync.ts`（新）**：`CaptionCardSync` 在字幕軌變更後 debounce 300ms 重產全部字幕卡，透過新的 WS 訊息 `{type:'textCards', entries:[{id, hash}]}` 廣播 capId→hash 對照；啟動時預熱、新連線送目前的完整對照表。**單句產卡失敗會被隔離**——失敗的那句直接從 entries 缺席（其餘句照常產出），不會讓整批 latest 被舊資料污染。`ui/src/stores/project.ts` 對 `textCards` 訊息目前是 no-op 早退——**這是必要的**，否則會落進 patch 分支當成版本不符觸發無限 resync。
- **匯出路徑接上同一張字型表**：`render.ts` 的 `renderCaptionCard`（匯出用）現在會傳 `fontPath`，用 `setCaptionFontResolver` 在啟動時注入、與預覽路徑**同一個** resolver。在此之前匯出用的是另一條寫死的候選字型鏈，`fontFamily` 對成品完全無效；現在 `fontFamily` 真的同時影響預覽與匯出（過去兩邊都不影響）。有測試比對匯出卡與預覽卡的 PNG sha256 相同，並反向驗證「不注入 resolver 時輸出必須不同」（判別性防護，避免測試假陽性）。

**目前仍然成立、還沒變的事**：匯出成品的字幕仍然只有 PNG 字卡一條路（這台機器 ffmpeg 沒 drawtext，見下方「環境限制與字幕」節）；逐詞高亮在匯出端仍是「一個詞一張卡」。上面新增的是**預覽端的字卡產生通道**（`/text-card/preview` 與字幕軌 debounce 同步），但 UI 還沒有任何程式碼去顯示這些卡——那是階段 3 的工作。

## T1（參考 CapCut 的快贏功能，tag `t1-done`）

依 [`docs/research/2026-07-29-capcut-gap-analysis.md`](docs/research/2026-07-29-capcut-gap-analysis.md) 的 Tier 1 全數實作：

- **粗剪主力**：S/Ctrl+B 播放頭分割、Q/W 刪除播放頭左/右（磁性軌自動閉合）、F 定格幀。
- **時間軸手感**：Ctrl+滾輪以游標為錨縮放、吸附（片段邊界/playhead/整秒，黃線指示，N 開關）、Shift+Z 全覽、工具列 ±/Fit/吸附鈕、刻度密度隨縮放調整。
- **快捷鍵**：空白播放暫停、←/→ 逐幀（Shift 加速 10 幀）、Cmd+Z 復原。**在輸入框內打字時全部停用**。
- **音訊軌完成**：片段右鍵抽出聲音（片段轉靜音）、音量/淡入淡出/ducking（播放時自動壓低影片原聲到 0.25）、渲染走 amix 並截到成片長度。
- **Canvas blur 填充**：橫素材放進 9:16 時用模糊放大填滿代替黑邊（渲染 boxblur + 預覽端獨立背景層）。
- **匯出選項**：1080/720/4K 檔位、畫質（crf 18/20/24）、fps（24/30/60）、hevc；合成一律在畫布尺寸做完才縮放，overlay/字卡不會錯位。
- **封面**：任意時間點設封面；已有成品時從成片抽（所見即所得）。
- **新 MCP 工具**：`timeline_op`（split/deleteBefore/deleteAfter/freeze 四合一）、`extract_audio`、`set_audio`、`update_audio`、`set_canvas_fit`、`set_cover`，`render` 新增匯出參數。

## T2 #8：自動字幕與逐詞高亮

計畫見 [`docs/superpowers/plans/2026-07-30-vidcut-t2-captions.md`](docs/superpowers/plans/2026-07-30-vidcut-t2-captions.md)。

- **新 MCP 工具**：`transcribe`（只讀，回逐詞時間戳）、`auto_caption`（辨識→斷句→寫入字幕軌，一步到位）。
- **時間座標是時間軸絕對秒數**：ASR 吃的是「時間軸混音」，所以詞時間可直接當字幕時間，不必做來源↔時間軸換算。
- **逐詞高亮（karaoke）**：`CaptionItem.tokens` 存逐詞時間戳。渲染時**一個詞一張 PNG 字卡**（排版確定性，所以 N 張卡幾何完全對齊，看起來就是同一行字在變色）；預覽端只是 DOM span 換顏色，幾乎免費。
- **字幕列表面板**（右上）：點時間跳播、雙擊改字、刪除、樣式套全部。改字會自動清掉該句的 tokens——舊詞邊界對新文字沒有意義。
- **依賴**：`brew install whisper-cpp` + 模型放 `~/.cache/whisper.cpp/`（現用 `ggml-large-v3-turbo-q5_0.bin`，547MB）。或用 `VIDCUT_WHISPER_MODEL` 指定路徑。沒裝時錯誤訊息會直接給安裝指令。

**踩過的坑（whisper.cpp 1.9.1 實測，別重犯）**

1. **不要用 `-ml 1 -sow`（一段一詞）取逐詞時間**。看起來最直覺，但 segment offsets 在長句尾段會**整批退化**成「全部等於音訊結尾」，最後一個詞還會拿到 **30 秒**（內部補齊的區塊邊界）。
2. **正確來源是 `-ojf` 的 token 層 `t_dtw`**。同一次辨識裡它是正確且單調的（實測尾段 8.84→9.04→…→12.36，而 offsets 全是 12.39）。
3. **DTW 要搭 `-nfa`**：whisper.cpp 的 flash attention 與 DTW 互斥，開著會**靜默停用** DTW（log 只有一行 `dtw_token_timestamps is not supported with flash_attn - disabling`）。
4. **短音訊（約 4 秒以下）時間戳本來就會爛**，這不是我們的音訊管線問題（純 ffmpeg 轉的 wav 一樣）。`normalizeWords()` 會把擠在一點的詞攤開、把超出片長的夾回來。

**下一步（Tier 2 其餘）**：偵測工具組（`detect_silence`/`detect_scenes`/`detect_beats` → 回傳時間戳給 AI 決策）、**模板化＋批次渲染**、transcript 式長轉短。優先建議：beat 偵測 + 模板化（對 ranking 片管線立刻有感）。

## UI 重設計（2026-07-30 夜間）

spec：[`docs/superpowers/specs/2026-07-30-vidcut-ui-redesign-design.md`](docs/superpowers/specs/2026-07-30-vidcut-ui-redesign-design.md)（brainstorm 含瀏覽器 mockup 比選，使用者逐步定案：C 現代 web 視覺 × 保守版面 × 峰值+RMS 波形）。

- **設計系統 `ui/src/theme.css`**：CSS 變數 token（紫 #8b5cf6 強調、青 #0ea5e9 音訊、深藍紫玻璃層級）；**原生 button/select/input 直接被 theme 接管**，元件端大量刪 inline style；lucide-react 取代 emoji 圖示。
- **版面**：RenderBar 刪除 → 頂欄 ExportMenu（匯出鈕+下拉+3px 進度條）；右欄改「字幕⇄活動」分頁；播放控制+時間碼移進時間軸工具列；審核條改事件式 overlay 卡（GSAP 彈性滑入）；左右面板可收合（grid-template-columns 動畫）。
- **時間軸**：片段卡片化（上 60% filmstrip、下 40% 波形帶）；**峰值+RMS 雙層鏡像波形**（`ui/src/timeline/waveform.ts`，DPR 級解析度）；ingest 升級 **100 桶/秒＋rms 陣列**（`PeaksFile` 共用型別；舊檔無 rms 自動退單層）；音訊軌青色全高波形；playhead 紫漸層光暈圓頭。
- **動效**：`ui/src/motion.ts`（gsap + useGSAP + motionOK）；審核條/分頁/toast/渲染完成 pulse/字幕自動捲動；微互動走 CSS transition；`prefers-reduced-motion` 全域尊重。
- **行為零改動**：命令層/MCP/播放引擎/拖曳數學全部沒碰；demo 專案已重建（新 peaks）。

**headless 截圖打通後（chromium --headless=new）親眼驗過**：版面/波形/字幕分頁/匯出鈕都正確渲染。過程中抓到並修掉一個真 bug：

- **zustand v5 selector 禁止回傳新 reference**。`useProject((s) => s.doc?.tracks.captions ?? [])` 的 `?? []` 在 doc=null（每次冷載入）觸發同步無限重渲染 → React #185 → 整個 app 白屏。dev 分頁靠 HMR 熱更新遮住了它（更新時 doc 已非 null）。修法：fallback 用模組級常數（`NO_CAPTIONS`）。**以後寫 selector 一律不得在裡面創建新陣列/物件。**
- 波形顯示用 sqrt 感知縮放（實測素材正規化振幅常 <0.3，線性會退化成細線）；trim handle 改 hover 才浮現。

**仍待使用者驗收（體感類）**：動效手感（審核條/分頁/收合）、hover 細節、真素材上的波形觀感。舊專案想要 RMS 波形需重 ingest，不重跑也能用（單層）。

## 明天第一件事：親眼驗收（我驗不了「體感」與 Claude Code 實連）

我驗證了「邏輯正確、程式能跑、端到端 transport 通」，但**播放流暢度、成品觀感、Claude Code 真實連線**要你的眼睛與環境。

### A. 開起來看

```bash
cd ai-video-cut
npm run demo        # 終端機 A：建 demo + 起 server（127.0.0.1:3845，MCP 在 /mcp）
npm run dev:ui      # 終端機 B：http://localhost:5173
```

驗收（重點在體感）：

1. 時間軸 5 clip（縮圖 + 波形；No.3 無音軌 → 平線），按 ▶ **切換有無黑幀/停頓**（M1 最關鍵）。
2. 拖 clip 左右邊緣 trim、拖 clip 本體換順序、點 clip 在左欄改屬性、Cmd+Z 復原、右欄活動記錄。
3. 底部「🎬 渲染成品」→ 進度條 → 完成後「開啟成品」連結播放，確認畫面/音訊/overlay/字幕。
4. **自動字幕**：素材要有人聲才有意義。請 AI 跑 `auto_caption`，右上字幕列表會出現句子，
   播放時預覽的字會逐詞亮起；渲染後成品也應該逐詞亮（我用像素數驗過，但觀感要你看）。

### B. 接 Claude Code（M3 的重點價值）

```bash
# server 要開著（npm run demo 或 npm run dev:server -- projects/demo）
claude mcp add --transport http vidcut http://127.0.0.1:3845/mcp
```

然後在 Claude Code 裡對它說「用 vidcut 讀專案、把第 3 段縮短一秒、然後 request_review」。
你會在瀏覽器 UI 看到變更即時發生、頂部跳出審核條，按核准後 AI 那邊的 `request_review` 就回傳。
（我用 in-process client 與真 HTTP client 都驗過這條迴路，但沒有你的 Claude Code 環境，這步請親測。）

## 環境限制與字幕（已解決）

**本機 Homebrew ffmpeg 8.1.2 是精簡 bottle，沒有 `drawtext`／`libfreetype`／`libass`**（formula 本身不宣告 freetype 依賴，`brew reinstall` 也救不了；只有 drawbox/overlay/colorize）。

**字幕已用 PNG 字卡路徑解決**（2026-07-29）：render 時 runtime 偵測 drawtext——

- 有 drawtext → 原生 `drawtext` 燒字。
- 無 drawtext（本機）→ 用 **Pillow 把每條 caption 畫成透明 PNG 字卡**（`server/scripts/text_card.py`，CJK 字型 fallback），再用既有 `overlay` 濾鏡按時間合成。已端到端驗證：純黑底上字幕開啟時有字、關閉時無字、時間正確。`render` 回 `captionsBurned:true`。

需要 `pip3 install pillow`（已裝，12.3.0）。哪天換成含 freetype 的 ffmpeg，會自動改走原生 drawtext，不用改碼。重度文字（排名標題、迷因標籤）仍走 overlay PNG（與 `make_overlays.py` 一致），這條本來就正常。

**本機 ffmpeg 濾鏡清單（2026-07-30 實測，避免重複調查）**

| 有                                                                                                     | 沒有                                                                               |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `xfade`（轉場）、`zoompan`／`crop`（punch-in）、`geq`（逐像素表達式）、`sendcmd`、`overlay`、`boxblur` | `drawtext`／`libfreetype`、`ass`／`subtitles`（無 libass）、`frei0r`、`libplacebo` |

意義：**Tier 3 的 punch-in/zoom 與轉場不需要新依賴**，本機 ffmpeg 就做得到。反之 ASS 字幕（`\k` 逐詞卡拉 OK、`\t()` 屬性插值）在這台機器上完全走不通，PNG 字卡不是次佳解而是唯一解；逐詞亮起要靠「一句話出 N 張字卡」實作，不是 ASS。

## 已知取捨（非 bug）

- `undo` 為逐步 undo，「撤 undo = redo」是簡化；要正式 redo stack 之後再擴。
- request_review 用「阻塞 + UI 核准 + 保活 + 逾時」；**elicitation URL mode**（Claude Code 直接彈瀏覽器審核頁）列為後續增強——因無法自動驗證故未做，可用 v2 SDK `@modelcontextprotocol/server` + codemod 遷移時一起上。
- 退回（reject）目前回滾「review 開啟後的全部變更」到 sinceVersion；若人在審核期間也改了東西會一起被回滾（reject = 丟掉這一輪）。
- 播放/渲染字級換算：預覽用 `fontSize/3` 粗估，未與渲染逐像素對齊。
- Safari 未測（開發用 Chrome）。
- MCP 用 v1 SDK 1.30.0（穩定）；v2（2.0.0）功能更多但兩天前才發，之後可用官方 codemod 升級。

## 架構與程式碼地圖

單一 Node 程序（`server/`）綁 `127.0.0.1:3845`，一 port 服務：靜態 UI、`/media/*`（Range）、`/mcp`（MCP Streamable HTTP）、`/ws`（狀態同步）。專案狀態 = `project.json`，**所有變更走 `ProjectStore.mutate()` 單一路徑**。

```
shared/src/types.ts       全部型別（spec §3）+ Command/WS 協議
shared/src/timeline.ts    純時間軸計算（locate/overlayWindow…）
shared/src/captions.ts    逐字稿→字幕分頁、逐詞高亮索引、ASR 時間戳修正（純函數）★
server/src/store.ts       ProjectStore：唯一真相來源、immer patch、history、undo、原子存檔
server/src/commands.ts    applyCommand：人機共用的驗證過的編輯命令層 ★
server/src/aiWrite.ts     AI 寫入守衛（審核中擋 + ifVersion 過期偵測）→ commands
server/src/reviews.ts     ReviewManager：request_review 的核心（阻塞/核准/退回回滾/逾時）
server/src/editorContext.ts 人的選取/playhead（給 get_editor_context）
server/src/mcp.ts         23 個 MCP 工具 + /mcp 掛載 ★
server/src/ingest.ts      proxy/filmstrip/peaks 產生（spec §8.1）
server/src/render.ts      project.json → ffmpeg filter_complex 成品 + blur/定格/音訊混音/匯出選項/封面 ★
server/src/asr.ts         whisper.cpp 介接：時間軸混音→wav→逐詞時間戳（含 DTW 取用）★
server/scripts/text_card.py  文字 → 透明 PNG 字卡（Pillow，含逐詞著色與貪婪換行；`--worker` 常駐模式一次回 base+全高亮兩張卡＋逐詞 bbox，7ms/張）
server/src/rasterizer.ts  PillowRasterizer：包 text_card.py worker 的 TS 介面（rasterize/probeFont/dispose）
server/src/fonts.ts       啟動時實測字型檔可否用 Pillow 開啟，剔除開不了的（本機 PingFang.ttc）；family→路徑 resolver
server/src/textCards.ts   TextCardService：內容雜湊快取字卡到 derived/text/；/text-card 靜態端點 + /text-card/preview 只讀產卡通道
server/src/cardSync.ts    CaptionCardSync：字幕軌變更 debounce 300ms 重產字卡，WS 廣播 capId→hash；單句失敗隔離不拖累整批
server/src/ffmpeg.ts      runFfmpeg/probe
server/src/frame.ts       抽幀給 AI「看」
server/src/wsHub.ts       WS：full/patch/command/context/reviewResolve/render
server/src/index.ts       startServer + CLI
ui/src/theme.css          設計系統：token + 原生控件樣式 + 佈局 class ★
ui/src/motion.ts          GSAP 進入點（useGSAP + reduced-motion 判斷）
ui/src/stores/            project（patch 套用）/ playback / selection / view（縮放吸附＋面板收合）/ activity / toast
ui/src/ws.ts              WS client：命令/脈絡/審核/渲染 送出 + 重連
ui/src/player/            planAt（純函數大腦）+ Player（A/B 引擎）
ui/src/timeline/          scale + dragMath + waveform（純函數）+ Timeline（trim/排序/選取/縮放/吸附/transport）
ui/src/panels/            Inspector / Activity / ReviewBar / ExportMenu / CaptionList（字幕列表）
```

★ = 改動時最常碰、最核心的檔案。

**改動鐵則**：任何專案狀態變更都走 `applyCommand`（人）或 `aiWrite`→`applyCommand`（AI）；不要旁路直改 doc。要加新編輯操作 = 在 `shared` 的 `Command` 加一個 variant + `commands.ts` 加驗證 + case，UI 與 MCP 自動都能用（DRY 的關鍵）。

## 開發指令

```bash
npm test          # 全部（含真 ffmpeg 與真 whisper，約 25 秒）
npm run typecheck # 三 workspace tsc
npm run lint      # ESLint（目前 0 問題）
npm run format    # Prettier 寫入
npm run demo      # 建 demo + 起 server
npm run dev:ui    # Vite dev（proxy 到 :3845）
```

## 下一步建議（依價值排序）

1. **親驗播放體感 + Claude Code 實連**（上面 A、B）。有問題記錄現象給我。
2. **Tier 2 其餘**（見 gap analysis；#8 自動字幕已完成）：優先 **beat 偵測**（切點對拍，質感立刻上檔次）與 **模板化 + 批次渲染**（ranking 片變成換素材就好）。
3. **skill 整合**：把 `ranking-video-generator` 步驟 3–5 尾段改走 vidcut（import_media → set_timeline → set_overlays → request_review → render）；掃描/峰值/選段不動。詳見 `docs/superpowers/plans/2026-07-29-vidcut-m4.md` 末節。
4. 其他增強：whisper 逐字稿＋自動字幕、**elicitation URL mode**、多分頁綁定（Vyra 式 Connect MCP）。

設計與計畫全文：`docs/superpowers/specs/` 與 `docs/superpowers/plans/`。
