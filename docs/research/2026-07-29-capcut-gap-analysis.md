# vidcut 功能差距分析與路線圖（參考 CapCut）

日期：2026-07-29
依據：兩份深度調研（CapCut 核心時間軸編輯功能、CapCut AI 與自動化功能），對照 vidcut M1–M4 現況。

## 核心洞見（先讀這段）

1. **短影音創作者 80% 時間在做的事**（多篇 workflow 文章一致）：粗剪切廢話 → 自動字幕＋樣式化（被稱為「ROI 之王」）→ 配樂對拍 → punch-in/zoom → B-roll 疊放 → 濾鏡收尾。**不是**華麗轉場、手動 keyframe、進階調色。
2. **vidcut 的差異化不是追 CapCut 的功能清單**，而是「AI 可解釋決策」：CapCut AutoCut 的已知失敗是黑箱 highlight 抽取「常在句子中間切斷」。我們的架構應把偵測（靜音/場景/節拍/逐字稿）做成**回傳時間戳的 MCP 工具**，讓 AI 讀懂內容再決策，人審結果——這是 CapCut 做不到的。
3. **CapCut 模板生態的本質**＝「風格結構鎖定＋素材槽位可換」的參數化時間軸。vidcut 的 project.json 本來就是宣告式 JSON，做模板抽象成本極低、複利極高（直接解鎖批次生成——Pippit 的核心賣點）。
4. CapCut **web 版的弱點**（上傳等待、雲端儲存收費、斷線即廢、功能閹割）正是 vidcut 本機方案的天然賣點，不必自卑。

## vidcut 現況（M1–M4 已有）

磁性單主軌資料模型、trim 拖拉、排序、Inspector 屬性編輯、undo、活動面板、filmstrip＋波形、A/B 無縫預覽、overlay/caption 疊層、PNG 字卡燒錄、15 個 MCP 工具、request_review 審核閉環、ffmpeg 渲染（1080×1920）。

**明顯缺口**：播放頭分割、快捷鍵、時間軸縮放/吸附、自動字幕（無 ASR）、音訊混音（旁白/BGM/淡入淡出）、beat 偵測、blur 背景填充、轉場/動畫、變速、匯出選項、模板/批次。

---

## Tier 1 — 快贏（每項數小時，體感立刻升級）

| # | 功能 | 做法 | 成本 |
|---|---|---|---|
| 1 | **Canvas blur 背景填充** | 橫素材放進 9:16 的標配（官方都說比黑邊好看）。ffmpeg `split→scale放大→boxblur→overlay`；預覽端 CSS filter。9:16 產品剛需 | 低 |
| 2 | **時間軸手感三件套** | Ctrl+滾輪縮放（`pxPerSecond` 變 state）、snap 吸附（playhead/片段邊緣/整秒/beat 點，8px 閾值＋垂直指示線）、Shift+Z zoom-to-fit | 低 |
| 3 | **播放頭分割＋刪左刪右** | S/Ctrl+B 在 playhead 切開選中片段（資料層＝複製 clip 改兩者 in/duration）；Q/W 刪播放頭左/右段（磁性自動閉合）。粗剪最短路徑 | 低 |
| 4 | **音訊完成度** | AudioItem 型別已預留：接 amix（旁白/BGM 進渲染）、fade in/out 滑桿、片段右鍵 Extract audio（ffmpeg 一行）、BGM 對白時段壓低（固定比例 ducking） | 低–中 |
| 5 | **匯出選項＋封面** | 解析度/fps/位元率下拉（ffmpeg 參數映射）；封面＝從影片選一幀存獨立圖（我們已有抽幀能力） | 低 |
| 6 | **Freeze frame** | 右鍵定格：抽單幀成 image clip 插入主軌 | 低–中 |

## Tier 2 — AI-native 殺手鐧（vidcut 的差異化本體，MCP 工具為主）

| # | 功能 | 做法 | 成本 |
|---|---|---|---|
| 7 | **偵測工具組（MCP）** | `detect_silence`（ffmpeg silencedetect）、`detect_scenes`（scdet/PySceneDetect）、`detect_beats`（librosa/aubio → beat 時間戳＋BPM）。全部回傳時間戳給 AI 決策，不黑箱自動剪。UI 把 beat/scene 畫成時間軸標記點，snap 可吸附 | 中 |
| 8 | **逐字稿＋自動字幕（ROI 之王）** | whisper.cpp 本機跑 → `transcribe` MCP 工具回 word-level 時間戳 JSON → AI 排字幕/選段；UI 加「字幕 list view」（逐句改字比時間軸快得多，CapCut 的關鍵 UX）；樣式 preset 與文字分離、一鍵套全。進階：逐字 karaoke 高亮（PNG 字卡逐 word 渲染） | 中–高 |
| 9 | **模板化＋批次** | `create_template`（時間軸→帶時長約束的素材槽位 JSON）＋`apply_template`（綁新素材）＋`batch_render`（模板×素材矩陣）。ranking 片天然是模板場景：同一套 overlay/節奏，每週換素材 | 中 |
| 10 | **Transcript-based 長轉短** | 組合 #7＋#8＋LLM 判斷：AI 讀逐字稿選 highlight、每段給可解釋理由，request_review 給人核可。勝過 CapCut 場景式抽取的內容理解 | 中（無新模型） |

## Tier 3 — 表現力（中型，體感差異大但非地基）

| # | 功能 | 做法 | 成本 |
|---|---|---|---|
| 11 | **In/Out 動畫 preset** | 「給不懂 keyframe 的人用的 keyframe」——fade/slide/zoom 進出場，點選即套＋時長滑桿。底層建極簡插值，UI 不出 keyframe 編輯器 | 中 |
| 12 | **Punch-in/zoom** | 現代短影音用 zoom 硬切取代轉場（workflow 文章共識）。片段級靜態 crop/scale＋「zoom-in 動畫」preset；渲染端 zoompan/crop | 中 |
| 13 | **轉場（只做 5–8 種）** | cross-dissolve/黑場/滑動/zoom，「拖到接縫」的互動；渲染端 xfade。注意：A/B 預覽器要同時顯示兩段（opacity 疊化近似） | 中–高 |
| 14 | **常速變速＋倒放** | setpts/atempo（0.5x–2x 先做）；曲線變速不做（高成本低頻） | 中 |
| 15 | **片段級簡易調色** | 一個濾鏡＋亮度/對比/飽和三滑桿＋apply to all（ffmpeg eq；預覽 CSS filter 近似）。HSL/curves 不做 | 中 |

## 明確不做（YAGNI，調研佐證）

曲線變速編輯器、完整 keyframe UI、HSL/curves 調色、複合片段/群組、封面編輯器（選幀即可）、華麗轉場大庫、AI 特效、雲端儲存。

## 建議實作順序

1. **Tier 1 全包**（合計 1–2 天）：#1–#6，時間軸手感＋音訊＋匯出一次到位——這是「像不像正經編輯器」的門面。
2. **Tier 2 依用途挑**：你的 ranking 片管線最先受益的是 **#7 偵測工具組**（beat 對拍＋場景偵測直接提升成片質感）與 **#9 模板化**（每週產片變成換素材）；#8 逐字稿對「講話類影片」才是剛需，等你開始剪 podcast/教學類再上。
3. **Tier 3 按需**：#12 punch-in 優先於 #13 轉場（現代短影音的實際主流）。
