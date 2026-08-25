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

| 里程碑                        | 狀態                                           | 內容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 看得到                     | ✅ `m1-done`                                   | ProjectStore + WS 同步 + ffmpeg ingest + 唯讀時間軸 + A/B 無縫預覽                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| M2 改得動                     | ✅ `m2-done`                                   | 命令層 + trim 拖拉 + 排序 + Inspector 編輯 + undo + 活動面板                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| M3 AI 接上                    | ✅ `m3-done`                                   | MCP server（工具清單見 mcp.ts）+ request_review 審核閉環 + 編輯脈絡回報                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| M4 渲染                       | ✅ `m4-done`                                   | ffmpeg 從 project.json 輸出 1080×1920 成品 + 進度 + UI 渲染鈕                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| T1 CapCut 快贏                | ✅ `t1-done`                                   | 見下節                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| T2 #8 自動字幕                | ✅                                             | whisper 逐字稿 + 自動斷句 + 逐詞高亮 + 字幕列表 UI，見下節                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| UI 重設計                     | ✅                                             | 雙主題視覺系統（**2026-08-16 起暗版=剪接室暗房（炭黑+白蠟筆+紅蠟筆標記），亮版=分鏡紙桌面；紫世界已整體退役**）+ 峰值/RMS 波形 + GSAP 動效，見下節                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 字幕 WYSIWYG 階段 1–4         | ✅（分支 `caption-wysiwyg`，**四階段全完成**） | 階段 1：Pillow 常駐光柵器 + 字型表 + 字卡快取服務 + 字幕卡 debounce 同步。階段 2：**可編輯文字 overlay**——UI 時間軸「Text」鈕新增文字 overlay、Inspector 可改文字/字級/顏色，MCP `add_overlay`/`update_overlay`/`set_overlays` 皆支援 `text`。階段 3：**字幕預覽改走與成品同一張字卡**（**限非 karaoke**）——`fontSize/3` 估算已廢除，1080×1920 座標空間 + `transform: scale(stage寬/1080)`；karaoke 用 base+全高亮兩張幾何相同的卡疊 `clip-path` 逐詞揭色（**但匯出端是一詞一卡，兩者不是同一張圖**，見下節）；打字三段式即時預覽；真瀏覽器實測驗證縮放公式（見下節，注意那份量測不等於「預覽與成品對齊」）。階段 4：**畫布直接拖曳 overlay/字幕 + 吸附導線**——`shared/src/snap.ts` 的 `snapBBox` 純函數（水平置中/垂直置中/上下 5% 安全邊距，16px 吸附半徑）+ `ui/src/player/dragLayer.ts` 的錨點↔bbox 換算 + `Player.tsx` 的 pointer 拖曳與「放手後 echo 未到前」的本地覆蓋橋接；真瀏覽器 e2e 回歸（`npm run verify:canvas`，見下節）過程中抓到並修掉一個真 bug（`<img>` 原生瀏覽器拖曳手勢劫持 pointer 事件序列，見下節與 `.claude/rules/ui-verification.md`）。 |
| 字幕匯出四模式                | ✅                                             | `burn`／`off`／`sidecar`／`embed`，見下面專節。測試 `server/test/render-subtitles.test.ts` + `shared/src/subtitles.test.ts`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 素材匯入：零複製引用          | ✅                                             | `server/src/paths.ts` 的 `resolveMediaPath`（相對＝專案內／絕對＝零複製外部引用）、`server/src/sourceFolder.ts` 的素材夾掃描、`GET /api/source`／`POST /api/import`，MCP 端是 `list_source`／`import_media`。測試 `server/test/paths.test.ts`、`sourceFolder.test.ts`、`source-api.test.ts`、`import-api.test.ts`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 跨專案素材庫（後端，phase 1） | ✅（**只做了後端＋MCP，UI 是第二期**）         | spec `docs/superpowers/specs/2026-08-21-asset-library-design.md`。內容定址存放於 `~/.vidcut/library/`（`VIDCUT_LIBRARY_DIR` 可覆寫），`server/src/libraryStore.ts`／`libraryIngest.ts` 見上方檔案職責。五條 `/api/library*` HTTP 路由（上傳走串流、庫未載入時 503）＋四支 MCP 工具 `list_library`／`add_to_library`／`import_from_library`／`update_library_asset`（`remove_from_library` 刻意只給 HTTP DELETE，MCP 不開放，spec 決策）；工具數 34→38，instructions 已同步。測試：`libraryStore.test.ts`（8）、`libraryIngest.test.ts`（7）、`import-from-library.test.ts`（5）、`library-api.test.ts`（6）、`library-mcp.test.ts`（4）。**Media 面板三區 UI（庫瀏覽/搜尋/加入時間軸、上傳入庫、專案素材反向沉澱）尚未實作**，見 `docs/ROADMAP.md`。                                                                                                                                                                                                                                                                                                                |
| MCP 面補完                    | ✅                                             | **每個工具都宣告 `outputSchema`**，由 `server/test/mcp-tools.test.ts` 的「批 G」守著（工具**數量**以 `server/src/mcp.ts` 為準——那條測試是 `toBeGreaterThanOrEqual`，下限不是釘死值，所以這裡不寫死）。`m3-done` 15 個 → 當時 31 個（用跨行安全的正則對兩個版本的 `mcp.ts` 各數一次 `registerTool` 得出，見 README 的九組工具表——**這是那次快照的數字，不隨後續分支更新；現況以 `mcp-surface-snapshot.test.ts` 鎖住的 38 為準**），新增的 16 個是 `list_source`／`add_clip`／`update_overlay`／`add_overlay`／`remove_overlay`／`remove_audio`／`update_caption`／`redo`／`transcribe`／`auto_caption`／`timeline_op`／`extract_audio`／`set_audio`／`update_audio`／`set_canvas_fit`／`set_cover`（`import_media` **M3 就有**，之後改的是語意——擴充成絕對路徑零複製引用）。「工具有沒有漏註冊、instructions 有沒有跟上」由 `server/test/mcp-docs-sync.test.ts` 守著（鐵則第三步的執行面）。                                                                                                                                                                         |
| 真 undo/redo                  | ✅                                             | `server/src/store.ts` 有 `#redoStack` 與 `redo(source, steps)`、有新編輯就清空 redo（分叉）；`Command` 有 `redo` variant、MCP 有 `redo` 工具。測試 `server/test/store-undo.test.ts`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 預覽音訊同步                  | ✅                                             | `ui/src/player/sync.ts`：小漂移調 `playbackRate` 追趕（不中斷、無雜音）、大漂移才硬 seek。測試 `ui/src/player/sync.test.ts`、`ui/src/player/Player.sync.test.tsx`；spec `docs/superpowers/specs/2026-08-02-preview-audio-sync.md`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| AI 編輯動畫                   | ✅                                             | `ui/src/fx/aiPatches.ts`（一輪 AI 編輯的 JSON patch → 哪些光暈、哪些進場、捲到哪）+ `ui/src/fx/scroll.ts` + `ui/src/stores/editFx.ts`（最後一次變更後 1.6s 收窗）。測試 `ui/src/fx/aiPatches.test.ts`、`ui/src/stores/editFx.test.ts`；spec `docs/superpowers/specs/2026-08-02-ai-edit-fx.md`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 面板寬度拖曳                  | ✅                                             | `ui/src/PanelResizer.tsx` + `ui/src/panelResize.ts`（純函數）。測試 `ui/src/panelResize.test.ts`；spec `docs/superpowers/specs/2026-07-30-panel-resize-design.md`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| AI 聊天                       | ✅                                             | 人 ⇄ AI 的 meta 溝通渠道，**刻意不進 doc／版本／歷史／undo**（不是編輯操作，所以不走 `applyCommand`）。server 端 `server/src/chatStore.ts`（每專案一份 `chat.json`，載入容錯）；WS 命令 `sendChatMessage`（驗證在 `wsHub`，不在 UI）＋ `chat` 廣播；MCP 工具 `post_chat`／`get_chat`（鐵則第三步：`mcp.ts` 手動 registerTool ＋ instructions 已同步，說明「這是對話渠道，editing 仍走既有工具」）。UI 是左 AI 欄的 **Chat ⇄ Activity 內部分頁**（三態狀態卡住在 Activity 分頁內，2026-08-17 修訂），Chat 分頁**不做聊天泡泡**、靠 `--who-*` 署名分色，離線時輸入 disabled 但**草稿不丟**，AgentStrip 顯示未讀徽章。測試 `server/test/chatStore.test.ts`／`ws-chat.test.ts`／`mcp-chat.test.ts`、`ui/src/stores/chat.test.ts`／`ui/src/panels/Chat.test.tsx`／`AgentTabs.test.tsx`／`ui/src/AgentStrip.unread.test.tsx`。                                                                                                                                                                                                                                            |

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
- **時間軸手感**：Ctrl+滾輪以游標為錨縮放、吸附（片段邊界/playhead/整秒，黃線指示，N 開關）、Shift+Z 全覽、工具列 ±/Fit/吸附鈕、刻度密度隨縮放調整（`tickPlanFor` 像素密度自適應——CapCut 式：標籤永遠 ≥80px 間距、細分點補在標籤之間不佔文字，取代了原本會在門檻邊界忽密忽疏的 `tickStepFor` 六檔；60 秒以上標籤改 `m:ss`，見下方 Plan 9）。
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

- **設計系統 `ui/src/theme.css`**：CSS 變數 token 雙主題（`:root`=暗版預設、
  `[data-theme='paper']` 覆寫塊=亮版；切換器在 header（`ui/src/ThemeToggle.tsx`，2026-08-16 自 Shortcuts 彈出層搬上——舊落點可發現性低），
  `stores/theme.ts` 管 localStorage/系統偏好）；**原生 button/select/input 直接被
  theme 接管**，元件端大量刪 inline style；lucide-react 取代 emoji 圖示。
  ⚠️ **色彩世界在 2026-08 經歷三代**（詳見 spec
  [`2026-08-14-dual-theme-design.md`](docs/superpowers/specs/2026-08-14-dual-theme-design.md)
  全部修訂區塊）：紫玻璃（07-30 原版）→ 暗房調和（08-14，降飽和紫+實底亮度樓梯）→
  **剪接室暗房（08-16 起的現況，使用者經 B/C/D 與 C1–C4 兩輪 mock 選定）**：
  - **暗版現況**：中性炭黑階梯 `--bg` #1a1a1c → `--panel` #202023 → `--popover-bg`
    #2a2a2e，`--bg-stage` #131315 恆為全 UI 最暗（影片顏色判斷優先，亮版同樣成立）；
    **白蠟筆** chalk #e8e4da 做主文字/描邊/主鈕（`--on-accent` 是炭黑字）；
    **紅蠟筆 #c94f42 只做標記**（playhead 實心、時間碼進行值、當前字幕列左標
    `.cap-current`、時間軸選中 `--select-edge` 紅框、chip 紅描邊），絕不當底色；
    音訊軌降飽和藍灰；`--who-ai`=蠟筆白/`--who-you`=紅蠟筆（Two-Hands 鏡像）；
    AgentStrip 琥珀終端不動（暗房裡唯一一盞終端小燈）。紫/青在暗版全面退場。
  - **亮版=分鏡紙桌面**（08-14 craft 落地）：紙底+ink 描邊+紅鉛筆標記+non-photo blue
    波形；與暗版是同一套 Two-Hands 換支筆（鉛筆⇄蠟筆）。
  - **使用者體例定案（全 UI 通用）**：分隔線一律 1px 實線、UI 元件一律擺正、app 文字
    不用手寫體——「app 跟 landing 不一樣」；Jost 是兩主題共用 UI 字體（mono 讀數
    與字卡管線除外）。
  - canvas 波形色走 `--wave-*` token 查表（`timeline/waveform.ts` 的字面值只是 jsdom
    回退）；`--danger` 刻意比紅蠟筆**亮**（#fb8a8a，亮度比 1.36）以區辨警示與標記。
- **版面**：RenderBar 刪除 → 頂欄 ExportMenu（匯出鈕+下拉+3px 進度條）；播放控制+時間碼移進時間軸工具列；審核條改事件式 overlay 卡（GSAP 彈性滑入）；左右面板可收合（grid-template-columns 動畫），之後又補上**可拖曳調寬**（`ui/src/PanelResizer.tsx`）。**2026-08-16 使用者定案重構成「先縱切一刀」**：header 全寬不動，其下左邊是**全高的 AI 專區**（`ui/src/panels/AgentPanel.tsx`——上＝三態索引卡＋最近三筆署名列＋session 讀數，下＝完整活動流），右邊才是預覽＋右欄＋時間軸；**時間軸整條右移**、從 AI 欄右緣開始不再橫貫全寬（AI 欄收合時自然變寬，`Timeline.tsx` 量自己容器寬故不必改）。右欄分頁改「**字幕⇄屬性**」（Activity 分頁退役，內容搬左；Properties＝原左欄的 Canvas fill／Inspector 表單／Shortcuts／閒置提示），**選取任何物件自動跳 Properties 並展開右欄，取消選取不自動跳走**。實作上仍是**一個** 3 欄 ×2 列 grid（`PanelResizer` 的座標換算吃同一顆容器的 rect），骨架由 AI 欄的 `gridRow: 1/3` 與時間軸的 `gridColumn: 2/4` 兩條宣告承載。
- **時間軸**：片段卡片化（filmstrip 滿版——主軌波形帶 2026-08-16 使用者定案移除，機制與 `--wave-clip-*` token 保留無消費者，復原掛回 canvas+effect 即可）；**峰值+RMS 雙層鏡像波形只在音訊軌**（`ui/src/timeline/waveform.ts`，DPR 級解析度）；ingest 升級 **100 桶/秒＋rms 陣列**（`PeaksFile` 共用型別；舊檔無 rms 自動退單層）；音訊軌藍灰全高波形（08-16 起，原青色）；playhead 紅蠟筆實心圓頭（08-16 起，原紫漸層——漸層被對比實算否決，見 spec 修訂）；**軌頭 gutter＋雙軸捲動**（08-16 起）——左側 32px sticky 軌頭欄（Film/Image/Captions/AudioLines 圖示，`--text-3`，在 contentRef 座標系之外），可視高 `TRACKS_VIEW_H=200`（08-16 三輪定案 260→234→200）超過縱捲、尺規 sticky top；fit/縮放錨點/AI 捲動的「可視寬」一律 `clientWidth - GUTTER_W`；軌高兩輪放寬至 70/35、工具列縱向縮＋**去框**（`.tl-toolbar` ghost，Snap 開啟=填色）、**三種 chip 改粉彩家族實色底**（`--*-chip-bg`/`--accent-chip-text`：LightPink #FFB6C1 定色相＋灰粉調 s.42 v.90，暗版同色相深調；原 wash token 已除役，色值與對比見 ui/DESIGN.md Chips 段）。**Ctrl+滾輪縮放同輪修活**：wheel listener 空 deps＋首渲染 `return null` 從未掛上（`Timeline.wheelzoom.test` 守掛載時序），縮放補償遞延到 pps 渲染後的 layoutEffect 套用（同步寫會被舊佈局 clamp 吃掉）。
- **動效**：`ui/src/motion.ts`（gsap + useGSAP + motionOK）；審核條/分頁/toast/渲染完成 pulse/字幕自動捲動；微互動走 CSS transition；`prefers-reduced-motion` 全域尊重。
- **行為零改動**：命令層/MCP/播放引擎/拖曳數學全部沒碰；demo 專案已重建（新 peaks）。

**headless 截圖打通後（chromium --headless=new）親眼驗過**：版面/波形/字幕分頁/匯出鈕都正確渲染。過程中抓到並修掉一個真 bug：

- **zustand v5 selector 禁止回傳新 reference**。`useProject((s) => s.doc?.tracks.captions ?? [])` 的 `?? []` 在 doc=null（每次冷載入）觸發同步無限重渲染 → React #185 → 整個 app 白屏。dev 分頁靠 HMR 熱更新遮住了它（更新時 doc 已非 null）。修法：fallback 用模組級常數（`NO_CAPTIONS`）。**以後寫 selector 一律不得在裡面創建新陣列/物件。**
- 波形顯示用 sqrt 感知縮放（實測素材正規化振幅常 <0.3，線性會退化成細線）；trim handle 改 hover 才浮現
  （2026-08-16 定案，**已被 Plan 11 取代**——選取項改常駐可見，見下方 Plan 11 節）。

**仍待使用者驗收（體感類）**：動效手感（審核條/分頁/收合）、hover 細節、真素材上的波形觀感。舊專案想要 RMS 波形需重 ingest，不重跑也能用（單層）。
⬆️ 其中**收合/展開控制項的「可用性」已經不是未驗證項目了**：`npm run verify:panels`
（`ui/e2e/panel-affordance.mjs`）在真瀏覽器裡驗左右展開鈕可點、與收合鈕同高、
不被 ExportMenu 下拉蓋住、捲動後仍可點。**它驗的是「按得到」，不是「好不好按」**——
手感那半仍然只能靠人。

## Plan 9：時間軸縮放批——CapCut 式自適應 + 時間對齊縮圖（2026-08-21）

目標：匯入/載入自動 zoom-to-fit、放大上限=最小刻度 1 秒、filmstrip 任何縮放級距都可見且與時間對齊、順手修掉上傳完成時的畫面跳動。

- **zoom 下限不再是寫死的常數**：`MIN_PX_PER_SECOND=5` 這個字面值**只是短專案的下限**，
  不再是全域下限。`ui/src/timeline/scale.ts` 新增 `zoomBoundsFor(totalSeconds, viewportWidth)`
  → `{min, max}`：`max` 恆為 `MAX_PX_PER_SECOND`（**已從 400 降為 120**——120 恰好停在
  `tickStepFor` 的 1s 檔門檻頂，即「使用者可縮到的最細刻度=1 秒」，逐格微調需求出現前
  不開回 400，見計畫 P1 記帳）；`min = min(rawFit(total, viewport), 5)`，長專案（例：
  1687 秒在 1200px 視窗）下探到「整個專案剛好入鏡」（可能遠低於 5，如 ≈0.69px/s），
  短專案維持 5（保留縮小看留白的空間）。`clampPps(v, bounds?)` 參數化吃動態 bounds，
  缺省仍吃靜態 `DEFAULT_BOUNDS`（向後相容，非全部呼叫端都需要動態界限）。
  刻度表往下延伸到 300s 檔（門檻：pps≥40→1s、≥15→5s、≥5→10s、≥1.5→30s、≥0.5→60s、
  其餘→300s），60 秒以上標籤改 `m:ss`（`tickLabel`）。
- **自動 fit 政策**（`ui/src/stores/view.ts` 的 `fit`/`setZoomBounds`/`userZoomed` 旗標 +
  `Timeline.tsx` 的訂閱層）：(a) 專案載入（WS full doc）→ fit；(b) 總時長變化（加/刪
  clip）且使用者自上次 fit 後**未手動縮放**→ 重新 fit（`userZoomed` 由 wheel/`zoomBy`/
  `setPxPerSecond` 設 true，`fit()` 清 false）；(c) **拖曳進行中絕不自動 fit**（`prevTotal`
  在拖曳中刻意不更新，讓拖曳結束後用舊值重新比對、補上被延後的 fit，不是遺忘）；
  (d) resize（`ResizeObserver`）重算 clamp，若使用者未手動縮放過也一併重 fit；
  (e) 手動 Fit 按鈕/Shift+Z 行為不變。上傳完成的 `addClip` 落在 (b)——原本的畫面跳動
  變成「一次到位的重取景」。**v1 不做補間動畫**（fit 是一個 layout pass 到位；150ms
  補間與 wheel-zoom 的 scroll 補償如何協調列 P1 記帳，風險>收益暫緩）。
- **filmstrip 從「單一 background 紋理」改為時間對齊的逐格 div**（`ui/src/timeline/
filmstripTiles.ts` 新檔 + `ClipBlock.tsx` 消費）：舊模型的 tile 寬（`frameW`，維持
  素材長寬比）不吃 pps，只在「一格恰好等於畫面上一秒」時才對齊——zoom-out 出現重複
  紋理錯位、zoom-in 單格被拉伸出可辨識範圍、clip 寬 < 一格時整條 filmstrip 直接消失。
  新模型每格是獨立 div，固定寬 `frameW`，第 i 格中心時間 `t_i = clip.in + (i+0.5)·
(frameW/pps)`，`tileIndex = round(t_i/secPerTile)` 對 sprite 做 `backgroundPosition`
  裁切——zoom-out 自然變成「每 N 格取樣一張」、zoom-in 自然變成「同格連續重複」，
  任何縮放級距都是完整縮圖且與時間軸對齊；`w < frameW` 時仍渲染單格（裁右緣），
  消失 bug 因此不再可能發生。**視窗裁剪（windowing）**：ClipBlock 只渲染捲動視窗內
  的格（Timeline 把 scrollLeft/viewport 寬傳下去），避免 zoom-in 時格數爆炸（120pps
  × 1687s ≈ 5000 格）；scroll 走 rAF 節流更新。舊資產相容：`filmstripTiles` 缺席
  （這個欄位加入之前 ingest 的專案）→ `secPerTileFor` 回退每秒一格，與舊版
  `filmstripBgOffset` 的回退語意一致；filmstrip 尚未生成（分階段 ingest 過渡態）→
  維持底色不變。**`dragMath.ts` 的 `filmstripBgOffset` 已隨舊渲染路徑退役刪除**
  （grep 確認無其他消費者後才刪）；`shared/src/filmstrip.ts` 的 `filmstripPlan`
  （產格邏輯，server ingest 端）沒動，變的只是 UI 端怎麼消費那些格。
- **blur 背景 video 換 src 閘門**（`ui/src/player/Player.tsx`）：背景模糊填充那顆
  `<video>`（`scale(1.15)`）原本只比對 src 字串是否相同，proxyPath 晚到（A2 背景
  transcode）就會重載閃一下；現在改成與主 A/B video 同款的 **`clipId` 閘門**——
  素材身分不變就不換 src，proxyPath 之後補到也不重載。與 zoom/filmstrip 無關，
  是這批「順手修掉的另一半畫面跳動」，對開源線同樣成立。
- **驗證**：既有 `Timeline.wheelzoom.test.tsx` 等單元測試斷言已跟著新界限/新 fit
  行為改寫（不是刪測試）；真瀏覽器 `npm run verify:canvas`／`verify:panels` 覆盤
  drag/snap/overlay 幾何——**兩支對 zoom 幾何改動零假設**，全綠且不需要改寫任何
  script 期望值（腳本本來就不依賴特定 pps 起始值，量的是相對幾何與畫布縮放矩陣）。

## Plan 11：修剪直觀化批——CapCut 式 trim 手感,全軌道一致（2026-08-22）

目標：修剪時「盲剪」（trim 從不呼叫 seek、拖曳中零數字回饋）、把手 hover 才現且
窄片互疊、overlay 完全沒有把手、無 trim 鍵盤路徑、絕對時間軌重疊無提示
——這五個缺口的根治。純 UI 批，**`server/` 全程零改動**（Task 1–4 對
`git diff fa088b7..HEAD --stat -- server/` 已驗證為空，Task 5 覆核仍空）。

- **播放器跟隨修剪邊**（Task 2）：trim 拖曳中 playhead 用 rAF 節流 seek 到被拖那條
  邊的時間軸位置（in 把手＝clip 起點、out 把手＝clip 終點；audio/caption/overlay
  同理）——`Timeline.tsx` 的 `scheduleFollow`/`trimFollowing`/`followRaf` 機制，一幀
  最多一次 seek，永遠吃最新值。放手後 playhead 停在該邊、不彈回。暫停態才跟隨；
  播放中開始 trim 先自動暫停。`trimFollowing` 旗標拖曳期間排除 playhead 進吸附候選
  （不然 playhead 鏡射被拖的邊會自己吸自己、鎖住）。與 `verify:wysiwyg` 無涉（不碰
  渲染管線）。此機制沿用既有的 caption span 拖曳（`mode: 'cap'`）本來就有的
  `scheduleFollow` 呼叫，Task 1–4 只是把它從「caption 專用」擴大成四軌共用——不是
  新發明一套節流。
- **拖曳中數字 badge**（Task 2，新 `ui/src/timeline/DragBadge.tsx`）：浮動小標籤跟著
  把手，內容 `時長 (±增減)`（如 `3.2s (−0.8s)`；≥60s 用 `m:ss`；主軌拖到來源上限
  時附加 `max`）,move 拖曳顯示新起點時間。單一元件全軌道共用，繪製在 Timeline 頂層
  （不進 chip 內）,不吃 CSS transition（拖曳中 1:1 跟手）,放手即消失。
- **把手升級**（Task 1，變更 2026-08-16 hover-only 幾何定案）：選取的項目把手常駐
  可見（不再 hover 才現）,命中區 6px→**選取項 12px、跨在片段邊界正中央**（chip 內
  6px＋chip 外溢 6px,不是舊版「純向內長滿 12px」——那樣窄片可移動帶會被壓到只剩
  ~4px）,中央疊 2px grip 紋提示可抓;窄片（chip 寬 <28px）選取後兩把手向外溢出、
  互不重疊;選取 chip 同時抬升到 `zIndex: 15`,讓外溢的把手蓋在鄰近 chip 之上。
  未選取項維持原 hover-only 行為不動。完整定案細節與 CSS 落點見
  `ui/DESIGN.md`「Chips → Trim handles」——那裡是這條規則的權威來源。
- **overlay 補 trim 把手**（Task 1）：與 caption chip 同款,沿用既有
  `trimSpanIn`/`trimSpanOut` 純函數（anchor 模式 offset 換算沿用現行 move 的處理）。
  「to end」overlay（`duration: null`）只有 in 把手,拖 out 把手時先落地為具體
  duration（與 Inspector 的「到結尾」勾選互通）。命令仍是放手一發 `updateOverlay`。
- **來源長度上限的視覺語言**（Task 3）：主軌 out 把手拖到 source 盡頭
  （`probe.duration`,`dragMath` 既有 clamp 上補視覺）時,把手變 `--danger` 色
  （geometry 不變,只覆蓋顏色）+ badge 顯示 `max`——「拉不動」從沉默變可見。
- **`[`/`]` 鍵盤 trim**（Task 3）：把**選取項**的 in/out 修到目前 playhead（四種
  軌道通用；主軌走 `trimIn`/`trimOut`,其餘走 `trimSpan` 系）,與既有 Q/W（ripple
  刪除,動全時間軸）語意區隔清楚——`[`/`]` 只動選取項。無選取時 no-op；輸入框聚焦
  時不觸發（`App.tsx` 鍵盤 handler）。Shortcuts 彈出層同步更新。
- **同軌重疊視覺提示**（Task 4,絕對時間軌：overlay/caption/audio）：同軌兩項時間
  重疊時,重疊子區間在 chip 頂緣畫 2px `--danger` 線（`zIndex: 16`,蓋過選取 chip 的
  15）。純視覺,不阻擋操作——重疊有時是刻意的（如 BGM 疊音效）。讀的是**已提交的
  doc**,不接拖曳中的預覽覆蓋：拖曳中這條線停在拖曳前的位置,放手後才跳到新位置
  （純函數 `overlap.ts` 的 `overlapSegments`,memo 過)。主軌天生結構性 ripple 不會
  重疊,不適用此檢查。
- **sendContext 節流**（Task 5 覆核,非本批新增行為）：`App.tsx` 的
  `sendContext`（回報 AI `get_editor_context` 用的編輯脈絡）訂閱 `usePlayback`/
  `useSelection`,每次變動重設 150ms 防抖計時器。trim-follow 拖曳透過
  `scheduleFollow`→`usePlayback.seek()` 觸發這條路徑,但 `seek()` 本身已被 rAF 節流
  到一幀最多一次——這與拖曳中已存在的 caption span 拖曳走的是同一條防抖路徑,不是
  這批新增的流量型態。真正不驅動這條路徑的是 clip move 拖曳（只動本地
  `pointerX`/`rerender`,不碰 `usePlayback`/`useSelection`）,move 拖曳期間反而完全
  不產生 `sendContext` 呼叫。
- **驗證**：`npm run verify:panels`／`verify:canvas` 對這批把手幾何改動零假設,兩支
  皆全綠、未改寫任何 script 期望值（把手改動沒有落在這兩支腳本量測的路徑上：
  panels 驗的是面板收合/展開/下拉不重疊,canvas 驗的是 overlay 拖曳與畫布縮放矩陣,
  皆不觸碰時間軸片段把手）。

## Plan 12：前把手直接操縱批——主軌 trim-in 邊釘手指下、player 首幀即時跟（2026-08-21）

目標：修 Plan 11 收尾後仍殘留的三個缺口——主軌前（in）把手拖曳時畫面內容跟著
捲動、被拖的邊本身反而在螢幕上漂移（CapCut 等競品是「邊釘住不動、素材在邊後面
讓位」）；player 在 trim-in 拖曳期間完全不跟——放手才看到新首幀；in=0（素材用盡）
與 audio out 頂到來源長度上限都是 silent clamp，沒有任何視覺信號。**這三個缺口
的根治**（下方各條即交付後的現況）。純 UI 批,**`server/` 全程零改動**（`git diff
aae6e75..HEAD --stat -- server/` 為空,含 Task 1–3；MCP 未觸及,不需同步 `mcp.ts`）。

- **主軌 trim-in 捲動補償**（Task 1；⚠️ **Plan 15 起這條只適用擴張方向**,見下方
  Plan 15 小節）：拖曳中每幀把 `scrollLeft` **絕對重算**成「起手時的 scrollLeft ＋
  這一幀的 duration 變化量（px）」（`el.scrollLeft = scrollLeftAtDragStart +
(timeToPx(dur) - timeToPx(origDuration))`,`Timeline.tsx` 的 `onPointerMove`
  trim-in 分支）,讓被拖的前緣**釘在指標下方**、clip 既有內容與其後片段在螢幕上
  靜止,前面的片段讓位——不是逐幀累加。選絕對重算是因為 `scrollLeft` 會被瀏覽器
  夾在 `>=0`：累加值撞底之後再往回拖會跟真實 scrollLeft 脫勾,之後的補償全部算錯;
  絕對重算每幀都從同一個起點出發,天然免疫這個問題。同批**移除 main-track trim-in
  的 snap**（不再吸內容座標）——舊行為吸的是「右緣」,但補償模型下右緣（clip 起點）
  本身不移動、左緣的內容座標也不是使用者在看的東西,兩者都沒有可吸的意義；
  `setSnapLine(null)` 恆成立,in=0 的硬停點仍由 `trimIn` 純函數的既有 clamp 負責,
  不需要 snap 這層再夾一次。trim-out 不受影響（右緣本來就跟手,維持 Plan 11 行為）。
- **player 即時顯示新首幀**（Task 2,`usePlayback.trimPreview`）：main-track
  trim-in 拖曳中,player 立即顯示新首幀而非拖曳前的舊值——`trimPreview`
  是 transient 欄位（`{clipId, in}`）,不進 doc、不是 command、不進 history,與
  `scheduleFollow` 共用同一個 rAF 節流節奏寫入（不逐 pointermove 都寫）。
  `plan.ts` 的 `planAt`/`sourceFor` 消費這個 override：只覆蓋 clipId 相符的 clip
  的 `in`;省略/null 時映射與現行行為逐位元組相同。
  ⚠️ **這句話從 Plan 15 起有限定詞,見下方 Plan 15 小節**：`offsetInClip`
  **不再**恆不受影響——修剪方向拖曳中 playhead 被 `scheduleFollow` 帶到
  `clipStart + 頭端佔位`,`locate()` 算出的 offset 因此含一段佔位量,`TrimPreview`
  多了一個可選的 `placeholderHead` 欄位把它扣回去（Plan 15 終審 fix wave Critical 1,
  見下方）。**生命週期綁 pending,不是綁拖曳手勢本身**
  （review round 1 修正）：原本 `teardownDrag`（pointerup/pointercancel 共用拆卸）
  在放手當下就同步清空 `trimPreview`,但 `sendCommand` 送出到 doc echo 抵達之間
  有非同步空窗——那幾幀 `planAt(doc, time, null)` 用 doc 裡還沒更新的舊 `in`,
  暫停態的漂移校正把 `video.currentTime` snap 回舊幀,echo 一到又跳新幀,形成放手
  瞬間的閃爍（整個手勢最顯眼的一刻）。修法：commit 路徑（送出 `updateClip`）讓
  `trimPreview` 繼續蓋著,清空時機交給既有的 pending 對帳區塊（echo 抵達、in/
  duration 對上）與 1.2s 保險絲（命令被拒/resync 掉包等 echo 永遠不來的情況）——
  兩個清除點都呼叫新的 `clearPendingAndTrimPreview` helper,確保與 `pending.current`
  同步清除,不會出現「清一邊留一邊」的殘留態。cancel 路徑（`onPointerCancel`）與
  零位移放手（`d.preview` 從未被 move 改過）維持在 `teardownDrag` 內立即清空——
  前者沒有 pending 可以綁、退回舊幀語意上就是對的,後者從一開始就是 null。
- **in=0 min 視覺 + audio 源長上限 max 視覺**（Task 3）：`dragMath.ts` 新增
  `isAtSourceMin(clip) = clip.in <= 0`,是 Plan 11 既有 `isAtSourceMax` 的對稱雙生
  （來源起點恆為 0,不像 `mediaDuration` 那樣可能缺席,不需要它那層
  `Number.isFinite` guard）。主軌 in 把手拖到 `in<=0` 時比照 Plan 11 的 out-handle
  danger 態改色（`ClipBlock` 新增 `inAtMin` prop → `.handle.danger`,沿用既有
  CSS 規則,不發明新視覺）;audio out 把手頂到來源長度上限（`mediaDur - orig.in`
  上限,`Timeline.tsx` 新增 `audioOutAtMaxId`,複用 `isAtSourceMax`）同樣改色
  （`AudioChip` 新增 `outAtMax` prop）。`DragBadgeContent` 加 `atMin?: boolean`
  （與既有 `atMax` 互斥——in 把手只會 `atMin`、out 把手只會 `atMax`）,
  `formatDragBadge` 附加 `· min` 後綴（`· max` 的對稱寫法,同樣是附加而非取代——
  時長/增減數字本身仍是有用資訊）。
- **驗證**：`npm run build -w @vidcut/ui` 後,`npm run verify:panels`／
  `verify:canvas`（隔離 server,`VIDCUT_PORT=3846`）對這批改動零假設,兩支皆全綠、
  未改寫任何 script 期望值或斷言——trim-in 的捲動補償與 player 首幀邏輯都不落在
  這兩支腳本量測的路徑上（panels 驗面板收合/展開/下拉,canvas 驗 overlay 拖曳與
  畫布縮放矩陣,皆不觸碰主軌 trim 把手或 player 內部狀態）。

## Plan 13：結束語意批——輸出長度不再等於主軌,黑尾補齊、時間軸看得見（2026-08-24）

目標：主軌播完但字幕/音訊/具體時長 overlay 還沒演完時,渲染直接截斷、播放器
提前停在黑畫面、時間軸完全不畫出「其實還有內容」這件事,使用者只能盲猜、AI
只能盲猜——**這三個缺口的根治**（下方各條即交付後的現況）。純新增語意,無黑尾
的既有專案（絕大多數）在渲染/播放/時間軸/MCP 四層全部逐位元組行為不變——
`output === total` 是每一層的短路條件,不是「大致相同」。

- **`outputDuration` 語意（Task 1,`shared/src/timeline.ts`）**：新純函數
  `outputDuration(p) = max(主軌總長, 各 audio 的 start+duration, 各 caption 的
start+duration, 各**具體時長** overlay 的 start+duration)`。到片尾
  （`duration: null`）的 overlay **不參與**這個 max——它的視窗結尾本身就是「跟隨
  outputDuration」（`overlayWindow` 對它的 `end` 現在算 `outputDuration(p)` 而不是
  舊的 `totalDuration(p)`）,若把它也納入 max 會變成「輸出長度取決於一個取決於
  輸出長度的值」,是刻意避開的循環——`outputDuration` 內部改叫新的
  `overlayStart()`（只算起點,不算 end）,不呼叫 `overlayWindow`,所以不構成遞迴。
  無黑尾專案 `outputDuration(p) === totalDuration(p)`,這是後面每一層短路的共同前提。
- **渲染黑尾（Task 2,`server/src/render.ts`）**：`output > total` 時,在 concat
  之後的 `[vcat]` 上插一段 `tpad=stop_mode=add:stop_duration=(output-total):
color=black[vtail]`,補到 outputDuration；字幕/overlay 合成鏈從 `[vtail]`
  （而非 `[vcat]`）疊上去——這樣它們的 `overlayWindow`（Task 1 起已跟隨
  outputDuration）落在黑尾區間時才有畫面可疊,不會疊到不存在的軌。獨立音訊項的
  `atrim` 截斷基準同步從 `total` 換成 `output`（改回 `total` 會把撐大 outputDuration
  的那段尾音自己剪掉）；沒有獨立音訊項但仍有黑尾時,`[aclips]` 補 `apad`+`atrim`
  到 `output`,避免容器音軌比畫面短。渲染進度分母（`totalDuration` 回傳值）同步
  改回報 `output`,否則 ffmpeg 的 `out_time_ms` 永遠追不上用主軌總長算出的分母,
  進度卡在 <100% 就直接跳到 done。⚠️ **這是 concat 之後的插入點,與商業線
  （cloud 分支）per-clip 鏈 fps= 之後的轉場 `tpad`/clone 機制不是同一處**——
  merge 之後兩者並存,不要混在一起改（`render.ts` 該行有這條警告的原文）。
  `output === total` 時完全不觸發黑尾相關的濾鏡插入,`render.test.ts` 的釘測試
  守著這個位元組級不變的承諾。
- **播放/黑尾 UI（Task 3,`ui/src/player/plan.ts`＋`Player.tsx`）**：`planAt` 新增
  `blackTail` 旗標（`t` 落在 `[主軌總長, outputDuration)`——主軌已播完、輸出還沒
  結束）,與 `done`（`t >= outputDuration`,改自舊的 `t >= totalDuration`）互斥。
  黑尾區間 `active`/`next` 皆為 null,Player 依此把 A/B 兩層 video **與** blur
  背景層一併隱藏（`showVideo = plan.active !== null`）並暫停——修的是一個真
  bug：舊行為只暫停 video 元素不隱藏,畫面會凍結在主軌最後一幀而不是變黑,而且
  blur 背景層完全沒被處理過,播放中進入黑尾時會帶著上一刻的 playbackRate 繼續
  播放耗資源。**Timecode 讀數改為 output-based**：`usePlayback().total` 由 Player
  的 doc-echo effect 餵 `outputDuration(doc)`（不再是 `totalDuration`）,工具列
  Timecode 直接讀這個 store 值,不再吃呼叫端傳入的 `total` prop——那個 prop 綁的
  是 Timeline.tsx 的主軌 `totalDuration`（Task 4 的 fit/寬度基準,語意不同）,有
  黑尾時兩者會分岔,讀數必須跟著「使用者實際能播到哪」走。**順手把 Timecode 格式
  與 DragBadge 的 `formatSeconds` 對齊**（<60s 一位小數 `Ns`,>=60s 借 `tickLabel`
  的 `m:ss`）——`verify:wysiwyg` 的 `readTimecode` 正則同步改過（舊正則比對的是
  已經不存在的舊格式 `m:ss.s / m:ss.s`,永遠比對不到、讀出來一律 null,直到這批
  才被抓到；這是 Task 3 遺留、Task 4 順手修的一行）。
- **時間軸視覺（Task 4,`ui/src/timeline/Timeline.tsx`）**：
  - **END 柱＋旗標**：`output` 處貫穿全軌（尺規＋四條軌道列）的豎線＋頂端
    `END Ns` 文字牌,`--line-strong`/`--text-2` 系——**與 playhead 視覺明確區分**
    （playhead 是 `--accent-bright` 紅蠟筆漸層＋光暈＋圓頭,END 柱是結構線,見
    `ui/DESIGN.md` 的具名規則）。純視覺、不可拖曳,位置永遠跟著 `output` 走,單一
    真相來源在造成黑尾/滲出的那個 chip 本身。
  - **死區降暗**：`output` 之後整條時間軸（尺規＋全部軌道列的累計高度）蓋一層
    暗色 scrim（新 token `--tl-deadzone-bg`,比 `--timeline-well-bg` 再深一階）,
    一眼可辨「這之後不算進輸出」。純視覺、不可互動。
  - **黑尾帶**：`[主軌總長, output)` 這段在主軌 clip 列畫暗色斜紋帶（既有
    `--clip-band-bg`/`--panel` token 疊 `repeating-linear-gradient`,不新增顏色
    語彙）,只在真的有黑尾（`output > total`）時畫,讓使用者一眼看出「這段是黑
    畫面,因為下面有 chip 突出主軌」。純視覺、不可互動。
  - **寬度/fit/縮放下限全部改鍵到 `output`**：內容層寬度算式
    （`contentWidthPx = timeToPx(total,pps)+120` 下限 600）、三處自動 fit
    effect（載入、resize、`__vidcutFit` 除錯鉤子）、Toolbar 的「Jump to end」
    目標與手動 Fit 鈕、尺規刻度密度（`labelCount`/`dotCount`）——全部把原本吃
    `totalDuration` 的地方換成 `outputDuration`,超出主軌的內容才捲得到、fit 才
    裝得下、刻度才蓋得到黑尾帶底下。無黑尾專案兩個函式重合,行為不變。
  - **永遠填滿（裁決 10）**：新增 `fillsViewport(pps,total,viewportWidth)` 判斷
    「內容是否不比視口窄」。原本「使用者手動縮放過就不再自動 fit」的政策
    （Plan 9 範圍裁決 #4）追加例外：**總長真的變了、且變窄到比視口窄**時（例如
    刪掉造成黑尾的那個 caption,`output` 縮回 `total`）,即使使用者縮放過也要
    重新 fit 填滿,不留一大片空白視口；resize 時同理（視窗變大導致現有 pps 下
    內容已經填不滿視口,同樣觸發 fit）。既有「拖曳中絕不 fit」的守門
    （`if (drag.current) return`）原樣複用,不因這條新觸發而失守。
  - **`willCommitDrag` 鏡射 `onPointerUp` 提交條件——已知耦合,靠註解紀律,沒有
    機械閘門**：`teardownDrag` 新增 `willCommit` 參數,只在**非** commit 路徑
    （cancel、零位移放手）才把「時間超出還原後 total 的 playhead」clamp 回去；
    commit 路徑（例如主軌 trim-out 把總長拉過舊 total、`scheduleFollow` 把
    playhead 追過去）放著不 clamp,交給隨後的 doc echo 收斂,理由與 Plan 12
    Task 2 的 `trimPreview` 閃爍修法完全同構——若在 `sendCommand` 送出到 echo
    抵達之間的 WS round-trip 裡搶先 clamp,playhead 會肉眼可見地瞬間倒退、
    echo 一到又跳回去。**`willCommitDrag()` 判斷「這次放手會不會送出命令」的
    邏輯,必須與 `onPointerUp` 下方各分支實際的送出條件逐字同步**——這是一個
    平行維護的判斷式,靠的是函式旁的註解互相指認對方（"兩處判斷式必須逐字同步,
    任一邊改了送出守門都要一起改這裡"）,**沒有測試或型別系統強制兩者一致**。
    下次改 `onPointerUp` 任一分支的送出守門（例如把某個 no-op 判斷收緊/放寬）
    務必回頭檢查 `willCommitDrag` 是否也要跟著改——這是本批唯一一個「正確性
    依賴人讀註解」而非「正確性被結構性擋住」的地方,列在這裡是為了讓下一個
    改這段程式碼的人（人或 AI）不會漏掉。
- **MCP 輸出語意同步（Task 5,`server/src/mcp.ts`）**：`get_project` 的 `total`
  欄位改回報 `outputDuration`（不再是主軌總長）,`outputSchema` 的欄位描述與
  `set_timeline`/`render`/`get_frame` 的工具說明都補了「輸出長度＝任一軌道最遠
  處,不只主軌;超出主軌的畫面是黑尾,字幕/音訊/overlay 在那段仍照常播放」。
  `total` 與主軌總長不同時,`get_project` 的文字摘要額外帶一句附註（如
  `total 8.5s (video 5.0s + 3.5s black tail)`）,讓 AI 不必自己去算兩者的差；
  相等時（絕大多數專案）完全不提,文字摘要位元組級不變。**`get_frame`／`render`
  的不對稱要點記在這裡,因為容易被誤推**：`get_frame` 的時間夾制上界也從主軌
  總長換成 `outputDuration`,黑尾時刻不再回「查無片段」的錯誤,而是回一張
  `color=black` lavfi 生成的黑幀（`server/src/frame.ts` 新增
  `extractBlackFrame`,與 `render.ts`/`extractCover` 的黑尾合成——tpad 疊字幕/
  overlay——是**不同機制**：get_frame 本來就只回「片段畫面」不合成任何東西,
  黑尾時刻沒有片段可抽,用同一支黑色 lavfi 幀維持這個既有語意一致,不是走一條
  「像 render 一樣疊字幕」的路）。**但 `render` 仍然要求主軌至少一個 clip**——
  純字幕/音訊專案（主軌淨空）`get_frame` 在黑尾時刻會成功,`render` 卻會以
  `timeline is empty` 失敗;`get_frame` 成功不能拿來推論「這個專案可以 render」,
  兩個工具的描述都各自補了這句互相指認的警語,避免 AI 用前者的成功結果誤判
  後者也會成功。
- **驗證**：`npm run build -w @vidcut/ui` 後,`npm run verify:panels`／
  `verify:canvas`（隔離 server,`VIDCUT_PORT=3846`）與 `npm run verify:wysiwyg`
  三支皆全綠,均未改寫任何既有斷言/期望值（唯一改動是 Task 3 因 Timecode 格式
  變動而必須同步的 `readTimecode` 正則,見上方 Task 3 節,那是與新格式對齊而非
  放寬容差）。`verify:wysiwyg` 六個 case 全綠,最大墨跡外框差 1.0px（容差 4）——
  渲染鏈這批改了 concat 後的插入點與截斷基準,`verify:wysiwyg` 覆蓋的正是這條
  鏈路,是這批唯一必跑而非可選的真瀏覽器回歸。`bash scripts/gauntlet.sh` 全綠。

**這三個缺口的根治**：渲染不再靜默截斷字幕/音訊/overlay 的尾巴——黑尾補齊,
`output === total` 時位元組級不變;播放器不再假裝主軌播完就是全部播完——三層
video 正確變黑、Timecode 讀數換算基準統一;時間軸不再對「其實還有內容」保持
沉默——END 柱、死區、黑尾帶三層視覺一次交代清楚,且永遠填滿不留空視口。MCP 的
`get_project.total` 與這三層同步换算基準,AI 讀到的數字與人在瀏覽器裡看到的
是同一個「輸出長度」。

## Plan 14：clip 前把手黑墊——leadPad(2026-08-23)

目標：主軌 clip 的前（in）把手拉過來源起點時,CapCut 等競品是「長出一段黑畫面
（黑墊）」,vidcut 之前是硬停（Plan 12 的 `isAtSourceMin`/`danger+min`）。這批把
硬停換成黑墊,資料模型、命令層、渲染、播放器、時間軸 UI、MCP 六層全部落地
（commits `938cfb9`→`9833d4a`）。

- **資料模型**：`VideoClip.leadPad?`(秒,≥0,缺席＝0,`shared/src/types.ts`)。
  `duration` 語意不變——**仍是時間軸長度、含黑墊**;內容長度＝`duration − leadPad`,
  內容從來源 `in` 開始播。黑墊本身＝黑畫面無聲,沒有對應的來源畫面。來源時間映射
  唯一真相來源是 `shared/src/timeline.ts` 新增的 `clipSourceTime(clip, offsetInClip)`
  （落在黑墊內回 `null`）與 `clipContentDuration(clip)`（＝`duration − leadPad`）——
  render/frame/player/MCP 四層一律走這兩支,不得各自手算 `in + offset`
  （commands.ts、render.ts、frame.ts、player/plan.ts 的 diff 都印證這點）。
  `server/src/commands.ts` 的 `updateClip`/`addClip`/`setTimeline` 驗證把邊界式子
  從「`in+duration<=srcDur`」換成「`in+內容長度<=srcDur`」,並新增「內容長度
  ≥ `MIN_CLIP_DURATION`」;`splitAt`/`freezeFrame` 拒絕切點/凍結點落在黑墊內
  （黑墊沒有來源畫面可切/凍）;`deleteBefore`/`deleteAfter` 依切點落在黑墊或內容
  分支處理（黑墊內只削墊,不拒絕;deleteAfter 若切完只剩黑墊則整支刪）;
  `extractAudio` 抽出範圍跳過黑墊段（`start` 往後移 `leadPad`、`duration` 用
  `clipContentDuration`）。無 leadPad 的既有專案在全部命令下逐位元組行為不變
  （`server/test/commands-t1.test.ts` 的回歸釘）。
- **拖曳語意（`ui/src/timeline/dragMath.ts`＋`Timeline.tsx`）**：新增
  `trimInPad(clip, deltaSec)` 取代主軌拖曳分支原本的 `trimIn`——越過來源起點不再
  硬停,而是往左長出 `leadPad`,`duration` 同步增長以維持時間軸右界不動。純函數
  不吸附;`in=0`（黑墊歸零、回到純內容）的吸附是 `Timeline.tsx` 自己在來源座標系
  做的（`snapExtendedX`,沿用既有 `SNAP_THRESHOLD_PX`,吸附命中時畫吸附導線於
  `clipStart`）。拖曳中 badge（`DragBadge.tsx` 的 `formatDragBadge`）在 `pad>0`
  時附加 `· black +X.Xs`（英文一位小數）——**取代**舊的 `atMin`/`· min` 語彙
  （`isAtSourceMin` 已廢止,理由：黑墊不是「拉不動」的錯誤狀態,是使用者刻意要的
  效果）。`ClipBlock.tsx` 的 in 把手改用 `.handle.accent`（`--accent-bright`,
  playhead 同色系,語意「使用者手上正在做的事」）而非 `.handle.danger`,並新增
  黑墊視覺（clip 左緣起 `leadPad×pps` px 的斜紋帶,與 Plan 13 黑尾帶同一組
  `--clip-band-bg`/`--panel` token）;filmstrip 縮圖區跟著右移 `padPx`（黑墊沒有
  素材畫面可畫縮圖）。⚠️ **`[` 鍵盤快捷鍵（`App.tsx` 呼叫的仍是舊 `trimIn`）維持
  硬停語意,尚未接上黑墊**——拖曳把手與鍵盤快捷鍵目前是兩套不同行為,是已知不一致
  （見下方「已知不一致」）。
- **渲染插入點（`server/src/render.ts`）**：per-clip input 只吃內容長度
  （`clipContentDuration`）;`leadPad>0` 時在**這個 clip 自己的濾鏡鏈尾**（`fps=`/
  `setpts=` 之後、`[v${i}]` 標籤之前）補一段 `tpad=start_mode=add:start_duration=
${pad}:color=black`,把這個 input 的輸出長度墊回 `clip.duration`;音訊補
  `adelay` 前置靜音把聲音移到正確絕對位置。⚠️ **這是 per-clip、`concat` 之前的
  插入點,與另外兩個插入點是不同位置,merge 時不要混在一起改**：Plan 13 的黑尾是
  `concat` **之後**、`[vcat]` 上的 `tpad=stop_mode=add`（補在時間軸尾端）;商業線
  （cloud-p0）的轉場 tpad/clone 又是另一個 per-clip 但語意不同的插入點。三者並存,
  `render.ts` 該處原始碼留了這條警告。`renderCoverImage`／`server/src/frame.ts`
  的 `extractFrame` 同步改走 `clipSourceTime`,落在黑墊內回既有的 `extractBlackFrame`
  （frozen clip 保留「內容段固定抽 `in`」的定格語意不受影響）。無 leadPad 的既有
  專案三處改動全不觸發,`render.test.ts`/`render-leadpad.test.ts` 有逐位元組回歸釘
  與真 ffmpeg 整合測試（黑墊像素級全黑）。
- **播放器（`ui/src/player/plan.ts`）**：`sourceFor` 改走 `clipSourceTime`,
  offset 落在黑墊內回 `null`（`active=null`）——`Player.tsx` 既有的黑尾遮黑/靜音
  機制（`active !== null` 判斷,見 Plan 13 Task 3）天然覆蓋黑墊段,`Player.tsx`
  本身零改動。`planAt` 的 `next` premount 語意：offset 落在本 clip 黑墊內時,
  `next` 指向**本 clip 的內容起點**（而不是下一個 clip）,黑墊播完時無縫接上畫面。
  `TrimPreview` 型別擴為 `{clipId, in, leadPad?}`,拖曳中 `Timeline.tsx` 每幀都
  帶明確 `leadPad`（含 0）,否則縮回、黑墊歸零那一刻 player 會繼續顯示黑畫面
  （`plan.ts` 內 `TrimPreview` 註解、`effectivePadFor` helper）。
- **MCP 曝光（`server/src/mcp.ts`）**：`update_clip`/`set_timeline`/`add_clip`
  的輸入 schema 與 description 都補了 `leadPad`（`set_timeline` 是整組替換,不帶
  ＝歸零,不沿用舊值;`update_clip` 是 partial patch,不帶＝維持現值）。
  `get_project` 的 clip 摘要只在 `leadPad>0` 時才帶這個欄位（與其他選填欄位的
  慣例一致,見 `projectSummary()` 註解）。`get_frame`／`timeline_op` 的 description
  各補一句：黑墊時刻回黑幀（同黑尾語意）;`split`/`freeze` 的切點/凍結點落在黑墊內
  會被拒絕（即使離兩側都有 0.1s 邊界緩衝也一樣,理由是黑墊沒有來源畫面可切/凍）,
  `deleteBefore`/`deleteAfter` 則優雅處理（削墊或整支刪,不拒絕）。工具面鎖進
  `server/test/__snapshots__/mcp-surface.snap.json`,改動已核對 diff 屬實後 `-u`。
- **已知不一致**：主軌拖曳把手（滑鼠）已經是黑墊語意（`trimInPad`）,但
  `App.tsx` 的 `[` 鍵盤快捷鍵仍呼叫舊的 `trimIn`,越過來源起點時維持**硬停**
  （不會長出黑墊）。同一個操作（trim-in）兩種輸入方式行為不一致,是這批刻意留下
  的範圍裁決（`isAtSourceMin` 廢止後只有滑鼠路徑跟著換,鍵盤路徑未動）,尚未排入
  下一批。
- **P1 待辦**：**尾端黑墊（tailPad,clip 結尾往後墊黑畫面）未做**——這批只做了
  前把手（leadPad）,對稱的尾端黑墊留待後續評估,不要與 Plan 13 的「輸出黑尾」
  （主軌播完、其他軌道還沒演完時墊在整條時間軸尾端）混為一談,tailPad 是
  **單一 clip** 自己的尾端黑墊,是不同粒度的功能。

## Plan 15：trim 拖曳佔位黑墊——修剪方向不再即時 ripple（2026-08-24）

純 UI 批（`shared/`/`server/`/命令層/MCP 全程零改動,`dragMath.trimPlaceholder`
是唯一新函數,不進 doc）。修剪方向（拖窄）拖曳中不再即時 ripple 後續 clip:
被修掉的區段以半透明黑墊佔位撐住 clip 的時間軸足跡（`trimPlaceholder(origDuration,
nextDuration) = max(0, orig-next)`,`dragMath.ts`）,版面凍結、把手跟手,放手
才真正閉合收斂(`f0aa5d2`+`cc20293`)。擴張方向（還原素材/長 leadPad）維持 Plan 12/14
的即時 ripple+捲動補償不變。**捲動補償量因此收斂為只在擴張方向非零**
（`Timeline.tsx` 的 `dur >= d.origDuration` 決定 `deltaPx`,見上方 Plan 12 Task 1 小節的
限定詞）——修剪方向的補償量恆為 0（每幀寫回 `scrollLeftAtDragStart`,不是完全
不寫,見下方 fix wave Minor 2）,把手位置改靠佔位邊界（`ClipBlock` 的
`placeholderHeadPx`/`placeholderTailPx`）本身跟手。

### Plan 15 終審 fix wave（2026-08-24）：trimPreview 佔位映射 + 文件/註解修正

終審抓到 1 Critical / 2 Important / 5 Minor,全部併入這一輪修完（審查工作檔隨
SDD workspace 清掉,不入版控;逐條結論已內化到下面各點與對應測試）：

- **Critical 1（player 顯示錯誤畫面）**：修剪方向拖曳中 `scheduleFollow` 把
  playhead 帶到「clipStart + 頭端佔位」,但 `plan.ts` 的 `sourceFor`/`planAt` 吃的是
  committed `doc`（clip 起點/duration 拖曳中不變）,`locate()` 算出的
  `offsetInClip` 因此多算了一段等於佔位量的偏移,`sourceTime` 誤差恆等於「修剪量」
  （0–50s clip 拖到 in=20,播放器顯示 40s 畫面而不是 20s）。**修法：`TrimPreview`
  加可選欄位 `placeholderHead`**（`plan.ts`）,`Timeline.tsx` 每幀連同 `in`/`leadPad`
  一起寫入（`trimPreviewTarget.current.placeholderHead`）;`planAt` 用
  `stripPlaceholderHead()` 把 `locate()` 的原始 offset 換算成「相對新內容起點」
  的 offset 再傳給 `sourceFor`（只對 trimPreview 指名的目標 clip 做,省略/0＝
  逐位元組不變）。trim-out 不受影響（`trimPreviewTarget` 從不在 trim-out 分支寫入）。
  回歸測試：`plan.test.ts` 新增「(time, trimPreview) 一起餵 planAt」的判別性測試。
- **Important 1（兩個 origDuration 來源分岔）**：`onTrimStart` 改成兩個 edge 都賦值
  `origDuration`（原本只有 trim-in），`dragPlaceholder` 改讀 `d.origDuration`（凍結值）
  取代原本的 `doc.tracks.video.find(...)`（live doc）——三個消費者
  （`trimPreviewTarget.placeholderHead`／捲動補償／`dragPlaceholder`）統一吃同一個
  「手勢起手時凍結」的數字，不再因為拖曳中 AI echo 改到同一支 clip 而分岔。
- **Important 2（本節你正在讀的這句）**：上方 Task 2 小節「`offsetInClip` 不受影響」
  那句已經加了限定詞,指回這裡。
- **Minor 1（吸附導線位置）**：`setSnapLine` 的 in=0 吸附導線改畫在
  `clipStart + placeholder`（佔位右緣＝內容起點），不是 `clipStart`（佔位左緣）。
- **Minor 2（跨方向手勢 scrollLeft 殘留）**：修剪方向補償量恆為 0 時**仍寫回**
  `el.scrollLeft = scrollLeftAtDragStart`，不是完全不碰——先擴張（寫了 scrollLeft）
  再修剪的手勢現在會正確回退，不留擴張階段的殘留值。
- **Minor 3**：`DragState` 的註解更新，反映 `origDuration` 現在兩個 edge 都用、
  trim-out 也有佔位與版面凍結的新現實。
- **Minor 4**：`ClipBlock.tsx` 的 `NARROW_THRESHOLD` 外推判斷改吃內容寬
  （`w - placeholderHeadPx - placeholderTailPx`），不是含佔位的 `w`。
- **Minor 5**：隨 Important 1 修完自然消失（`dragPlaceholder` 現在讀
  `d.origDuration`，不再需要解釋「為何不用它」）。

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
2. 拖 clip 左右邊緣 trim、拖 clip 本體換順序、點 clip 在右欄 Properties 分頁改屬性（點下去會自動跳分頁）、Cmd+Z 復原、左欄 AI 專區的活動記錄。
3. **拖曳手感（階段 4，新）**：在預覽畫布上直接拖動一個 overlay（排名徽章）或一句字幕——吸附到中心線/安全邊距時的靈敏度是否符合直覺？導線出現/消失的時機會不會太早/太晚、會不會抖動？拖到畫布邊緣時元素會不會整個消失不見（設計上應該最多露出一半，見 `dragLayer.ts` 的 clamp 說明）？
4. **打字體感（階段 3）**：在**右上字幕列表雙擊**一句字幕改字（三段式只接在 `CaptionList.tsx`，
   **畫布上不能直接改字**；右欄 Properties 分頁 Inspector 的字幕 Text 欄仍然不走三段式，但**已經不再每一鍵
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
   那是修好了不是回歸。要驗顯式換行仍可在右欄 Properties 分頁 Inspector 的 Text 欄（那是 `<textarea>`，
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
- 退回（reject）目前回滾「review 開啟後的全部變更」到 sinceVersion；若人在審核期間也改了東西會一起被回滾（reject = 丟掉這一輪）。**例外（Plan 8）**：background ingest（A1/A2）用 `updateMediaDerived` 補寫的 proxy/filmstrip/peaks 欄位帶 `excludeFromRevert`，不算這輪要撤銷的編輯意圖，退回後仍存活（見 `server/src/store.ts` 的 `revertSince`）。
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
shared/src/filmstrip.ts   filmstripPlan：filmstrip sprite 取樣計畫純函數（server ingest 組 ffmpeg 參數／UI
                          ClipBlock 換算 background-position 共用同一份算式）——短片逐秒一格，長片單列寬度
                          撞上 JPEG 編碼器 65500px 上限時把格數夾在上限內、改用 <1 的 fps 均勻降頻取樣
shared/src/proxyPlan.ts   proxyPlan：ingest A2（proxy）判準純函數，只吃 probe 靜態欄位；三種結果
                          `skip`（來源已是 web-compatible H.264 短 GOP，不產 proxy）／`remux`（影像合格、
                          只換容器，`-c copy` 不重編碼）／`transcode`（其餘情況，含任何判準欄位缺席或
                          量不出來——保守原則）
shared/src/index.ts       shared 的對外出口（server/ui 都從 @vidcut/shared 匯入）
server/src/store.ts       ProjectStore：唯一真相來源、immer patch、history、undo/redo（真的有 #redoStack）、原子存檔
server/src/chatStore.ts   ChatStore：每專案一份 chat.json（與 project.json 同目錄）的人⇄AI 聊天記錄。
                          **刻意不進 doc/版本/歷史/undo**——聊天是關於編輯的 meta 溝通，不是編輯
                          操作，所以不走 applyCommand（Cmd+Z 不該撤掉一句話）。載入一律容錯
                          （檔案缺失／壞 JSON／形狀不對＝空清單，壞的個別訊息丟掉留好的），
                          落盤照 ProjectStore 的 debounce 500ms + tmp→rename。CHAT_MAX_LEN 由
                          WS 的 sendChatMessage 與 MCP 的 post_chat 共用（兩個入口同一條上限）
server/src/commands.ts    applyCommand：人機共用的驗證過的編輯命令層 ★
server/src/aiWrite.ts     AI 寫入守衛（審核中擋 + ifVersion 過期偵測）→ commands
server/src/reviews.ts     ReviewManager：request_review 的核心（阻塞/核准/退回回滾/逾時）
server/src/editorContext.ts 人的選取/playhead（給 get_editor_context）
server/src/mcp.ts         MCP 工具註冊 + /mcp 掛載（工具清單以本檔為準）；createMcpServer 內把
                          registerTool 換成包裝版，每個 handler 進入/離開（含拋錯，用 finally）
                          發 agentActivity——**只攔執行，工具面逐位元組不變**（snapshot 守著）★
server/src/paths.ts       resolveMediaPath：素材路徑語意（相對＝專案內／絕對＝零複製外部引用）★
server/src/sourceFolder.ts scanSourceFolder：素材夾掃描（白名單副檔名、排除隱藏檔、不遞迴）
server/src/ingest.ts      三階段 ingest（Plan 8，2026-08-20）：**A0**（`prepareMedia`+`registerMedia`，
                          probe＋登記，同步秒級）→**A1**（filmstrip+peaks，一次 `updateMediaDerived`
                          原子落盤）→**A2**（proxy，判準來自 `proxyPlan`：`skip` 來源已是瀏覽器可播
                          的 H.264＝`proxyPath` 永遠不會出現、`remux` 只換容器不重編碼、`transcode`
                          走現行完整參數）。A1/A2 由 `enqueueDerivedStages` 丟進模組級序列背景佇列，
                          `ingestMedia`（人的路徑；MCP `import_media` 不呼叫它，而是自己組
                          `prepareMedia`+`aiWrite`+`enqueueDerivedStages` 以吃到審核鎖——兩條
                          路徑共用的是背景衍生階段那條模組級序列**佇列**，不是這個函式）
                          **回傳時只有 A0** 完成，
                          衍生檔陸續在背景升級；單一素材背景失敗只 console.error＋該素材留在 A0 狀態
                          （不拋、不重試、不拖累其他素材）。需要三階段全部完成才回傳的呼叫端（demo
                          建置、期待衍生檔齊全的測試）改用 `ingestMediaFully`（同步 await 到底，
                          失敗會 throw）。ingestMedia 接受絕對路徑；純音訊素材沒有視訊流，A2 整段
                          跳過、A1 只產 peaks（無 proxyPath/filmstripPath）
server/src/libraryStore.ts  LibraryStore：跨專案素材庫（`~/.vidcut/library/`，`VIDCUT_LIBRARY_DIR` 可覆寫）的
                          唯一真相來源。**獨立於任何專案**——變更不進 undo、不走 Command，全部走
                          `mutate()`（重讀→套用→原子寫 temp+rename）。`library.json` 損毀時 `load()` 丟錯
                          （不是靜默清空，清空等於丟掉整個索引），呼叫端（index.ts）接住降級。
                          `list()` 的 `broken` 欄位是執行期算的（`files/` 缺檔）不落盤——快取會過期。
                          `removeAsset` 刪之前驗 `file` 形狀是 `files/<hash>.<ext>`，防手改壞的索引
                          刪到庫外路徑。不做鎖（多 session 檔案層級最後寫贏，spec 明文取捨）
server/src/libraryIngest.ts `hashFile`（串流 sha256，庫素材可能幾百 MB）、`addToLibrary`（內容定址入庫：
                          hash→去重→複製成 `files/<hash>.<ext>`→生 derived→寫索引，**全有全無**——
                          任一步失敗清掉已落地的 files/derived 再 rethrow；冪等，同 hash 已在庫回既有
                          asset 不重跑 ffmpeg；derived 一律 `transcode` 不走 `proxyPlan`，因為庫檔要能
                          直接靠 `/library/derived` 預覽）、`prepareFromLibrary`（庫素材零複製引用進
                          專案：`MediaAsset.path` 直接指庫內 `files/` 絕對路徑，derived 從庫複製進專案
                          不重跑 ffmpeg；庫 derived 被清過（無 `peaks.json` 這個哨兵）才 lazy 重建；
                          `filmstripTiles` 用 `filmstripPlan` 純函數重算，不必把 tiles 存進庫；寫入
                          `MediaAsset.meta.libraryId`/`meta.libraryHash` 溯源）。與 `ingest.ts` 共用
                          store-free 的 `writeFilmstrip`/`writePeaks`/`writeProxy`（T1 從 ingest.ts 抽出）
server/src/render.ts      project.json → ffmpeg filter_complex 成品 + blur/定格/音訊混音/匯出選項/封面 ★
server/src/publish.ts     發佈包：平台限制警告、文案轉文字、buildPublishPackage（複製成品＋srt＋平台 txt＋manifest；不碰 doc，登記走 setPublish 命令）
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
                          `POST /api/import`（零複製匯入，逐支序列處理）、`POST /assets`（UI 上傳）、`/media/*`、
                          跨專案素材庫五條 `/api/library*`（`extras.library` 未載入時全部 503，見下）＋
                          `/library/files`（immutable 強快取，內容定址）／`/library/derived`（lazy 重建，非 immutable）靜態掛載
server/src/agentActivity.ts AI 工具呼叫的進行中旁路：agentActivityBus（EventEmitter，型態同
                          renderProgressBus）+ 模組級遞增 callId。**不是 Command**——不動 doc、
                          不進版本/歷史/undo。發射點是 mcp.ts 的 registerTool 包裝層
server/src/wsHub.ts       WS：full/patch/command/context/reviewResolve/render/agentActivity/chat
                          ＋ client 的 sendChatMessage（**不走 applyCommand**：聊天不是專案狀態
                          變更。驗證［空白、CHAT_MAX_LEN］寫在這一層不寫在 UI——/ws 是公開介面，
                          UI 的 disabled 只是禮貌。壞訊息靜默丟棄，不送 commandError：那會讓
                          UI 顯示「Edit rejected」，語意完全不對）
server/src/index.ts       startServer + CLI；啟動時 `LibraryStore.load(VIDCUT_LIBRARY_DIR ?? ~/.vidcut/library)`——
                          library.json 損毀（parse 失敗）時**降級**（console.warn + `library` 保持
                          undefined，其餘功能照常），不是整個 server 掛掉
ui/src/theme.css          設計系統實作：token + 原生控件樣式 + 佈局 class ★
ui/DESIGN.md              編輯器設計系統文件（documenter 自成品反推；雙主題 token
                          目錄、named rules、被否決方案的反面清單）。改編輯器 UI
                          之前先讀；landing 歸 site/DESIGN.md，兩者互引不互蓋
ui/src/main.tsx           React 入口（createRoot）
ui/src/App.tsx            版面外殼：3 欄 ×2 列 grid（AI 欄 gridRow 1/3 全高、時間軸
                          gridColumn 2/4 右移）＋header、右欄 Captions⇄Properties 分頁與
                          「選取即跳 Properties」接線、全域鍵盤快捷鍵 handler、伺服器字型
                          @font-face 注入（id 防 StrictMode 雙掛載）、錯誤 Toast、面板收合鈕
ui/src/shortcuts.ts       快捷鍵單一來源表（描述 App.tsx onKey 的實況＋Timeline 的 Ctrl+wheel；
                          Inspector 的 ShortcutHelp 彈出層由它生成——改 handler 必須同步此表）
ui/src/motion.ts          GSAP 進入點（useGSAP + reduced-motion 判斷）
ui/src/stores/            project（patch 套用，含 captionCards）/ playback / selection / view（縮放吸附＋面板收合＋冪等展開 openLeft/openRight）/ activity / toast / editDraft（打字三段式草稿，見下）/ editFx（AI 編輯動畫窗，最後一次變更後 1.6s 收窗）/ agent（見下）/ theme（dark|paper 雙主題：localStorage `vidcutTheme` > prefers-color-scheme；dark 時**移除** html 的 data-theme 屬性以保證預設 DOM 不變，paper 時設 `data-theme="paper"` 觸發 theme.css 覆寫塊；模組載入即套用防首繪閃爍；波形 canvas 色由 timeline/waveform.ts 讀 `--wave-*` token 查表，ClipBlock/AudioChip 的 draw effect 依賴 theme 值故切換即重畫；切換器 2026-08-16 搬上 header＝`ui/src/ThemeToggle.tsx`）
ui/src/stores/agent.ts    AI 存在感的狀態機（零視覺）：進行中工具呼叫集合（callId → tool/startedAt）、
                          三態純函數 agentPhase（offline/idle/working）、最新一筆 currentCall、
                          session 統計 sessionCounts。斷線由 project.setConnected(false) 清空
ui/src/stores/editDraft.ts 打字中的本地字幕草稿（text + previewHash）：不進 history、不碰 doc、不經 sendCommand
ui/src/stores/chat.ts     聊天的 UI 狀態：訊息清單（server 每次送整份）＋輸入草稿＋未讀數。
                          **草稿住 store 不住元件**——離線時輸入框 disabled 但字要留著，而斷線／
                          切分頁都會讓面板重掛。未讀只數「新增的 AI 訊息」且**連上時的第一份
                          記錄不算**（否則重整就頂著假徽章），打開 Chat 分頁即歸零
ui/src/fx/                aiPatches（一輪 AI 編輯的 JSON patch → 哪些光暈/哪些進場/捲到哪，純函數）+ scroll（捲動目標計算）
ui/src/PanelResizer.tsx   左右面板寬度拖曳把手；數學在 ui/src/panelResize.ts（純函數）
ui/src/AgentStrip.tsx     header 的琥珀終端標籤（AI 存在感的視覺面，spec §3.3 + 其
                          2026-08-14 修訂）：讀 stores/agent
                          的三態顯示 NO AGENT／AGENT READY／WORKING+工具名+經過秒數；
                          取代原本 header 的「● Connected/Offline」。經過秒數是元件層
                          setInterval（store 只存 startedAt），只在 working 掛。點擊＝去看
                          活動流：callback 由 App 傳入 + useView.openLeft()（2026-08-16
                          版面重構前是 openRight，活動流那時是右欄的一個分頁）。
                          formatElapsed 是可測的純函數；樣式在 theme.css 的 .ap-strip 區。
                          ⚠️ 大使館的識別是**那隻手（手繪線）不是紙**：暗版載體是
                          code-slate/amber 終端標籤（手繪圈 + 歪框 .ap-frame 過
                          #ap-pencil 濾鏡），**膠帶已移除**（紙的配件）；--ap-paper*/
                          --ap-tape token 保留給階段 ③ 的亮版紙桌面
ui/src/fonts/             紙世界的字型資產（Jost-var.woff2 + OFL 授權全文）。**放 src 不放
                          public**：public 會產出 /fonts/* 靜態路徑，撞 server 的字卡字型
                          /fonts/:id 路由（dev 模式 vite proxy 也整段代理）。theme.css 用
                          相對路徑 @font-face 引用，vite 打包成 hashed asset，不佔路由。
                          Jost 是 variable font（wght 100–900），單檔涵蓋 500–600 兩級
ui/src/ws.ts              WS client：命令/脈絡/審核/渲染 送出 + 重連
ui/src/player/            planAt（純函數大腦）+ Player（A/B 引擎，量 stage 寬算 1080 座標空間縮放係數 + 畫布拖曳事件處理）+ CaptionLayer（見下）+ dragLayer（見下）+ sync（見下）
ui/src/player/sync.ts     播放中媒體元素的時鐘同步策略：小漂移調 playbackRate 追趕（不中斷、無雜音），大漂移（≥0.25s）才硬 seek
ui/src/player/CaptionLayer.tsx 字幕預覽：有字卡 hash 就 <img> 直出（無 karaoke 時與匯出同一張圖），karaoke 疊 hl 卡 + clip-path（與匯出的一詞一卡**不**同源）；沒有 hash／幾何 fetch 失敗／圖檔 onError 才退回 DOM 近似 fallback，幾何 fetch 進行中是 return null（空白一幀，不是近似文字）
ui/src/player/dragLayer.ts dragOverlay/dragCaption：畫布拖曳數學（純函數）——overlay 的 position 錨點不對稱（x=中心、y=上緣），這裡負責錨點↔bbox 左上角的雙向換算，呼叫 shared 的 snapBBox 做實際吸附 ★
ui/src/timeline/          scale（含 zoomBoundsFor 動態上下限、tickStepFor/tickLabel 刻度表）
                          + dragMath（trim/reorder；filmstripBgOffset 已隨 Plan 9 退役刪除）
                          + filmstripTiles（時間對齊逐格渲染數學+windowing，Plan 9 新增）
                          + waveform（純函數）+ Timeline（trim/排序/選取/縮放/吸附/transport/
                          自動 fit 訂閱層）+ Toolbar / ClipBlock（filmstrip 逐格 div 消費端）/
                          AudioChip / usePeaks
ui/src/ThemeToggle.tsx    header 的日夜切換 icon 鈕（暗版給太陽、紙版給月亮＝按下去會去的
                          那一面；aria-pressed=是否紙主題；2026-08-16 自 Shortcuts 彈出層搬上）
ui/src/panels/            Inspector（右欄 Properties 分頁：Canvas fill／選取物件表單／Shortcuts
                          彈出層／閒置提示）/ AgentPanel（見下）/ Activity / Chat（見下）/
                          ReviewBar / ExportMenu / CaptionList（字幕列表）
ui/src/panels/AgentPanel.tsx AI 專區（左欄全高，使用者 2026-08-16 版面定案）：上半 AgentStatus
                          ＝大使館第二件實體的琥珀終端索引卡（三態同 AgentStrip 的
                          agentPhase 推導、RING_PATH 直接 import 共用同一隻手、離線給
                          `claude mcp add …` 接回指令、session 讀數列、最近三筆署名列），
                          下半是 **Chat ⇄ Activity 兩個分頁**（**2026-08-18 改文字型分頁**:
                          `.tab-link` 透明底文字鈕+`.tab-divider` 樣式化豎線,取代 `.seg` 框鈕;
                          右端=收合鈕,從已移除的「AI」頭列搬來,title 不變;右欄維持 .seg,
                          兩欄分頁刻意不同）。**卡不再綁「未選取」**——它以前住在 Inspector 的閒置分支，
                          選了東西就看不到。**2026-08-17 晚間修訂：卡整張住進 Activity 分頁**
                          （固定在分頁內頂部、活動流在下面捲），**Chat 分頁不渲染卡、空間全給
                          對話**——取代同日早上的「恆頂+compact」定案（compact prop 已退役，
                          卡只剩一個落點永遠完整版）。「AI 在不在」不會消失：header 的
                          AgentStrip 恆在且同源三態，卡是第二份
ui/src/panels/Chat.tsx    Chat 分頁：訊息列表＋底部 composer。**2026-08-17 改版**：composer 從
                          單行 input 換成 auto-grow `textarea`（3 行起跳、8 行封頂後內部捲，
                          用 scrollHeight 在 layout effect 量），Enter 送出、**Shift+Enter 真的
                          換行**（多行原樣經 WS/MCP 保存，列表 pre-wrap 照樣呈現）；送出鈕改
                          **圓形 accent 實色主鈕**沉在輸入卡右下（`.chat-send`，對比 13.05 暗／
                          14.14 紙）。**使用者訊息是淺色圓角引用卡**（`.chat-quote`，`--panel-2`）、
                          **AI 訊息維持無框正文**——這是無泡泡定案的**局部修訂**（只有使用者側成卡，
                          理由與稽核判準記在 `ui/DESIGN.md`）。**2026-08-18 再修**:
                          人右/AI 左對齊（引用卡 max-width 85%,alignItems 依 author）;
                          **署名列退場**（同日定案:「不用放 you 或 AI」——對齊+單側卡已說明
                          作者,視覺字樣移除;讀屏靠訊息列 aria-label,--who-* 只剩索引卡/
                          活動流在用）;composer
                          去 `.panel-bar` 分隔線、四周 12px 呼吸邊距不再貼底;composer 與引用卡
                          圓角升為 chat 專屬 14px（全域 --r-card 不動）。
                          新訊息自動捲到底（尊重 `motionOK()`）；離線時 textarea 與送出鈕都
                          disabled 但草稿保留（草稿在 `stores/chat.ts`，見上）
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
server/test/mcp-surface-snapshot.test.ts  MCP 工具面 snapshot 閘門：38 個工具的 name／description／
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
