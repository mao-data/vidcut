# HANDOFF — vidcut 開發交接

> 目前做到哪、怎麼驗、已知限制、下一步。
> 最後更新：M1–M4 + T1 + T2#8（自動字幕）+ UI 重設計 + 字幕 WYSIWYG 階段 1（光柵器地基）+ 階段 2（可編輯文字 overlay）+ 階段 3（預覽字卡直出）+ 階段 4（畫布拖曳+吸附導線）**四階段全部完成**，含真瀏覽器回歸（`npm run verify:canvas`）。
> ⚠️ 這份「最後更新」是**站在 `caption-wysiwyg` 分支**寫的，所以漏掉了同期一直在 `main` 上
> 推進、與四階段平行（多數甚至更早）的功能：面板寬度拖曳（2026-07-30，比階段 1 早 4 天）、
> 預覽音訊同步與 AI 編輯動畫（08-02）、素材匯入零複製與真 undo/redo（08-03，與階段 1 同日）、
> 字幕匯出四模式（08-05）。**只有 MCP 面補完（`73904bc`）真的在 `caption-wysiwyg` 併回
> `main`（`3b4d456`，08-05）之後。** 完整清單見下面現況總覽的表。
>
> ⚠️ **「預覽=成品」對「沒有逐詞高亮的字幕」與 overlay 成立**（字幕已驗到 PNG sha256 逐位元組
> 相同；overlay 的兩個幾何落差 2026-08-04 修好，`npm run verify:wysiwyg` 現在**六個 case 全綠**
> ——第六個 case（`overlay-offcentre`，水平軸的唯一覆蓋）是 2026-08-05 才補的，
> 見 `ui/e2e/preview-vs-export.mjs` 的 `CASES`；「最大差 1.1px」是某次實測、未重驗，
> 常駐容差是腳本裡的 `TOL_PX` = 4）。
> **karaoke 字幕仍有已知、可重現的落差**——但**落差在預覽端，匯出成品是正確的**
> （一詞一卡＝單層直畫；預覽的兩層疊合讓描邊看起來略厚，2 詞時差 1101 個像素／1.1%，
> 最大單通道差 165，肉眼看不出來——這組數字出自 `.claude/rules/wysiwyg.md` 記的一次性
> 卡片層級量測，**沒有常駐測試守著、未重驗**）。範圍、成因與完整實測表見
> `.claude/rules/wysiwyg.md`（`CLAUDE.md`「『預覽即成品』的實際範圍」只留摘要，
> 實測表已搬到規則檔）與下面的階段 3 節。寫文件或對外描述這個功能時請一律帶上限定詞。

## 現況總覽

| 里程碑                | 狀態                                           | 內容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 看得到             | ✅ `m1-done`                                   | ProjectStore + WS 同步 + ffmpeg ingest + 唯讀時間軸 + A/B 無縫預覽                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| M2 改得動             | ✅ `m2-done`                                   | 命令層 + trim 拖拉 + 排序 + Inspector 編輯 + undo + 活動面板                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| M3 AI 接上            | ✅ `m3-done`                                   | MCP server（工具清單見 mcp.ts）+ request_review 審核閉環 + 編輯脈絡回報                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| M4 渲染               | ✅ `m4-done`                                   | ffmpeg 從 project.json 輸出 1080×1920 成品 + 進度 + UI 渲染鈕                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| T1 CapCut 快贏        | ✅ `t1-done`                                   | 見下節                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| T2 #8 自動字幕        | ✅                                             | whisper 逐字稿 + 自動斷句 + 逐詞高亮 + 字幕列表 UI，見下節                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| UI 重設計             | ✅                                             | 深藍紫玻璃視覺系統 + 峰值/RMS 波形 + GSAP 動效，見下節                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 字幕 WYSIWYG 階段 1–4 | ✅（分支 `caption-wysiwyg`，**四階段全完成**） | 階段 1：Pillow 常駐光柵器 + 字型表 + 字卡快取服務 + 字幕卡 debounce 同步。階段 2：**可編輯文字 overlay**——UI 時間軸「Text」鈕新增文字 overlay、Inspector 可改文字/字級/顏色，MCP `add_overlay`/`update_overlay`/`set_overlays` 皆支援 `text`。階段 3：**字幕預覽改走與成品同一張字卡**（**限非 karaoke**）——`fontSize/3` 估算已廢除，1080×1920 座標空間 + `transform: scale(stage寬/1080)`；karaoke 用 base+全高亮兩張幾何相同的卡疊 `clip-path` 逐詞揭色（**但匯出端是一詞一卡，兩者不是同一張圖**，見下節）；打字三段式即時預覽；真瀏覽器實測驗證縮放公式（見下節，注意那份量測不等於「預覽與成品對齊」）。階段 4：**畫布直接拖曳 overlay/字幕 + 吸附導線**——`shared/src/snap.ts` 的 `snapBBox` 純函數（水平置中/垂直置中/上下 5% 安全邊距，16px 吸附半徑）+ `ui/src/player/dragLayer.ts` 的錨點↔bbox 換算 + `Player.tsx` 的 pointer 拖曳與「放手後 echo 未到前」的本地覆蓋橋接；真瀏覽器 e2e 回歸（`npm run verify:canvas`，見下節）過程中抓到並修掉一個真 bug（`<img>` 原生瀏覽器拖曳手勢劫持 pointer 事件序列，見下節與 `.claude/rules/ui-verification.md`）。 |
| 字幕匯出四模式        | ✅                                             | `burn`／`off`／`sidecar`／`embed`，見下面專節。測試 `server/test/render-subtitles.test.ts` + `shared/src/subtitles.test.ts`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 素材匯入：零複製引用  | ✅                                             | `server/src/paths.ts` 的 `resolveMediaPath`（相對＝專案內／絕對＝零複製外部引用）、`server/src/sourceFolder.ts` 的素材夾掃描、`GET /api/source`／`POST /api/import`，MCP 端是 `list_source`／`import_media`。測試 `server/test/paths.test.ts`、`sourceFolder.test.ts`、`source-api.test.ts`、`import-api.test.ts`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| MCP 面補完            | ✅                                             | **每個工具都宣告 `outputSchema`**，由 `server/test/mcp-tools.test.ts` 的「批 G」守著（工具**數量**以 `server/src/mcp.ts` 為準——那條測試是 `toBeGreaterThanOrEqual`，下限不是釘死值，所以這裡不寫死）。`m3-done` 15 個 → 現在 31 個（用跨行安全的正則對兩個版本的 `mcp.ts` 各數一次 `registerTool` 得出，見 README 的九組工具表），新增的 16 個是 `list_source`／`add_clip`／`update_overlay`／`add_overlay`／`remove_overlay`／`remove_audio`／`update_caption`／`redo`／`transcribe`／`auto_caption`／`timeline_op`／`extract_audio`／`set_audio`／`update_audio`／`set_canvas_fit`／`set_cover`（`import_media` **M3 就有**，之後改的是語意——擴充成絕對路徑零複製引用）。「工具有沒有漏註冊、instructions 有沒有跟上」由 `server/test/mcp-docs-sync.test.ts` 守著（鐵則第三步的執行面）。                                                                                                                                                                                                                                                                         |
| 真 undo/redo          | ✅                                             | `server/src/store.ts` 有 `#redoStack` 與 `redo(source, steps)`、有新編輯就清空 redo（分叉）；`Command` 有 `redo` variant、MCP 有 `redo` 工具。測試 `server/test/store-undo.test.ts`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 預覽音訊同步          | ✅                                             | `ui/src/player/sync.ts`：小漂移調 `playbackRate` 追趕（不中斷、無雜音）、大漂移才硬 seek。測試 `ui/src/player/sync.test.ts`、`ui/src/player/Player.sync.test.tsx`；spec `docs/superpowers/specs/2026-08-02-preview-audio-sync.md`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| AI 編輯動畫           | ✅                                             | `ui/src/fx/aiPatches.ts`（一輪 AI 編輯的 JSON patch → 哪些光暈、哪些進場、捲到哪）+ `ui/src/fx/scroll.ts` + `ui/src/stores/editFx.ts`（最後一次變更後 1.6s 收窗）。測試 `ui/src/fx/aiPatches.test.ts`、`ui/src/stores/editFx.test.ts`；spec `docs/superpowers/specs/2026-08-02-ai-edit-fx.md`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 面板寬度拖曳          | ✅                                             | `ui/src/PanelResizer.tsx` + `ui/src/panelResize.ts`（純函數）。測試 `ui/src/panelResize.test.ts`；spec `docs/superpowers/specs/2026-07-30-panel-resize-design.md`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**自動化狀態全綠**：typecheck 三 workspace 乾淨、ESLint 0 問題、prettier 乾淨、全測試套件通過、突變測試全滅、UI 可 build。全部走真 ffmpeg、真 whisper、真 Pillow 與真 MCP/WS transport 驗證過。**當下數字跑 `bash scripts/gauntlet.sh` 看**——這份文件不寫會過期的數字（快照數字看 `EVIDENCE.md`，它帶 commit SHA）。

真瀏覽器（非 jsdom）回歸有三支，都綠，但**各自有不能忽略的前提**：

- `npm run verify:panels`（面板控制項）、`npm run verify:canvas`（縮放/拖曳/導線/不盲拖）
  ——兩者都需要 server 在跑 + `ui/dist` 是最新的。
- `npm run verify:wysiwyg`（真 render vs 預覽截圖的墨跡外框）自己起臨時 server 與臨時專案，
  不碰 `projects/demo`。它會**自己擋下過期的 `ui/dist`**（忘記 build 的話它量的是上一版的 UI，
  全綠但毫無意義）與**過小的視窗**（量測本底雜訊會超過容差）。
- ⚠️ `verify:canvas` 依賴 `projects/demo` 的內容，而那是共用的可變狀態；它也會把拖曳結果
  寫回 demo 的 `project.json`。2026-08-05 就因為 demo 被別的工作改到「t=0 沒有 overlay」
  而每次都在載入逾時——已改成往前掃找第一個有 overlay 的時刻，但這類耦合還在。
- ⚠️ `verify:canvas` 檢查 1 印的「誤差 0.000%」只驗了 transform 矩陣的 `a`（scaleX），
  **不足以推論「預覽跟成品對齊」**——理由見 `.claude/rules/ui-verification.md`
  （那一節以前在 `CLAUDE.md`，2026-08-07 拆分規則檔時搬走了，commit `6d82874`）。

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
- **逐詞高亮（karaoke）**：`CaptionItem.tokens` 存逐詞時間戳。渲染時**一個詞一張 PNG 字卡**（排版確定性，所以 N 張卡幾何完全對齊，看起來就是同一行字在變色）。預覽端當初是 DOM span 換顏色（幾乎免費）；**階段 3 之後改成 base 卡 + 全高亮卡疊 `clip-path`**——所以預覽與成品的高亮邊緣不完全一樣，見階段 3 節。
- **字幕列表面板**（右上）：點時間跳播、雙擊改字、刪除、樣式套全部。改字會自動清掉該句的 tokens——舊詞邊界對新文字沒有意義。
- **依賴**：`brew install whisper-cpp`（執行檔認 `whisper-cli` 或 `whisper-cpp`）+ 模型放
  `~/.cache/whisper.cpp/`、`/opt/homebrew/share/whisper.cpp/models` 或
  `/usr/local/share/whisper.cpp/models`（`server/src/asr.ts` 的 `MODEL_DIRS`）。
  **不是寫死某一個模型**——`MODEL_RANK` 會從找得到的裡面挑最好的
  （`large-v3-turbo` → … → `tiny`）；本機用的是 `ggml-large-v3-turbo-q5_0.bin`（547MB）。
  或用 `VIDCUT_WHISPER_MODEL` 指定路徑。沒裝時錯誤訊息（`INSTALL_HINT`）會直接給安裝與下載指令。

**踩過的坑（whisper.cpp 1.9.1 實測，別重犯）**

1. **不要用 `-ml 1 -sow`（一段一詞）取逐詞時間**。看起來最直覺，但 segment offsets 在長句尾段會**整批退化**成「全部等於音訊結尾」，最後一個詞還會拿到 **30 秒**（內部補齊的區塊邊界）。
2. **正確來源是 `-ojf` 的 token 層 `t_dtw`**。同一次辨識裡它是正確且單調的（實測尾段 8.84→9.04→…→12.36，而 offsets 全是 12.39）。
3. **DTW 要搭 `-nfa`**：whisper.cpp 的 flash attention 與 DTW 互斥，開著會**靜默停用** DTW（log 只有一行 `dtw_token_timestamps is not supported with flash_attn - disabling`）。
4. **短音訊（約 4 秒以下）時間戳本來就會爛**，這不是我們的音訊管線問題（純 ffmpeg 轉的 wav 一樣）。`normalizeWords()` 會把擠在一點的詞攤開、把超出片長的夾回來。

**下一步（Tier 2 其餘）**：偵測工具組（`detect_silence`/`detect_scenes`/`detect_beats` → 回傳時間戳給 AI 決策）、**模板化＋批次渲染**、transcript 式長轉短。優先建議：beat 偵測 + 模板化（對 ranking 片管線立刻有感）。

## 字幕匯出四模式（2026-08-04）

背景與後續排期見 `docs/ROADMAP.md`「字幕能力補完」。**在此之前字幕只能燒進畫面、關不掉。**

- **`RenderOptions.subtitles`（`shared/src/types.ts`）**：`'burn' | 'off' | 'sidecar' | 'embed'`，
  **預設 `burn`**——不帶這個參數時行為與本功能存在前完全相同（有回歸測試釘住）。
- **`shared/src/subtitles.ts`（新）**：`serializeSrt` / `serializeVtt` 純函數。
  時間基準是**成品時間軸**（`CaptionItem.start` 本來就是時間軸絕對秒，零換算）。
  會濾掉空字與零長度、依開始時間排序後重新編號。
- **`buildRenderArgs`**：`burn` 以外的模式令 `useCards = false` 並跳過 drawtext 分支。
  ⚠️ 這**不只是不畫**——`useCards` 同時決定字卡的 `-i` input 要不要加，而
  `audioInputBase` 是從它算出來的。只擋濾鏡不擋 input 會讓音訊 input 索引整批位移，
  成品會靜默錯軌。回歸測試 `drops the caption card inputs ... so later input indices
stay correct` 就是釘這件事。
- **`render()`**：非 `burn` 模式**連字卡都不產**（長片省下數百次 Pillow 呼叫）。
  ffmpeg 跑完後、標記 `done` 之前處理字幕檔：
  - `sidecar` → 寫 `output/<stamp>.srt`，回傳 `subtitlePath`。
  - `embed` → `.srt` 寫進 `derived/subtitles/`（只是餵 ffmpeg 的中間物），
    再 `-c copy -c:s mov_text` 混到 `output/<stamp>.subbed.mp4` 後 rename 蓋回去
    （ffmpeg 不能就地改寫自己的輸入）。回傳 `subtitlesEmbedded`。
  - 字幕軌是空的時候兩者都不產生任何檔案或字幕軌（有測試釘住，因為 MCP 描述寫了這句）。
- **MCP `render`**：新增 `subtitles` enum 參數，`structuredContent` 多回
  `subtitles` / `subtitlePath` / `subtitlesEmbedded`。工具描述與 server `instructions` 已同步。
  回覆文字的 `(captions not burned: no drawtext)` 警告**只在 `burn` 模式下**出現——
  其他模式的「沒燒」是使用者要的，報成問題會誤導 AI。

**為什麼 `embed` 一定要能關掉燒錄**：soft track 疊上燒錄，觀眾開字幕就看到兩排字。
所以 `off`/`sidecar`/`embed` 三者畫面都是乾淨的，這不是可選的設計偏好。

**vidcut 在這裡比 FreeCut 有優勢**：FreeCut 因為 mediabunny 不啟動 ISOBMFF 的 subtitle
`auxWriter`，WebVTT 進 MP4 會拋出無法攔截的 floating rejection，只能在 MP4 上退回燒錄；
我們走 ffmpeg，MP4 用 `mov_text`、MKV 用 `srt`，沒有這個限制。

**驗證**：`server/test/render-subtitles.test.ts`（15 個測試：6 條獨立 + 3 條 ×`off`/`sidecar`/`embed` 三模式；
「約 8 秒」是某次實測、未重驗）。
整合測試是真 ffmpeg——`sidecar` 比對 `.srt` 全文、`embed` 用
`ffmpeg -map 0:s:0 -f srt -` **把字幕解回來**比對中文（只驗 ffprobe 看得到軌，
證不了 UTF-8 有活著）。另有 `shared/src/subtitles.test.ts` 6 個純函數測試。

**尚未做的**：VTT 只有序列化函數，`render` 的 sidecar 固定輸出 `.srt`（沒有格式參數）；
UI 的 ExportMenu 沒有這個選項，目前只有 MCP 走得到。

## UI 重設計（2026-07-30 夜間）

spec：[`docs/superpowers/specs/2026-07-30-vidcut-ui-redesign-design.md`](docs/superpowers/specs/2026-07-30-vidcut-ui-redesign-design.md)（brainstorm 含瀏覽器 mockup 比選，使用者逐步定案：C 現代 web 視覺 × 保守版面 × 峰值+RMS 波形）。

- **設計系統 `ui/src/theme.css`**：CSS 變數 token（紫 #8b5cf6 強調、青 #0ea5e9 音訊、深藍紫玻璃層級）；**原生 button/select/input 直接被 theme 接管**，元件端大量刪 inline style；lucide-react 取代 emoji 圖示。
- **版面**：RenderBar 刪除 → 頂欄 ExportMenu（匯出鈕+下拉+3px 進度條）；右欄改「字幕⇄活動」分頁；播放控制+時間碼移進時間軸工具列；審核條改事件式 overlay 卡（GSAP 彈性滑入）；左右面板可收合（grid-template-columns 動畫），之後又補上**可拖曳調寬**（`ui/src/PanelResizer.tsx`）。
- **時間軸**：片段卡片化（上 60% filmstrip、下 40% 波形帶）；**峰值+RMS 雙層鏡像波形**（`ui/src/timeline/waveform.ts`，DPR 級解析度）；ingest 升級 **100 桶/秒＋rms 陣列**（`PeaksFile` 共用型別；舊檔無 rms 自動退單層）；音訊軌青色全高波形；playhead 紫漸層光暈圓頭。
- **動效**：`ui/src/motion.ts`（gsap + useGSAP + motionOK）；審核條/分頁/toast/渲染完成 pulse/字幕自動捲動；微互動走 CSS transition；`prefers-reduced-motion` 全域尊重。
- **行為零改動**：命令層/MCP/播放引擎/拖曳數學全部沒碰；demo 專案已重建（新 peaks）。

**headless 截圖打通後（chromium --headless=new）親眼驗過**：版面/波形/字幕分頁/匯出鈕都正確渲染。過程中抓到並修掉一個真 bug：

- **zustand v5 selector 禁止回傳新 reference**。`useProject((s) => s.doc?.tracks.captions ?? [])` 的 `?? []` 在 doc=null（每次冷載入）觸發同步無限重渲染 → React #185 → 整個 app 白屏。dev 分頁靠 HMR 熱更新遮住了它（更新時 doc 已非 null）。修法：fallback 用模組級常數（`NO_CAPTIONS`）。**以後寫 selector 一律不得在裡面創建新陣列/物件。**
- 波形顯示用 sqrt 感知縮放（實測素材正規化振幅常 <0.3，線性會退化成細線）；trim handle 改 hover 才浮現。

**仍待使用者驗收（體感類）**：動效手感（審核條/分頁/收合）、hover 細節、真素材上的波形觀感。舊專案想要 RMS 波形需重 ingest，不重跑也能用（單層）。
⬆️ 其中**收合/展開控制項的「可用性」已經不是未驗證項目了**：`npm run verify:panels`
（`ui/e2e/panel-affordance.mjs`）在真瀏覽器裡驗左右展開鈕可點、與收合鈕同高、
不被 ExportMenu 下拉蓋住、捲動後仍可點。**它驗的是「按得到」，不是「好不好按」**——
手感那半仍然只能靠人。

## 明天第一件事：親眼驗收（我驗不了「體感」與 Claude Code 實連）

字幕 WYSIWYG 四階段（含畫布拖曳）都做完、自動化測試與真瀏覽器 e2e（`verify:panels` + `verify:canvas`）都綠了，但**手感類的東西自動化測不出來**，需要你的眼睛與手：

### A. 開起來看

```bash
cd ai-video-cut

# 終端機 A：起 server（127.0.0.1:3845，MCP 在 /mcp）。二選一：
npx tsx server/src/index.ts projects/demo   # 保留 projects/demo 目前的內容
npm run demo                                # ⚠️ 重建 demo：會覆蓋掉現有的 overlay/字幕

# 終端機 B（可選，只有要熱重載改 UI 才需要）
npm run dev:ui
```

**先看清楚這三件事，否則會卡在錯的地方：**

- **步驟 4 與 6 需要專案裡真的有字幕。** ⚠️ `projects/demo` 是**共用的可變狀態、而且不進 git**
  （`verify:canvas` 會寫回去、手動測試也會改），所以「它現在有什麼」這份文件寫不準——
  下面兩句是寫下來當時的觀察（**字幕軌是空的、7 個 overlay**），**請自己開起來看實際狀況**。
  可以確定的是 `npm run demo` 重建後的內容：`server/src/demo.ts` 產 5 支 lavfi 直式影片
  （第 3 支無音軌）+ 1 個標題 overlay + 2 句種子字幕（無 tokens ＝ 無逐詞高亮），
  並**清掉**原本 `projects/demo` 裡的一切。
  想保留現況又要驗字幕，就先跑步驟 7 的 `auto_caption`（或自己用 Text/字幕面板加一句）。
- **`npm run dev:ui` 的 port 不一定是 5173**：被占用時 vite 會自動往上找（實測選過 :5175），
  以它啟動時印的那行為準；而且**只能用 `http://localhost:<port>`，`127.0.0.1` 連不上**
  （vite dev server 只綁 IPv6）。
- **不想被 port/proxy 干擾就直接用 `http://127.0.0.1:3845/`**（server 服務的 `ui/dist`）。
  這條路不需要 dev server，但**改了 UI 原始碼要先 `npm run build -w @vidcut/ui`**。
  dev 模式的字卡/字型通道曾經是死的（`ui/vite.config.ts` 少了 `/text-card` 與 `/fonts`
  兩條 proxy），現在已補上並在 dev port 的真頁面裡驗過：幾何 JSON、`POST /text-card/preview`、
  `/fonts/:id`、字卡 `<img>`、`@font-face` 全部正常。

驗收（重點在體感，e2e 只驗了「機制有沒有跑」，沒驗「順不順手」）：

1. 時間軸 5 clip（縮圖 + 波形；No.3 無音軌 → 平線），按 ▶ **切換有無黑幀/停頓**（M1 最關鍵，這條仍然是回歸底線）。
2. 拖 clip 左右邊緣 trim、拖 clip 本體換順序、點 clip 在左欄改屬性、Cmd+Z 復原、右欄活動記錄。
3. **拖曳手感（階段 4，新）**：在預覽畫布上直接拖動一個 overlay（排名徽章）或一句字幕——吸附到中心線/安全邊距時的靈敏度是否符合直覺？導線出現/消失的時機會不會太早/太晚、會不會抖動？拖到畫布邊緣時元素會不會整個消失不見（設計上應該最多露出一半，見 `dragLayer.ts` 的 clamp 說明）？
4. **打字體感（階段 3）**：在**右上字幕列表雙擊**一句字幕改字（三段式只接在 `CaptionList.tsx`，
   **畫布上不能直接改字**；左欄 Inspector 的字幕 Text 欄仍然不走三段式，但**已經不再每一鍵
   送一筆命令**——2026-08-04 改成與同面板的文字 overlay Text 欄一致的**失焦才送**
   ［在此之前是 `onChange` 每鍵一筆 `updateCaption`：每鍵一筆 history + 一次字卡重產。
   「33 個字 → `derived/text/` 多 99 個檔」是當時的一次性實測、未重驗（現行程式碼是
   `ui/src/panels/Inspector.tsx` 的 `onBlur`，那條 `onChange` 路徑已不存在）；
   「那個目錄只增不減」則仍然成立］。
   換句話說「打字時畫布即時跟著變」只有右上字幕列表那條路，Inspector 是「改完離開欄位才生效」），
   感受「近似文字先出、~80ms 後換真卡」這個切換是否明顯/突兀。
   ✅ **「加長文字讓它自動換行」現在可以拿來驗了**（2026-08-04 起，見 `.claude/rules/wysiwyg.md`「自動換行」節）：
   字幕與文字 overlay 都會折在畫布寬的 90%（文字 overlay 可用 `maxWidth` 調），中文逐字折、
   英數在空白處折。**請順便看這件事**：既有專案裡以前被裁掉的長字現在會折行、卡片變高，
   那是修好了不是回歸。要驗顯式換行仍可在左欄 Inspector 的 Text 欄（那是 `<textarea>`，
   按 Enter 就會換行；右上字幕列表是單行 `<input>`，Enter 是送出）裡打真的換行。
   ⚠️ 文字太長時寫入可能被「字卡超過像素預算」拒絕——那是**最壞情況上界**在保守拒絕
   （1080 寬、fontSize 64 是 369 字，`server/test/textCards.test.ts` 有測試釘住這個數字），
   不是 bug，見 `.claude/rules/wysiwyg.md`「自動換行」節。
5. 底部「🎬 渲染成品」→ 進度條 → 完成後「開啟成品」連結播放，確認畫面/音訊/overlay/字幕。
6. **預覽=成品的最終檢驗（階段 4 收尾）**：把上面拖過的 overlay/字幕、改過的文字，用同一次渲染比對。
   **請帶著下面這份「已知會不一致」的清單去看**，否則你會把已知落差當成新 bug（或反過來，
   把落差看成「大致上一樣」而放過）：
   - ✅ **非 karaoke 字幕應該一模一樣**（同一張 PNG，已驗到 sha256 相同）——位置、字級、描邊、字型有任何差異都是新 bug，請記下來。
   - ✅ **overlay 的大小/位置現在也應該一樣**（2026-08-04 修好兩個幾何落差；`verify:wysiwyg`
     現在**六個 case 全綠**，其中水平軸那個 case 是 2026-08-05 才補的。容差是腳本裡的
     `TOL_PX` = 4；「最大差 1.1px」是某次實測、未重驗）：
     以前「成品比預覽大約 11%」與「Inspector 的 scale 欄位對成品完全沒效果」兩條**都已消除**——
     現在改 scale 預覽與成品會一起變。若還看得到差異，那是新 bug，請記下來。
     注意既有專案的 overlay **預覽會比你印象中大 11%**：那是它在成品裡一直以來的尺寸，不是變大了。
   - ❌ **karaoke 字幕的高亮邊緣一定不一樣**：預覽是兩卡疊 `clip-path`，成品是一詞一卡；
     下一個還沒唸到的詞左緣會被預覽多染約 4px 高亮色，描邊也比較厚。同樣是已知缺陷。
   - ⬆️ 位置（x/y）**已經有自動化守著了**（原文寫「沒有人驗過、從來沒有跑一次真的 render
     去比對成品像素」，那是 2026-08-05 之前的狀況）：`npm run verify:wysiwyg`
     （`ui/e2e/preview-vs-export.mjs`）會真的 render 一支影片、抽幀量墨跡外框，再與
     headless Chromium 截的同一時刻預覽比對，x0/y0 一起比。垂直軸由 `overlay-offtop`
     這個 case 守著（`position.y` 為負、被上緣裁掉），水平軸由 `overlay-offcentre`
     守著（`position.x = 0.25`，2026-08-05 補的唯一 x≠0.5 case——在它之前每個 case 的 x
     都是 0.5，實測把渲染端的 x 映射整個鏡射之後五項照樣全綠）。
     **仍然沒被自動化涵蓋的是「拖曳」這條路徑本身**：`verify:canvas` 只驗到「伺服器存了
     新座標」，沒有接著 render；`verify:wysiwyg` 用的是固定 fixture、不經過拖曳。
     所以請你特別看的是「拖完之後渲染出來對不對」，而不是幾何映射本身。
7. **自動字幕**：素材要有人聲才有意義。請 AI 跑 `auto_caption`，右上字幕列表會出現句子，
   播放時預覽的字會逐詞亮起；渲染後成品也應該逐詞亮（我用像素數驗過，但觀感要你看，
   而且逐詞高亮的預覽/成品本來就有上面說的邊緣差異）。

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

**字幕已用 PNG 字卡路徑解決**（2026-07-29）：用 **Pillow 把每條 caption 畫成透明 PNG 字卡**
（`server/scripts/text_card.py`，CJK 字型 fallback），再用既有 `overlay` 濾鏡按時間合成。
已端到端驗證：純黑底上字幕開啟時有字、關閉時無字、時間正確。`render` 回 `captionsBurned:true`。

需要 `pip3 install pillow`（`server/src/rasterizer.ts:168` spawn 的是 PATH 上的 `python3`，
所以要裝在那一個 python 裡；**版本號不寫死**——這台機器 2026-08-07 實測是 11.0.0，
會隨環境變）。重度文字（排名標題、迷因標籤）仍走 overlay PNG（與 `make_overlays.py` 一致），
這條本來就正常。

✅ **「哪天換成含 freetype 的 ffmpeg 會自動改走原生 drawtext」這顆未爆彈已經拆掉了。**
原本 render 會 runtime 偵測 drawtext，有 drawtext 且沒有 karaoke 時走原生 `drawtext` 濾鏡——
那條路沒有 `fontfile=`（字型完全交給 ffmpeg 自己找，`style.fontFamily` 無效）、不換行
（連 `\n` 都不處理）、描邊寬度寫死 3px，是跟字卡完全不同的光柵器。**2026-08-05 整條刪掉**：
現在字幕**一律**走 Pillow 字卡（`server/src/render.ts` 的 `buildRenderArgs`，該分支的墓誌銘
註解在 `server/src/render.ts:271-278`），`server/test/render.test.ts:122` 那條測試
（「沒有字卡就不燒字——不得退回原生 drawtext（那是另一個光柵器）」）**釘死它不准回來**。
換一台有 freetype 的機器不再會讓「預覽=成品」靜默失效。

**本機 ffmpeg 濾鏡清單（2026-07-30 實測，避免重複調查）**

| 有                                                                                                     | 沒有                                                                               |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `xfade`（轉場）、`zoompan`／`crop`（punch-in）、`geq`（逐像素表達式）、`sendcmd`、`overlay`、`boxblur` | `drawtext`／`libfreetype`、`ass`／`subtitles`（無 libass）、`frei0r`、`libplacebo` |

意義：**Tier 3 的 punch-in/zoom 與轉場不需要新依賴**，本機 ffmpeg 就做得到。反之 ASS 字幕（`\k` 逐詞卡拉 OK、`\t()` 屬性插值）在這台機器上完全走不通，PNG 字卡不是次佳解而是唯一解；逐詞亮起要靠「一句話出 N 張字卡」實作，不是 ASS。

## 已知取捨（非 bug）

- ~~`undo` 為逐步 undo，「撤 undo = redo」是簡化；要正式 redo stack 之後再擴。~~
  **已不成立**：`server/src/store.ts` 有真的 `#redoStack`、`redo(source, steps)` 方法、
  「有新編輯就清空 redo（分叉）」的處理，`Command` 有 `redo` variant，MCP 也有 `redo` 工具。
- request_review 用「阻塞 + UI 核准 + 保活 + 逾時」；**elicitation URL mode**（Claude Code 直接彈瀏覽器審核頁）列為後續增強——因無法自動驗證故未做，可用 v2 SDK `@modelcontextprotocol/server` + codemod 遷移時一起上。
- 退回（reject）目前回滾「review 開啟後的全部變更」到 sinceVersion；若人在審核期間也改了東西會一起被回滾（reject = 丟掉這一輪）。
- Safari 未測（開發用 Chrome）。
- MCP 用 v1 SDK（`server/package.json` 宣告 `^1.30.0`，本 worktree 實裝 1.30.0）；v2（2.0.0）
  功能更多但在本專案起步時（2026-07 底）才剛發布，之後可用官方 codemod 升級。**尚未升級。**

## 架構與程式碼地圖

單一 Node 程序（`server/`）綁 `127.0.0.1:3845`，一 port 服務：靜態 UI、`/media/*`（Range）、`/mcp`（MCP Streamable HTTP）、`/ws`（狀態同步）。專案狀態 = `project.json`，**所有變更走 `ProjectStore.mutate()` 單一路徑**。

```
shared/src/types.ts       全部型別（spec §3）+ Command/WS 協議
shared/src/timeline.ts    純時間軸計算（locate/overlayWindow…）
shared/src/captions.ts    逐字稿→字幕分頁、逐詞高亮索引、ASR 時間戳修正、karaokeClip（兩卡 clip-path）、tokenSeparator（斷詞規則）（純函數）★
shared/src/snap.ts        snapBBox：畫布拖曳吸附純函數（水平置中/垂直置中/上下 5% 安全邊距，16px 半徑，只認 bbox 不認錨點）
shared/src/subtitles.ts   serializeSrt / serializeVtt：字幕檔序列化純函數（時間基準＝成品時間軸，零換算）
shared/src/index.ts       shared 的對外出口（server/ui 都從 @vidcut/shared 匯入）
server/src/store.ts       ProjectStore：唯一真相來源、immer patch、history、undo/redo（真的有 #redoStack）、原子存檔
server/src/commands.ts    applyCommand：人機共用的驗證過的編輯命令層 ★
server/src/aiWrite.ts     AI 寫入守衛（審核中擋 + ifVersion 過期偵測）→ commands
server/src/reviews.ts     ReviewManager：request_review 的核心（阻塞/核准/退回回滾/逾時）
server/src/editorContext.ts 人的選取/playhead（給 get_editor_context）
server/src/mcp.ts         MCP 工具註冊 + /mcp 掛載（工具清單以本檔為準）★
server/src/paths.ts       resolveMediaPath：素材路徑語意（相對＝專案內／絕對＝零複製外部引用）★
server/src/sourceFolder.ts scanSourceFolder：素材夾掃描（白名單副檔名、排除隱藏檔、不遞迴）
server/src/ingest.ts      proxy/filmstrip/peaks 產生（spec §8.1）；ingestMedia 接受絕對路徑；
                          純音訊素材跳過 proxy/filmstrip 只產 peaks（無 proxyPath/filmstripPath）
server/src/render.ts      project.json → ffmpeg filter_complex 成品 + blur/定格/音訊混音/匯出選項/封面 ★
server/src/asr.ts         whisper.cpp 介接：時間軸混音→wav→逐詞時間戳（含 DTW 取用）★
server/scripts/text_card.py  文字 → 透明 PNG 字卡（Pillow，含逐詞著色與貪婪換行；`--worker` 常駐模式一次回 base+全高亮兩張卡＋逐詞 bbox；「7ms/張 vs 逐次 spawn 50–70ms」是 text_card.py:26 記的實測、未重驗）
server/src/rasterizer.ts  PillowRasterizer：包 text_card.py worker 的 TS 介面（rasterize/probeFont/dispose）
server/src/fonts.ts       啟動時實測字型檔可否用 Pillow 開啟，剔除開不了的（本機 PingFang.ttc）；family→路徑 resolver
server/src/textCards.ts   TextCardService：內容雜湊快取字卡到 derived/text/；/text-card 靜態端點 + /text-card/preview 只讀產卡通道
server/src/cardSync.ts    CaptionCardSync：字幕軌變更 debounce 300ms 重產字卡，WS 廣播 capId→hash；單句失敗隔離不拖累整批
server/src/textOverlays.ts 文字 overlay 命令前置：resolveTextCommand() 產卡後把 imagePath 併入新命令，text 與 imagePath 在同一次 mutate 原子生效
server/src/cardBudget.ts  字卡像素預算：估算「這段文字最壞情況會排成幾行 / 多大張」，超過就在命令層保守拒絕（取字元數上界與前進寬上界的較小值）
server/src/ffmpeg.ts      runFfmpeg/probe
server/src/frame.ts       抽幀給 AI「看」
server/src/demo.ts        `npm run demo` 的 demo 專案產生器（5 支 lavfi 直式影片、其一無音軌 + 標題 overlay + 2 條種子字幕）——⚠️ 會覆寫既有 projects/demo
server/src/app.ts         Express app：`/api/project`（debug）、`GET /api/source?dir=`（素材夾掃描）、
                          `POST /api/import`（零複製匯入，逐支序列處理）、`POST /assets`（UI 上傳）、`/media/*`
server/src/wsHub.ts       WS：full/patch/command/context/reviewResolve/render
server/src/index.ts       startServer + CLI
ui/src/theme.css          設計系統：token + 原生控件樣式 + 佈局 class ★
ui/src/main.tsx           React 入口（createRoot）
ui/src/App.tsx            版面外殼：三欄 grid＋header、全域鍵盤快捷鍵 handler、伺服器字型
                          @font-face 注入（id 防 StrictMode 雙掛載）、錯誤 Toast、面板收合鈕
ui/src/shortcuts.ts       快捷鍵單一來源表（描述 App.tsx onKey 的實況＋Timeline 的 Ctrl+wheel；
                          Inspector 的 ShortcutHelp 彈出層由它生成——改 handler 必須同步此表）
ui/src/motion.ts          GSAP 進入點（useGSAP + reduced-motion 判斷）
ui/src/stores/            project（patch 套用，含 captionCards）/ playback / selection / view（縮放吸附＋面板收合）/ activity / toast / editDraft（打字三段式草稿，見下）/ editFx（AI 編輯動畫窗，最後一次變更後 1.6s 收窗）
ui/src/stores/editDraft.ts 打字中的本地字幕草稿（text + previewHash）：不進 history、不碰 doc、不經 sendCommand
ui/src/fx/                aiPatches（一輪 AI 編輯的 JSON patch → 哪些光暈/哪些進場/捲到哪，純函數）+ scroll（捲動目標計算）
ui/src/PanelResizer.tsx   左右面板寬度拖曳把手；數學在 ui/src/panelResize.ts（純函數）
ui/src/ws.ts              WS client：命令/脈絡/審核/渲染 送出 + 重連
ui/src/player/            planAt（純函數大腦）+ Player（A/B 引擎，量 stage 寬算 1080 座標空間縮放係數 + 畫布拖曳事件處理）+ CaptionLayer（見下）+ dragLayer（見下）+ sync（見下）
ui/src/player/sync.ts     播放中媒體元素的時鐘同步策略：小漂移調 playbackRate 追趕（不中斷、無雜音），大漂移（≥0.25s）才硬 seek
ui/src/player/CaptionLayer.tsx 字幕預覽：有字卡 hash 就 <img> 直出（無 karaoke 時與匯出同一張圖），karaoke 疊 hl 卡 + clip-path（與匯出的一詞一卡**不**同源）；沒有 hash／幾何 fetch 失敗／圖檔 onError 才退回 DOM 近似 fallback，幾何 fetch 進行中是 return null（空白一幀，不是近似文字）
ui/src/player/dragLayer.ts dragOverlay/dragCaption：畫布拖曳數學（純函數）——overlay 的 position 錨點不對稱（x=中心、y=上緣），這裡負責錨點↔bbox 左上角的雙向換算，呼叫 shared 的 snapBBox 做實際吸附 ★
ui/src/timeline/          scale + dragMath + waveform（純函數）+ Timeline（trim/排序/選取/縮放/吸附/transport）+ Toolbar / ClipBlock / AudioChip / usePeaks
ui/src/panels/            Inspector / Activity / ReviewBar / ExportMenu / CaptionList（字幕列表）
```

測試與稽核的基礎設施（不是產品程式碼，但改測試時一定會碰到）：

```
server/test/global-setup.ts  vitest globalSetup：建「這一輪測試的暫存根目錄」，teardown 一次刪光；
                             有測試失敗就整輪保留（出事現場），VIDCUT_KEEP_TMP=1 可無條件保留。
                             清理必須放這裡而不是各檔 afterAll——ProjectStore 落盤是 debounce 500ms
                             的射後不理，afterAll 立刻刪會撞 ENOENT: rename '.project.json.tmp'
server/test/tmp.ts           tmpDir(prefix)：取代裸 mkdtemp(join(tmpdir(),…))，建在上面那個根目錄底下
server/test/setup.ts         每個測試檔的 afterAll：只做「這檔有失敗就寫標記，teardown 別清」
server/test/fixtures.ts      makeVideo 等真素材產生器（測試走真 ffmpeg）
server/test/mcp-docs-sync.test.ts  鐵則第三步的執行面守衛：工具面完整性 + Command variant 觸達性
                             （型別強制的 COMMAND_VARIANT_MAP，variant 增刪改名 tsc 會先失敗）
server/test/mcp-surface-snapshot.test.ts  MCP 工具面 snapshot 閘門：31 個工具的 name／description／
                             inputSchema／outputSchema／annotations＋server instructions 經真 MCP 協定
                             （InMemoryTransport + listTools）鎖進 `server/test/__snapshots__/mcp-surface.snap.json`；
                             改 mcp.ts 必紅，**先讀 diff 確認描述屬實**再 `-u` 更新
                             （擋「忘了看」，擋不住「看了亂改」——語意仍靠人）
scripts/docs-check.mjs       斷言型文件檢查，四項：反引號路徑存在、文件提到的 npm script 真的
                             存在、不引用被 .gitignore 的路徑、以及反向完整性——ui/server/shared
                             的每個原始檔都要被 HANDOFF 檔案職責敘述覆蓋（檔名或所屬目錄被提及；
                             新增檔案沒補文件會紅）；秒級、零依賴，gauntlet.sh 的一關
scripts/docs-hook.mjs        PostToolUse 提醒器：編輯 mcp.ts／新增未追蹤原始檔／動 README 時
                             注入文件同步提醒。佈線在專案 `.claude/settings.json`（進 git）與
                             工作區根 .claude/settings.json（machine-local，換機要重佈）
.claude/skills/docs-sync-review/  commit 前的文件同步審查 skill：變更分類 → 文件矩陣逐份過目 →
                             逐文件「已更新／查過無需改」帶證據結論 → 機械收尾
scripts/mutate.mjs / mutants.json  突變測試與其錨點檢查（--check）
```

★ = 改動時最常碰、最核心的檔案。

**改動鐵則**：任何專案狀態變更都走 `applyCommand`（人）或 `aiWrite`→`applyCommand`（AI）；不要旁路直改 doc。
要加新編輯操作是**三步**：`shared/src/types.ts` 的 `Command` 加 variant → `server/src/commands.ts`
加驗證與 case → **`server/src/mcp.ts` 手動 `registerTool` 並同步 `instructions`**。
⚠️ **第三步不會自動發生**（本節原文寫「UI 與 MCP 自動都能用（DRY 的關鍵）」，那是錯的——
前例：`addClip` 做完八輪 TDD 卻沒人能用，因為只做了 1、2 步；這正是 `CLAUDE.md`
「鐵則」那一節在講的事）。UI 端只有**協議面**是自動的（`wsHub` 收到就丟給 `applyCommand`），
要有人按得到還是得加控制項；MCP 端連協議面都不自動。
現在有 `server/test/mcp-docs-sync.test.ts` 守著漏掉第三步的情況。

## 開發指令

```bash
npm test          # 全部（含真 ffmpeg 與真 whisper）；「機器空閒時約 70 秒」是某次實測、未重驗，
                  # 而且 EVIDENCE.md 收尾那張 gauntlet 表記的最近一次全套是 740 條，這個秒數幾乎確定偏低
npm run typecheck # 三 workspace tsc（乾淨）
npm run lint      # ESLint —— 目前 exit 0（.claude/** 已排除，見下）
npm run format:check  # 目前 exit 0；它報的都是真的沒格式化的原始碼，不是雜訊
npm run format    # Prettier 寫入
npm run demo      # ⚠️ 重建 demo（覆蓋既有內容）+ 起 server
npm run dev:ui    # Vite dev（proxy 到 :3845；port 未必是 5173，且只綁 IPv6 → 用 localhost）
npm run verify:panels  # 面板控制項真瀏覽器回歸（前置：server 在跑 + ui/dist 最新）
npm run verify:canvas  # 畫布縮放/拖曳/吸附/不盲拖真瀏覽器回歸（前置同上；陷阱見 .claude/rules/ui-verification.md）
npm run verify:wysiwyg # 真 render vs 預覽截圖的墨跡外框（自己起 :3999 + 臨時專案；六個 case 全綠）
node scripts/docs-check.mjs   # 斷言型文件的引用完整性（秒級）
bash scripts/gauntlet.sh      # 全層驗證一條龍；當下數字以它為準
```

> `npm run lint` 曾經 exit 1（34 個錯誤全在 `.claude/worktrees/**`，別的 session 開的
> worktree ＝整個 repo 的另一份拷貝），而且會隨著「此刻有沒有人開著 worktree」自己來去。
> `.claude/**` 已加進 `eslint.config.js` 的 ignores，`typecheck && lint && format:check`
> 這種 `&&` 串現在跑得完。
> `verify:wysiwyg` 會**自己擋下過期的 `ui/dist`**（`stalestSource()` 比 `ui/src`、`shared/src`
> 以及 `ui/index.html`、`ui/vite.config.ts`、`ui/package.json` 的 mtime，排除 `.test.ts(x)`）——
> 忘記 build 的話它量的是上一版的 UI，六個 case 會全綠但那個綠什麼都不代表（實測把預覽端的
> 字幕 y 打歪 690px 之後不 build 再跑就是全綠）。stage 寬 < 400px 也會擋（量測本底雜訊
> 會超過容差）。

## 下一步建議（依價值排序）

1. **親驗播放體感 + Claude Code 實連**（上面 A、B）。有問題記錄現象給我。
2. **Tier 2 其餘**（見 gap analysis；#8 自動字幕已完成）：優先 **beat 偵測**（切點對拍，質感立刻上檔次）與 **模板化 + 批次渲染**（ranking 片變成換素材就好）。
3. **skill 整合**：把 `ranking-video-generator` 步驟 3–5 尾段改走 vidcut（import_media → set_timeline → set_overlays → request_review → render）；掃描/峰值/選段不動。詳見 `docs/superpowers/plans/2026-07-29-vidcut-m4.md` 末節。
4. 其他增強：**elicitation URL mode**（`server/src` 目前零個 `elicit`，確實還沒做）、
   多分頁綁定（Vyra 式 Connect MCP）、MCP SDK v1→v2 升級。
   （原文這裡還列著「whisper 逐字稿＋自動字幕」——那在 T2 #8 就完成了，已移除。）

設計與計畫全文：`docs/superpowers/specs/` 與 `docs/superpowers/plans/`。
