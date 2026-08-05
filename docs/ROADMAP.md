# vidcut 上線計劃與可行方向

最後更新 2026-08-03。現況與已驗證範圍見 `HANDOFF.md`；各項設計定案見 `docs/superpowers/specs/`。

## 進行中

### 素材匯入：零複製引用 + 素材庫

設計定案：`docs/superpowers/specs/2026-08-03-media-import-design.md`

| 階段 | 內容                                                                                                                                                   | 狀態                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| 1    | `resolveMediaPath` 路徑語意、`scanSourceFolder`、`GET /api/source`、ingest 接受外部絕對路徑、`addClip` command、`POST /api/import`、MCP `import_media` | ✅ `main` + `list_source`、`add_clip` 補完 |
| 2    | 右側面板新增 `Media` 分頁：素材夾掃描 → 勾選匯入 → 已匯入清單 → 加到時間軸                                                                             | 待實作                                     |

後端零複製能力 + MCP 工具已全部上線；MCP 面原先階段 1 完成時仍有空白（`import_media` 掛、`add_clip` 缺），現已補完。

## 可行方向（尚未排程）

依「有實測或程式碼佐證」排序，前面幾項是已經量過或讀過程式碼確認的。

### 1. Proxy 參數可設定

`ingest.ts` 目前寫死 `scale=-2:960`。實測一支 60s 1080p 的 ingest 約 8.5 秒
（proxy 7.06s / filmstrip 1.40s / peaks 0.06s，約 7× 實時），4K 素材會顯著更慢。
讓 proxy 高度可設定（例如 540 供快速預覽、720 供精修）可直接換取匯入速度。
**輸出不受影響** —— render 走 `media.path` 原檔，只有封面截圖會退回 proxy。

### 2. ingest 進度與取消

目前 ingest 是不可中斷的黑箱。一支 10 分鐘 1080p 約需 85 秒，使用者需要看到進度、能取消。
`POST /api/import` 已規劃每支完成廣播一次 activity，但**單支內部**的 ffmpeg 進度尚未回報。

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

`ui/e2e/panel-affordance.mjs` 目前涵蓋面板收合/展開控制項（12 項斷言、4 種視窗尺寸）。
同樣的手法（真瀏覽器命中測試）可延伸到時間軸拖曳與字幕編輯 —— jsdom 量不出被遮擋與捲動裁切。

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

- **`setAudio` 只驗了 `mediaId`／`duration`／`in`，沒驗 `start`／`fadeIn`／`fadeOut`／
  `volume`**——與 `updateAudio` 不對稱。實際後果：負的 `start` 會被接受並落盤，而 render
  在組濾鏡鏈時不會為負值生成 `adelay`，**音訊被靜默放到 0 秒**，使用者看不到任何錯誤。
  這正是本輪立案要消滅的那類「壞資料默默落盤」，只是換了個欄位。修法照 `setAudio` 現有
  的逐項驗證迴圈往下加即可（`server/src/commands.ts` 的 `case 'setAudio'`）。
- **`add_clip` 的 AC12（審核進行中）可以有 mutant，本輪誤判為做不到**——`mutants.json`
  加一筆，`find` 是 `mcp.ts` 裡的 `const r = aiWrite(store, cmd, ifVersion);`，`replace`
  寫成 `const r = (await import('./commands.js')).applyCommand(store, 'ai', cmd);`。審查者
  已實跑驗證：只有 AC12／AC13 轉紅，快樂路徑維持綠，歸因正確。加完要重跑完整 gauntlet
  更新 EVIDENCE 的突變數字（70 → 71）。
- **`add_clip` 的 AC9／AC11 是假綠**——`mcp-tools.test.ts` 只斷言「回 `isError`」，而 MCP
  SDK 在**工具不存在**時同樣回 `isError`，所以把 `add_clip` 改名後兩條照樣通過。照
  `list_source` 目錄不存在那條的做法補上訊息內容斷言（例如斷言訊息含 `media not found`
  ／`out of bounds`）即可。
- **instructions 同步守衛測試沒有真的呼叫 `listTools()`**——這條測試是為了防「`commands.ts`
  加了 case 卻忘記在 `mcp.ts` `registerTool`」（`CLAUDE.md` 鐵則第三步）而寫的，但它比對
  的是靜態字串，工具真的沒註冊時它不會紅。要有保護力必須實際 `listTools()` 並與
  instructions 裡列出的工具名取交集比對。
- **測試會洩漏暫存目錄（產品面已修，測試面仍在漏）**——真-ffmpeg 測試建的 `vidcut-*`
  暫存目錄沒有在 teardown 清掉：`server/test` 裡有 **91 個 `mkdtemp` 呼叫，只有 15 處
  `rm(recursive)`**，27 個用到 `mkdtemp` 的測試檔中有 16 個連 `afterAll`/`afterEach`
  都沒有。數量還會被 helper 放大——`commands.test.ts` 只寫了 3 個 `mkdtemp`，卻因為
  `storeWithClips()` 是每條測試都呼叫一次的 helper 而產出 4,291 個目錄，所以殘留量是
  「測試條數 × 跑過幾次」。實測**一天累積 13,764 個目錄／5.93GB**（先前更曾累積到
  38,754 個／16GB+，把磁碟壓到剩 740Mi）。修法是在建立暫存目錄的測試 helper 加
  `afterAll` 清理；沒修之前，長期跑測試的機器會週期性被塞爆。
  （產品程式碼那半——`ingest.ts` 的 `vidcut-pcm-*`——已於 `fix-pcm-leak` 修好並有
  `ingest-pcm-cleanup` mutant 守著，見下。）
- **`mcp-tools.test.ts:317` 有一條套套邏輯斷言**——
  `expect(sc.clipId).toBe(store.doc.tracks.video.at(-1)!.id)` 兩邊用同一個 `.at(-1)` 讀
  同一份狀態，恆真。審查者把 `push` 改成 `unshift` 實測，真正轉紅的是鄰行的 `label`
  斷言（那條才是獨立 oracle）。功能上無漏洞，但這條斷言證明不了它宣稱的「回傳的 id
  就是新 clip 的 id」。改法：把預期 id 在呼叫前先算好或改用 label／長度等獨立 oracle。

## 上線前必須由人確認

自動化測試涵蓋不到，需要真人與真環境：

- 播放流暢度與 A/B 無縫切換的實際觀感
- 成品觀感（字幕排版、ducking 音量、blur 填充）
- Claude Code 的真實 MCP 連線（目前驗過 transport，未驗過完整對話流程）
