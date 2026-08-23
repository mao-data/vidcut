# vidcut 上線計劃與可行方向

> **這是前瞻型文件**：描述「可能要做的事」，引用的檔案路徑可能還不存在。
> 描述「現況」的是 `CLAUDE.md`、`.claude/rules/`、`HANDOFF.md`、`README.md` 與 `README.zh-TW.md`——
> 那幾份的引用由 `scripts/docs-check.mjs` 保證指向真實存在的東西，本檔不納入該檢查。

最後更新 2026-08-07。現況與已驗證範圍見 `HANDOFF.md`；各項設計定案見 `docs/superpowers/specs/`。

## 進行中

### 素材匯入：零複製引用 + 素材庫

設計定案：`docs/superpowers/specs/2026-08-03-media-import-design.md`

| 階段 | 內容                                                                                                                                                   | 狀態                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| 1    | `resolveMediaPath` 路徑語意、`scanSourceFolder`、`GET /api/source`、ingest 接受外部絕對路徑、`addClip` command、`POST /api/import`、MCP `import_media` | ✅ `main` + `list_source`、`add_clip` 補完 |
| 2    | 右側面板新增 `Media` 分頁：素材夾掃描 → 勾選匯入 → 已匯入清單 → 加到時間軸                                                                             | 待實作                                     |

後端零複製能力 + MCP 工具已全部上線；MCP 面原先階段 1 完成時仍有空白（`import_media` 掛、`add_clip` 缺），現已補完。

### 字幕能力補完（源自 FreeCut 調研，2026-08-04）

調研對象：[walterlow/freecut](https://github.com/walterlow/freecut)（MIT，瀏覽器內 NLE）。
五項裡「字幕匯出」已完成，其餘排期如下。**抄程式碼要保留 MIT 版權聲明。**
第 6 項不是來自 FreeCut 調研，是 2026-08-05 使用實測時發現的缺口。

| #   | 項目                                     | 狀態    | 估時   | 備註                                                                                                     |
| --- | ---------------------------------------- | ------- | ------ | -------------------------------------------------------------------------------------------------------- |
| 1   | **SRT/VTT 匯出（sidecar + soft track）** | ✅ 完成 | 半天   | `render` 新增 `subtitles: 'burn'\|'off'\|'sidecar'\|'embed'`，預設 `burn` 維持現有行為                   |
| 2   | 字幕樣式 preset（5 組）                  | 待實作  | 1–2 天 | 見下                                                                                                     |
| 3   | typewriter 逐字揭示                      | 待實作  | 半天   | 見下                                                                                                     |
| 4   | word 單位的 in/out 文字動畫              | 待實作  | 2–3 天 | 見下                                                                                                     |
| 5   | SRT/VTT 匯入 + 內嵌軌抽取                | 待實作  | 2–3 天 | ⚠️ 必須與「字幕錨定 clip」綁在一起，見下                                                                 |
| 6   | **UI 手動新增字幕**                      | 待實作  | 半天   | 唯一一個 UI 完全沒有入口的字幕操作；需求細節未定案，見下                                                 |
| —   | ~~自寫 MKV EBML parser~~                 | 不做    | —      | FreeCut 手刻 548 行是因為瀏覽器沒有 ffmpeg；我們有，用 `ffprobe -select_streams s` + `ffmpeg -map 0:s:0` |
| —   | ~~per-character 真動畫~~                 | 暫緩    | —      | Pillow 預烤 PNG 下等於每格重新光柵化；ffmpeg 端一句 12 字＝12 路濾鏡鏈會爆。等渲染路徑換掉再說           |

#### 2. 字幕樣式 preset

FreeCut 的 `layout` 存**比例**（`fontSizeRatio`/`yRatio`）是為了多解析度；vidcut 固定
1080×1920，直接存絕對值即可。真正值錢的是那 5 組數值本身 —— 換算到 1920 高之後：

| preset      | fontSize | y    | 描邊     | 其他                                   |
| ----------- | -------- | ---- | -------- | -------------------------------------- |
| TikTok      | **144**  | 置中 | 2px 黑   | Anton、letterSpacing 1、陰影 blur 8    |
| Bold Yellow | **96**   | 0.38 | 1.5px 黑 | `#FFD400`、Roboto Slab bold            |
| YouTube     | **86**   | 0.34 | 無       | 純陰影 blur 14、Roboto medium          |
| Netflix     | **77**   | 0.36 | 無       | 半透明黑底 `rgba(0,0,0,.55)`、radius 4 |
| Outlined    | **77**   | 0.34 | 1px 黑   | 無陰影、Manrope                        |

**注意目前的 `DEFAULT_CAPTION_STYLE.fontSize = 64` 比這五組都小** —— 1080 寬、64px 在手機上
偏秀氣，TikTok 那組的 144px 才是短影音的實際尺度。這個發現本身可能比 preset 功能還有價值。

落地成本不是零：`CaptionStyle` 目前只有 `fontFamily/fontSize/fill/stroke/y/highlight`，
上表要完整落地得先擴 `text_card.py` 的參數面 —— `strokeWidth`（現在的 `stroke` 只有顏色）、
`textShadow`、`backgroundColor`+`radius`、`letterSpacing`。**建議分兩步**：先加前三個
（涵蓋五組裡四組），preset 表放 `shared/src/captionPresets.ts`，MCP 加
`set_caption_style({ preset })`；`letterSpacing` 留最後。
順帶抄 `detectActiveCaptionPreset()`（反向比對目前樣式來高亮 UI 上作用中的 chip）。

#### 3. typewriter 逐字揭示

FreeCut 的 typewriter preset 根本不是動畫：`channels: (p) => ({ alpha: p >= 1 ? 1 : 0 })`，
就是「第 N 個字在第 N×stagger 幀出現」。**這跟既有的 karaoke clip-path 是同一個機制** ——
預覽端把 `karaokeClip()` 的 active index 從「唸到第幾個詞」換成「時間到第幾個字」即可；
匯出端已有「一詞一卡」，改逐字同理。幾乎零成本，先做這個。

#### 4. word 單位的 in/out 文字動畫

**抄架構，不抄實作。** FreeCut 的 `text-motion/evaluate.ts` 精華是：motion 是
clip-relative frame 的**確定性純函數**（無狀態、無烘焙關鍵影格），所以預覽/拖動/匯出
「由建構保證一致」。這對 vidcut 特別重要 —— `verify:wysiwyg` 剛把「預覽=成品」釘住，
動畫若引入任何狀態或烘焙，那個性質立刻破功。

要抄的規則：

- preset = 10 行內的純函數 `(easedP, ctx) => Partial<MotionState>`。
- 位移用 `fontSize` 倍數（`dy: (1-p) * 0.25 * fontSize * intensity`）→ 任何字級看起來一樣。
- in/out 窗口超過 clip 一半就**整體等比壓縮**，不是截斷（短句上的長 stagger 會擠不會斷尾）。
- out 永遠贏：落在 out 窗口內的 frame 只算 out，in 視為已定格（clamp，never glitch）。
- random 順序用 mulberry32 確定性 PRNG + memo（每格每字都算，O(n) shuffle 會變 O(n²)）。

**不能抄的**：FreeCut 把狀態餵進 GPU glyph atlas，per-glyph 每格算。我們是 Pillow 預烤 PNG。
可行降級：把狀態降成「整張卡的 dx/dy/scale/alpha」，複用既有的一詞一卡機制，用 ffmpeg
overlay 時間表達式（`x='...'` / `colorchannelmixer=aa='...'`）。`fade-up`/`rise`/`pop`/
`fade-down`/`sink` 五個 word 單位的 preset 全部可行 —— 80% 體感、20% 工。

#### 5. SRT/VTT 匯入 + 內嵌軌抽取

`shared/utils/subtitles.ts` 的 parser 是 180 行零依賴純函數（BOM、`\r\n`、時數可省略、
`,`/`.` 兩種毫秒分隔、VTT 的 `NOTE`/`STYLE`/`REGION` 跳過、壞掉的 block 收進 `warnings[]`
而不是整批失敗），**可以直接抄**。`SubtitleCue{id,startSeconds,endSeconds,text}` 跟
`CaptionItem` 只差 `duration = end - start`。

內嵌軌用 ffmpeg，不要抄 EBML parser：

```bash
ffprobe -v error -select_streams s \
  -show_entries stream=index,codec_name:stream_tags=language,title -of json in.mkv
ffmpeg -i in.mkv -map 0:s:0 -c:s srt out.srt
```

快取沿用 FreeCut 的做法：**fileSize + mtime 當指紋**寫 sidecar JSON，避免每次重掃
（3GB MKV 掃一次 20–30 秒）。

**⚠️ 這項有一筆帳要先付，所以不能單獨排。** 匯入的 SRT 是**素材時間**，
`CaptionItem.start` 是**時間軸絕對秒**，要算 `timelineStart = clip.start + (cue.start - clip.in)`
並裁掉落在 trim 範圍外的 cue。vidcut 目前**沒有 source↔timeline 換算層**（`auto_caption`
吃的是時間軸混音，當初刻意省掉的）。同一筆帳也是「字幕跟隨剪輯」缺口的成因 ——
現在 `timeline_op split`/`deleteBefore` 之後字幕**不會跟著動**。兩件事綁在一起做：
給 `CaptionItem` 加 `anchor?: {clipId, offset}`（比照 `OverlayItem.anchor`），
渲染前把錨定解析成絕對時間。

ASS inline markup（`subtitle-cue-format.ts`）只取一半：剝掉標記 + 認 `{\anN}` 換算成
`style.y`（`{\an8}` → y≈0.05）。per-run 粗斜體要改 `text_card.py`，等真的需要再說。

#### 6. UI 手動新增字幕

**發現經過（2026-08-05）**：使用者按時間軸工具列的「Text」鈕，以為會加字幕，實際拿到的是
**文字 overlay**（`Toolbar.tsx` 送的是 `addOverlay` 帶 `text`，tooltip 也寫著 "Add a text
overlay at playhead"）。這是階段 2 的預期行為、不是 bug，但因此暴露了一個真缺口。

**字幕目前只有兩個來源**：`auto_caption`（whisper 辨識）或 MCP `set_captions`。
**UI 上完全沒有辦法手動加一句字幕。**

編輯面其實已經很完整，缺的只有「新增」與「拆/合」：

| 在哪                | 已經能做                                                                   |
| ------------------- | -------------------------------------------------------------------------- |
| 字幕列表面板        | 雙擊改字（打字三段式即時預覽）、刪除、點時間跳播、樣式套全部、關掉 karaoke |
| Inspector（選取時） | 改文字、`start`、`duration`、字級/顏色/`y`                                 |
| 時間軸 captions 軌  | 拖曳平移、左右緣 trim                                                      |
| 預覽畫布            | 直接拖字幕高度（改 `style.y`）                                             |

| 做不到     | 缺什麼                                                                 |
| ---------- | ---------------------------------------------------------------------- |
| 新增一句   | UI 沒入口；`Command` 沒有 `addCaption`（只有整組覆蓋的 `setCaptions`） |
| 一句拆兩句 | 沒有 `splitCaption`                                                    |
| 兩句合一句 | 沒有 `mergeCaptions`                                                   |

**影響**：沒有語音的影片（例如純 BGM 的排名片）想要「字幕樣式的文字」時，只能改用
Text 鈕做 overlay —— 於是失去 SRT 匯出（匯出只讀 `tracks.captions`）與逐詞高亮。

**需求未定案，開工前要先確認的問題**：

1. 新增那一句的**時長**怎麼決定？固定 2 秒（比照 Text 鈕的固定 3 秒，最簡單）／自動填到
   下一句字幕開始／用時間軸選取範圍（但時間軸目前沒有「範圍選取」這個概念，要另外做）。
2. 只做「新增」，還是連「拆/合」一起做？（拆/合是 ASR 斷句不理想時的主要修法，
   `buildCaptionPages` 的 `maxGapMs`/`maxUnits` 調不動個別句子。）
3. 入口放哪？字幕列表面板加「＋」／工具列再加一顆 `Caption` 鈕／把 Text 鈕改成下拉二選一。
   最後一個會動到既有行為，前兩個是純新增。

**實作面**：無論選哪個，都要在 `shared` 的 `Command` 加 variant + `commands.ts` 加驗證與
case（鐵則：UI 與 MCP 自動都能用）。`addCaption` 要走 `validateCaptionCard` 的像素預算檢查，
跟 `setCaptions` 一致。

## 可行方向（尚未排程）

依「有實測或程式碼佐證」排序，前面幾項是已經量過或讀過程式碼確認的。

### 1. Proxy 參數可設定

⚠️ 2026-08-20（Plan 8 快速 ingest）之後，`transcode` 分支才會走到 `scale=-2:960`——
`proxyPlan`（`shared/src/proxyPlan.ts`）會先判斷來源，已是瀏覽器可播的 H.264（`skip`）
就完全不產 proxy，容器不對但影像層面合格（`remux`）只秒級換封裝不重編碼，只有真的需要
重編碼（HEVC、10-bit、解析度超標、GOP 過長…）才落到 `transcode` 這個寫死 960 的分支。
舊的「實測 60s 1080p ingest 約 8.5 秒」數字是**改前的整段同步耗時**，現在 proxy 是背景
A2 階段、不擋 A0 回傳，這個數字不再代表使用者的等待時間（見下一項）。讓 proxy 高度可設定
（例如 540 供快速預覽、720 供精修）本身仍未做，只影響會落到 `transcode` 的那些來源。
**輸出不受影響** —— render 走 `media.path` 原檔，只有封面截圖會退回 proxy。

### 2. ingest 進度與取消

⚠️ 2026-08-20（Plan 8）把 ingest 拆成三階段：**A0**（probe+登記，同步、秒級，`ingestMedia`
回傳的時點）→**A1**（filmstrip+peaks）→**A2**（proxy，可能被 `proxyPlan` 判定整段跳過）。
A1/A2 丟進背景佇列、不擋 A0 回傳——素材在 A0 完成後就可預覽、剪接、`render`，不再是「一支
10 分鐘 1080p 等 85 秒」的單一黑箱等待。**仍未做的是**：背景階段（A1/A2）本身沒有進度回報
與取消——使用者不知道 proxy/filmstrip 何時就緒，也無法中途取消單一素材的背景升級；
UI 目前的因應是容忍衍生欄位缺席（見 HANDOFF.md ingest 節、Plan 8 Task 4）。

### 3. 離線素材重新連結（relink）

零複製後，原檔被移動會讓輸出失敗（預覽仍可用，proxy 在專案內）。
Premiere 與 CapCut 都有 relink UI，這是引用式架構的標準配套。

### 4. 專案打包／搬移

等同 Premiere Ingest Settings 的 Copy 模式：把外部引用的原檔複製進專案資料夾，
讓專案可整包搬到別台機器。與零複製並存、由使用者選擇。

### 5. 上傳路徑串流化

只影響 overlay 上傳（`POST /assets`，目前 `express.raw` 上限 20MB）。
本機實測 300MB 檔案：現況 `arrayBuffer()` + `express.raw` 讓瀏覽器 peak heap 301MB、
Node peak RSS 297MB、耗時 919ms；改成 `body: file` + `req.pipe` 後為 1MB / +22MB / 261ms。
改動只有兩行（client 拿掉 `arrayBuffer()`、server 換成 `pipeline`）。
**注意**：`ReadableStream` 上傳那條路走不通 —— Chrome 要求 HTTPS + HTTP/2，
而 vidcut 是 `http://127.0.0.1` 的 HTTP/1.1，Firefox/Safari 也未支援。直接丟 `File` 就夠。

### 6. 素材夾體驗

路徑持久化與最近使用清單、遞迴掃描子目錄、素材縮圖與 scrub 預覽。
刻意留到有實際使用回饋再做。

### 7. e2e 檢查擴充

`ui/e2e/panel-affordance.mjs` 涵蓋面板收合/展開控制項（12 項斷言、4 種視窗尺寸）；
`ui/e2e/canvas-direct.mjs`（`npm run verify:canvas`，字幕 WYSIWYG Task 16 新增）涵蓋
預覽畫布的 1080 空間縮放正確性、overlay/字幕直接拖曳、吸附導線——這部分**已完成**，
不再是待辦。同樣的手法（真瀏覽器命中測試 + CDP 合成 pointer 事件）仍可延伸到**時間軸**
本身的拖曳（trim/排序/縮放吸附）與字幕列表面板的雙擊改字 —— jsdom 量不出被遮擋、
捲動裁切，也沒有真的 pointer capture 可以測拖曳。

### 8. MCP elicitation URL mode

`request_review` 目前是「阻塞 + UI 核准 + 保活 + 逾時」。
讓 Claude Code 直接彈出瀏覽器審核頁需要 v2 SDK 遷移，因無法自動驗證而擱置（見 `HANDOFF.md`）。

### 9. 音訊素材支援（大半已完成）

**匯入這半已經通了**：`main` 的 `ecc5e0f` 放寬 `probe`（無視訊串流不再丟錯）、
純音訊跳過 proxy/filmstrip 只產 peaks；合併後素材夾裡的 `.mp3/.m4a/.wav/.aac`
可以被 `GET /api/source` 列出、`POST /api/import` 零複製匯入
（`import-api.test.ts` 的兩條端到端測試守著）。

**MCP 那條也已經通了**：`import_media`（吃絕對路徑）→ `set_audio`（schema 本來就吃
`mediaId`）→ `render`，實測可產出含 BGM 的成品。缺的只有 `POST /api/import` 帶
`addToTimeline: true` 時的分流——目前它一律呼叫 `addClip`（只上視訊軌且擋 audio-only），
所以匯入 BGM 會進 `failed[]`（素材其實已匯入）。可行方向：新增 `addAudio` command
（`{ mediaId, start, in, duration }` → append 到 `tracks.audio`），`/api/import` 依
`probe.hasVideo` 分流到 `addClip` 或 `addAudio`。這是產品決策，待定。

### 10. Origin／Host header 檢查

Server 綁 `127.0.0.1`（`index.ts:36` 已確認），但沒有 Origin／Host header 檢查。
DNS rebinding 攻擊下，惡意網頁可誘使受害者瀏覽器對 `127.0.0.1:3845` 發請求，
`GET /api/source?dir=…` 會給攻擊頁面**任意目錄列舉**能力——這是「素材匯入」分支
新增的能力面（先前只有 `/api/project` 洩漏專案內路徑，範圍小得多）。根目錄白名單
已核准不做（見 spec 的 YAGNI 段），但 Host header 檢查（拒絕 Host 不是
`127.0.0.1:<port>` 或 `localhost:<port>` 的請求）是最便宜的等效防護，不需要額外設定。

### 11. 素材匯入／MCP 面補完兩個分支留下的已知缺口

TDD 期間逐條記錄、經裁決延後的項目。SDD 過程檔不隨分支保留，所以這裡就是這些項目的
唯一落盤處——每條都寫到「拿起來就能做」的程度。

**素材匯入分支：**

- **`updateClip` 與 `updateAudio` 的 `1e-6` 容差無 mutant 覆蓋**——與 `addClip` 同形，但只有 `addClip` 那處有 `addclip-bounds` 守著。補兩隻 mutant 即可，屬小 Task。
- **`GET /api/source` 的「素材夾無權限」分支無專屬測資**——與「目錄不存在」共用同一條
  catch，行為正確但沒有獨立驗證。
- **`POST /api/import` 的 `failed[].error` 可能夾帶絕對路徑**——與既有 `/api/source`
  的錯誤格式一致，非新增問題，但若日後要對外開放需一併處理。
- **無全域 ffmpeg 佇列**——「逐支序列」只在單一 `/api/import` 請求內成立（由
  `import-api.test.ts` 的 `maxInFlight===1` 守著）；兩個併發請求、或 import 與
  `render`／`transcribe` 併行時不成立。
- **`scanSourceFolder` 逐檔序列 `await stat`**——上萬檔的素材夾會慢，目前規模無影響。

**MCP 面補完分支（最終全分支審查發現，經裁決不擋合併）：**

- ~~**`setAudio` 只驗了 `mediaId`／`duration`／`in`**~~ ——**已由 `main` 的 MCP 稽核 F 批補完**。
  規則抽成 `audioRuleError(a, media)`，`setAudio` 與 `updateAudio` 共用同一份，涵蓋
  `start >= 0`、`in >= 0`、`duration > 0`、`volume` 在 0..2、`fadeIn`/`fadeOut` 在
  0..duration，以及 `in+duration` 不超過素材長度。當初擔心的具體後果（負 `start` 落盤 →
  render 不生成 `adelay` → 音訊被靜默放到 0 秒）已不可能發生。
  **但 `start >= 0` 這條規則沒有任何測試釘住**（`grep 'start must be >= 0' server/test`
  零命中）——`setaudio-validate` 這隻 mutant 整段拿掉驗證迴圈時，殺掉它的是「mediaId
  不存在」那條斷言，不是負 start。補一條測試即可，屬小 Task。
- **`mutants.json` 的 find 字串會被重構打斷，而且曾經無人察覺**——一次修好五隻
  （`render-aspect`／`mcp-writereply-always-err`／`setaudio-validate`／`tl-anchor-offset`／
  `inspector-deselect`），全是 main 正當重構後 `mutants.json` 沒跟上。已加
  `node scripts/mutate.mjs --check` 錨點關卡（秒級、`--fast` 也會跑），並修掉
  `gauntlet.sh` 兩個自身缺陷：突變關卡的 `tail -3` 會截斷失敗清單（五隻壞的只印三隻）、
  以及同一關卡被跑兩次。**日後改動 mutant 目標所在的程式碼時，請一併更新 `find`**——
  錨點關卡會當場擋下來，不會再靜默失效。
- **`add_clip` 的 AC12（審核進行中）可以有 mutant，本輪誤判為做不到**——`mutants.json`
  加一筆，`find` 是 `mcp.ts` 裡的 `const r = aiWrite(store, cmd, ifVersion);`，`replace`
  寫成 `const r = (await import('./commands.js')).applyCommand(store, 'ai', cmd);`。審查者
  已實跑驗證：只有 AC12／AC13 轉紅，快樂路徑維持綠，歸因正確。加完要重跑完整 gauntlet
  更新 EVIDENCE 的突變數字（70 → 71）。
- **`add_clip` 的 AC9／AC11 是假綠**——`mcp-tools.test.ts` 只斷言「回 `isError`」，而 MCP
  SDK 在**工具不存在**時同樣回 `isError`，所以把 `add_clip` 改名後兩條照樣通過。照
  `list_source` 目錄不存在那條的做法補上訊息內容斷言（例如斷言訊息含 `media not found`
  ／`out of bounds`）即可。
- ~~**instructions 同步守衛測試沒有真的呼叫 `listTools()`**~~ ——**已修**（commit `09a4bb2`
  「工具面完整性守衛取代硬編的假守衛（ROADMAP I-5）」＋ `fc4d60f`）。舊守衛
  （`mcp-tools.test.ts` 的 `describe('instructions 與工具清單同步')`）硬編 6 個工具名做
  `toContain`，工具真的沒註冊時照樣綠；`09a4bb2` 把它整段刪掉，換成
  `server/test/mcp-docs-sync.test.ts`，四條測試全部先 `await client.listTools()` 再比對：
  「每個註冊的工具都出現在 instructions 裡，或有明列的豁免理由」（`INSTRUCTIONS_EXEMPT`
  要求寫下理由）、「豁免清單不得列入不存在的工具」、「instructions 提到的工具名都真的
  註冊了」（反方向，防描述留著實作已移除）、以及 `fc4d60f` 補的
  `describe('Command variant 都能從 MCP 觸達')`——**那條才是鐵則第三步的直接守衛**：
  拿 `shared/src/types.ts` 的 `Command` 聯集對 `listTools()` 取差集，漏 `registerTool`
  就轉紅（`MCP_EXEMPT_COMMANDS` 列出五個由 `timeline_op`／`import_media` 間接觸達的）。
  查證：`npx vitest run --root server test/mcp-docs-sync.test.ts` → **6 passed**。
- ~~**測試會洩漏暫存目錄**~~ ——**已修**（產品面與測試面兩半都修完）。原問題：
  `server/test` 有 91 個 `mkdtemp` 呼叫但只有 15 處 `rm`，而且多數 `mkdtemp` 藏在
  每條測試都會呼叫一次的 helper 裡（`commands.test.ts` 只寫 3 個 `mkdtemp` 卻產出
  4,291 個目錄），所以 `afterAll` 時根本沒有東西可以刪。修法是 `test/tmp.ts` 的
  `tmpDir()` 把目錄建在「本輪測試根目錄」底下（`test/global-setup.ts` 建立），整輪跑完
  由 teardown 一次刪掉；有測試失敗就整輪保留（出事現場），`VIDCUT_KEEP_TMP=1` 可無條件
  保留。清理**必須**放在 globalSetup 的 teardown 而非各檔的 afterAll——`ProjectStore`
  落盤是 debounce 500ms 的射後不理，測試檔剛結束時常有存檔還在路上，afterAll 立刻刪會
  撞出 `ENOENT: rename '.project.json.tmp'`（第一版就是這樣被隨機順序關卡抓到的）。
  實測同一套測試（合併 main 之後、439 條）：不清理會留下 266 個目錄／125MB，清理生效後
  0 個。全分支共轉換 100 個 mkdtemp 呼叫點，四隻 mutant 守著。
- **`mcp-tools.test.ts` 有一條套套邏輯斷言**（在 `describe('add_clip')` 的
  「接到主軌尾端，回新 clip 的 id」那條裡）——
  `expect(sc.clipId).toBe(store.doc.tracks.video.at(-1)!.id)` 兩邊用同一個 `.at(-1)` 讀
  同一份狀態，恆真。審查者把 `push` 改成 `unshift` 實測，真正轉紅的是鄰行的 `label`
  斷言（那條才是獨立 oracle）。功能上無漏洞，但這條斷言證明不了它宣稱的「回傳的 id
  就是新 clip 的 id」。改法：把預期 id 在呼叫前先算好或改用 label／長度等獨立 oracle。

**文件稽核（2026-08-07，見 `docs/DOC-AUDIT-2026-08-07.md`）發現，但要動到程式碼、
不在「只動文件」的稽核範圍內：**

- ~~**`ui/e2e/panel-affordance.mjs` 檔頭寫「前置：`npm run demo`」**~~ ——**已修**
  （Task 8，2026-08-07）。原本與 `CLAUDE.md`／`.claude/rules/ui-verification.md`
  「**不要**用 `npm run demo` 當 verify 的前置（它會重新產生 `projects/demo`、覆蓋既有
  內容）」直接矛盾。**兩處**都改成姊妹腳本 `ui/e2e/canvas-direct.mjs` 的寫法：檔頭註解
  改為「`npm run build -w @vidcut/ui` 是最新的 + `npx tsx server/src/index.ts projects/demo`」
  並明寫不要用 `npm run demo`；`main()` 裡連不上時的 `console.error` 提示也一併改掉
  （原本是「先跑 npm run demo」，等於在失敗當下再教人覆蓋一次 demo）。
  只動了這兩處字串，沒有動任何斷言或流程；`node --check` 通過，`npm run lint`／
  `npm run format:check` 維持乾淨。**這條沒有自動關卡守著**——`scripts/docs-check.mjs`
  檢查的是斷言型文件裡的反引號路徑，不是原始碼註解裡的前置條件。
- **`ui/src/player/Player.tsx` 的註解引用「`CLAUDE.md`「UI 驗證的陷阱」」**，但 `CLAUDE.md`
  已經沒有這一節——`<img draggable>` 那條記錄現在在 `.claude/rules/ui-verification.md`。
  把交叉參考改指新位置即可，屬小 Task。（`scripts/docs-check.mjs` 抓不到這種：它檢查的是
  斷言型文件裡的反引號路徑，不是原始碼註解裡的章節名。）
- **`server/scripts/text_card.py:170-171` 的 `wrap_text` docstring 已過期**：寫著
  「行數 ≤ max(1, 段落內字元數)。`server/src/cardBudget.ts` 的預算估算**就是靠這條**」，
  但 `cardBudget.ts` 的 `maxWrappedLines()` 現在取「字元數上界」與 `greedyLineBound()`
  前進寬上界**兩者的 min**（正是把 1080 寬 / fontSize 64 上限從 146 字放寬到 369 字的
  那次改動）。字元數上界仍然成立，錯的是「就是靠這條」這個唯一性宣稱。改法：把那句改成
  「這是 `cardBudget.ts` 兩個上界之一（另一個是前進寬上界）」。同檔 `:120`
  （`split_atoms` 的「原子數 ≤ 字元數，這是 cardBudget.ts 上界估算的依據」）同理，可一併看。

- **`setOverlays` 的驗證比 `addOverlay` 鬆四條，寫壞的 overlay 會靜默落盤**（Task 6 的
  MCP 工具描述稽核發現）。`commands.ts` 的 `setOverlays()` 只跑
  `validateOverlayTextCard`，而 `addOverlay()` 另外驗了四件事，整組替換這條路
  全都沒有：①「既無 `start` 也無 `anchor`」②「`anchor.clipId` 指向不存在的片段」
  ③「`duration <= 0`」④「同一批裡 `id` 重複」。實測（對空專案直接呼叫 `applyCommand`）
  四種全部回 `{"ok":true}` 並寫進文件，重複 id 那次 overlay 軌真的變成
  `["dup","dup"]`；同樣四個 overlay 送 `addOverlay` 則分別被
  `overlay needs start or anchor`／`anchor clip not found: ghost`／
  `overlay duration must be > 0 or null` 擋下。後果是 `overlayWindow()` 對這些回 `null`
  ＝**預覽與成品都不顯示，而工具回的是成功**，使用者只會發現「有幾張圖不見了」。
  修法：把 `addOverlay` 那四條抽成一個 `overlayRuleError(o, doc)`，`setOverlays` 逐項套用
  並沿用「任一項不合格就整批拒絕」的既有立場（與 `setCaptions`／`setAudio` 一致）。
  ⚠️ 這會讓現在能過的呼叫變成不能過，屬行為變更，所以 Task 6（只動文件）沒有動它——
  目前是在 `set_overlays` 的工具描述裡明說「這四條在整組替換這條路上不會被擋下來」。
  修掉之後記得把那句描述一併改掉。
  **順手改掉 `setOverlays()` 上方那段 doc 註解**——它寫著 `setOverlays`「跟
  `addOverlay`/`updateOverlay` 用同一套規則，**不因為是『整組替換』就放寬**」。第一句雖已
  把範圍限定在 text/imagePath，第二句仍會讓維護者相信上面這個缺口不存在（本 Task 只動
  文件，沒有動產品程式碼裡的註解，所以留到這裡一併處理）。

- **`get_frame` 標了 `annotations.readOnlyHint: true`，但它會寫檔**（同上，Task 6 發現）。
  `frame.ts` 的 `extractFrame()` 會 `mkdir` 並跑一次 ffmpeg 寫出
  `derived/frames/t<時間>.jpg`（:30-34，而且沒有快取查詢，每次呼叫都重抽）。MCP 的
  `readOnlyHint` 語意是「不修改其環境」，host 會拿它來免權限提示。同一個檔案裡
  `transcribe` **刻意不標**這個 hint，理由就寫在它 `annotations` 上方的註解（「『不改專案狀態』不等於
  『便宜且無副作用』」）——兩者標準不一致。`get_frame` 確實便宜（單幀），所以這比較像
  「要不要把 hint 的語意定義成『不改專案狀態』」的一次裁決，不是明確的 bug。
  裁決之後兩邊要一致：若維持現狀，就在 `transcribe` 那段註解補一句說明兩者的分界；
  若收緊，就把 `get_frame` 的 hint 拿掉。改 annotations 會改變 host 的權限提示行為，
  屬行為變更，故 Task 6 未動。

- **`render` 工具在 burn 模式下的 `note` 是假診斷**（Task 7 實測、Task 8 補完判定）。
  `mcp.ts` 的 render handler 在 `mode === 'burn' && !res.captionsBurned` 時附上
  `' (captions not burned: no text cards were produced — is python3/Pillow available?)'`。
  **但那句提到的兩個成因都不可能走到這裡**：
  - python3/Pillow 不在 → `renderCaptionCard()` 的 `spawn('python3', …)` 丟 ENOENT；
  - 字型候選鏈全滅（`text_card.py` 的 `load_font` fallback）→ `fontFallbackError()` reject。
    兩者都經 `render.ts` 的 `mapLimit`（任一項 reject 就整體 reject）讓 `render()` 整個
    失敗，被 `mcp.ts` render handler 的 catch 接住回 `render failed: …`。Task 7 已實測
    第一條：把 `python3` 移出 `PATH`（保留 ffmpeg/ffprobe）、專案有字幕、`subtitles:'burn'`
    → `render()` 直接 reject `spawn python3 ENOENT`，不是回傳 `captionsBurned:false`。

  **這個分支不是死碼，但唯一可達的情境不是它說的那個。** 判定依據（讀 `render.ts`）：
  `render()` 只在 `captions.length > 0 && subtitleMode === 'burn'` 時才填 `captionCards`，
  而 `renderCaptionCards()` 對每條 caption 至少回一張卡（無 tokens 回 1 張、有 tokens 回
  `tokens.length` 張），所以 `captionCards` 是空的 ⟺ **字幕軌是空的**；
  `buildRenderArgs` 的 `useCards = burnCaptions && captionCards.length > 0` 於是為 false。
  也就是說：**burn 模式下 `captionsBurned === false` ⟺ 專案根本沒有字幕**，而使用者拿到的
  提示卻是「是不是 python3/Pillow 沒裝」。
  `server/test/render-subtitles.test.ts` 裡所有 `captionsBurned` 為 false 的斷言都是
  `off`／`sidecar`／`embed` 模式，**沒有任何測試釘住 burn + 空字幕軌這條**。
  修法：把那句改成「專案沒有字幕可燒」之類的實話（或在真的沒字幕時乾脆不附 note）。
  ⚠️ `note` 是回給 AI 的執行期輸出，改它屬行為變更，故 Task 8（只動文件）未動——
  只把 `mcp.ts` 那段**程式碼註解**改成上面的正確描述，留下這條給專案擁有者裁決。

- **`MCP_EXEMPT_COMMANDS` 的豁免理由是自由文字，沒有任何測試驗證它是真的**（文件與
  MCP 一致性稽核分支的全分支審查發現，實測破壞驗證）。`server/test/mcp-docs-sync.test.ts`
  「Command variant 都能從 MCP 觸達」那組測試只驗證 `MCP_EXEMPT_COMMANDS` 的 key 對得上
  現存的 `Command['name']`，不驗證理由裡講的聚合工具（`timeline_op`／`import_media`）
  實際上真的把那個 op 接上了。24 個 Command variant 裡 5 個（21%：`splitAt`／
  `deleteBefore`／`deleteAfter`／`freezeFrame`／`registerMedia`）落在這個盲區。
  **實測破壞**：把 `'deleteBefore'` 從 `timeline_op` 的 `z.enum` 與 handler 三元式整條
  移除（＝該 op 從 MCP 永久觸達不到，正是這道關卡存在要擋的失效），結果 `tsc` exit 0、
  `mcp-docs-sync.test.ts` 六條全綠、全專案 443 個測試全綠——沒有任何關卡叫。
  建議修法（兩個方向皆可，擇一或並行）：①對 `timeline_op` 的 `inputSchema`（`op` 的
  `z.enum`）斷言它恰好等於 `['split', 'deleteBefore', 'deleteAfter', 'freeze']` 這四個
  值，該工具改動時漏了某個 op 會被結構性抓到；②用 in-memory MCP client 對
  `timeline_op`／`import_media` 這類聚合工具的每一種豁免 op 各呼叫一次，斷言底層
  `Command` 真的觸達（等同把現在間接、靠人讀理由字串的信任，換成一次實際呼叫）。
  這一輪不修（新增測試＝擴大範圍，且現行 5 條豁免理由今天都成立），只在
  `MCP_EXEMPT_COMMANDS` 上方加了一行純文件註解，提醒改動聚合工具時要人工複查。

## 上線前必須由人確認

自動化測試涵蓋不到，需要真人與真環境：

- 播放流暢度與 A/B 無縫切換的實際觀感
- 成品觀感（字幕排版、ducking 音量、blur 填充）
- Claude Code 的真實 MCP 連線（目前驗過 transport，未驗過完整對話流程）
- 畫布拖曳/吸附的手感（吸附靈敏度、導線時機）與打字三段式的體感
- 「拖曳/改字之後**實際渲染一次**，比對成品與預覽畫布是否一致」這條完整路徑。
  ⚠️ 這條原本寫著「e2e 只驗了伺服器座標值有變，沒有跑過真的 render 去比對成品像素」，
  **已過期**：`npm run verify:wysiwyg`（`ui/e2e/preview-vs-export.mjs`）就是在做真 render
  → 抽幀 → 量墨跡外框，對上 headless 預覽截圖量到的同一個外框，兩邊都換算回
  1080×1920 畫布座標再比。六個 case：`overlay-scale1`、`overlay-scale05`、`overlay-wrap`
  （長文字自動換行）、`overlay-offtop`（`position.y` 為負、被裁到）、`overlay-offcentre`
  （`position.x = 0.25`，唯一 x≠0.5 的）、`caption`（**無**逐詞高亮）。
  所以「幾何映射對不對」已有自動化，**仍待人驗的是這三塊**：
  1. **拖曳這一段**——`verify:wysiwyg` 的 fixture 都是用 MCP 直接寫進去的
     （`import_media` → `set_timeline` → `add_overlay` ×5 → `set_captions`），
     不經過 UI 拖曳或改字；`verify:canvas` 拖得動、
     但它到「伺服器存了新座標」為止就結束，沒有接著 render。兩支合起來仍缺中間那一接。
  2. **比對的是外框，不是全畫面像素**——`inkBBox` 用固定亮度門檻（`INK_LUMA` = 128）
     圍出等亮度線，容差 `TOL_PX` = 4px。描邊粗細、顏色、反鋸齒不在比對範圍內。
  3. **karaoke 字幕沒有被涵蓋**——`caption` 那個 case 明寫是無逐詞高亮。karaoke 的
     已知狀況見 `CLAUDE.md`：**預覽描邊看起來略厚，匯出成品才是正確的**（不要跑去修
     那個不存在的匯出 bug）。
