# T2 #8：逐字稿 + 自動字幕 + 逐詞高亮

目標：`transcribe` / `auto_caption` 兩個 MCP 工具、`CaptionItem.tokens` 資料結構、
渲染端逐詞 karaoke 高亮、UI 字幕列表 view。gap analysis 稱它「ROI 之王」。

## 環境（2026-07-30 實測）

- `whisper-cli` 1.9.1（brew whisper-cpp，MIT，bottle）。逐詞時間戳用 `-ml 1 -sow -oj`
  ——每個 segment 就是一個詞，JSON 帶 `offsets.{from,to}`（毫秒）。
- 模型：`~/.cache/whisper.cpp/ggml-large-v3-turbo-q5_0.bin`（547MB，CJK 品質好）。
  搜尋順序 `$VIDCUT_WHISPER_MODEL` → `~/.cache/whisper.cpp/*.bin` → brew share 目錄。
- whisper-cli 只吃 16kHz 單聲道 WAV，所以要先用 ffmpeg 轉。

## 關鍵決策

1. **時間座標＝時間軸絕對秒數**（不是來源檔秒數）。所以 ASR 吃的是「時間軸混音」，
   產出的 token 時間可以直接當 caption 時間用，不必換算。
2. **ASR 用的混音不重用 `buildRenderArgs`**。目的不同：ASR 要最大可辨識度
   （忽略 `volume`／`ducking`、單聲道 16k），成片要藝術混音。硬要共用會讓
   render 最敏感的那段函式長出一堆 `if (audioOnly)`，且 input 索引會偏移。
   → 獨立小函式 `buildAsrAudioArgs()`，約 30 行，單獨測。
3. **有 tokens 就一律走 PNG 字卡，不用 drawtext**。drawtext 做逐詞要自算每個詞的 x，
   而字卡本來就要量測排版，順手就做完了。
4. **一句話出 N 張字卡**（N = 詞數），時間窗＝相鄰 token 邊界。排版在 Python 端
   確定性計算，所以 N 張圖幾何完全對齊，看起來就是同一張圖在變色。
5. **分頁演算法是純函式**（`shared/src/captions.ts`），因為它是這個功能唯一有主觀
   判斷的地方（何時換頁），必須能單獨測、單獨調。

## 步驟

| #   | 檔案                            | 內容                                                                                                                                                                    |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `shared/src/types.ts`           | `CaptionToken`；`CaptionItem.tokens?`；`CaptionStyle.highlight?`；`updateCaption` patch 加 `tokens`                                                                     |
| 2   | `shared/src/captions.ts` + test | `buildCaptionPages(words, opts, style)`、`activeTokenIndex(cap, t)`。換頁條件：詞間距 > `maxGapMs`、頁長 > `maxDurationMs`、寬度單位 > `maxUnits`（CJK 計 2）、句末標點 |
| 3   | `server/src/asr.ts` + test      | `findWhisperModel()`、`buildAsrAudioArgs()`、`parseWhisperJson()`（純函式好測）、`transcribe()`                                                                         |
| 4   | `server/scripts/text_card.py`   | 接受 `tokens` + `activeIndex` + `highlight`；貪婪換行、逐詞著色                                                                                                         |
| 5   | `server/src/render.ts` + test   | `CaptionCard` 帶 `start`/`end`；`renderCaptionCards()` 一條 caption 出 N 張；`needCards` 條件加上「有 tokens」                                                          |
| 6   | `server/src/mcp.ts`             | `transcribe`、`auto_caption` 工具；`captionSchema` 加 `tokens`/`highlight`                                                                                              |
| 7   | `ui/src/player/Player.tsx`      | 預覽的逐詞高亮（DOM span 著色，幾乎免費）                                                                                                                               |
| 8   | `ui/src/panels/CaptionList.tsx` | 字幕列表：點擊跳播、行內改字、刪除、一鍵套樣式、逐詞開關                                                                                                                |

## 驗收結果

- ✅ `buildCaptionPages` / `normalizeWords` / `activeTokenIndex` 共 22 個測試（含 CJK 寬度、句末標點、停頓換頁）。
- ✅ 字卡幾何穩定性用像素驗證：同一句的 3 張卡 alpha channel **完全相同**，
  高亮像素 0 → 2525 → 6235 單調遞增。這證明「N 張卡看起來像同一張圖在變色」不是推測。
- ✅ 真語音（macOS `say` 產 12.4s）跑完整條鏈：37 詞、時間單調 0.16→12.26、10 句字幕。
  成品逐詞高亮以像素驗證：黃 1130→2141→2562→6174 遞增、白 6047→0 遞減。
- ✅ 整合測試 `asr-integration.test.ts` 真的跑 whisper，缺 whisper／模型／`say` 時自動跳過。
- ✅ 沒有 whisper 時丟 `INSTALL_HINT`（附 brew 與模型下載指令），不是 spawn ENOENT。

## 計畫外的重要修正

原計畫寫「逐詞時間戳用 `-ml 1 -sow`」——**實測是錯的**，改用 `-ojf` 的 token 層 `t_dtw`。
三個實測發現記在 [`HANDOFF.md`](../../../HANDOFF.md) 的「踩過的坑」：segment offsets 尾段整批退化、
最後一詞會拿到 30 秒、DTW 與 flash attention 互斥且會靜默停用。
