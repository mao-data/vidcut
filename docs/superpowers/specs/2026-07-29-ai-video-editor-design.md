# AI 原生影片時間軸編輯器 — 設計規格

> **歷史文件（2026-07-29 的設計定案）**：記錄當時的決策與理由，**不隨程式碼更新**。
> 現況以 `CLAUDE.md`／`HANDOFF.md` 為準。

日期：2026-07-29
狀態：草稿（待使用者審查）
專案代號：**vidcut**（`ai-video-cut/`）

## 1. 目標與非目標

### 1.1 一句話定義

一個跑在本機的 web 時間軸編輯器：**AI（Claude Code 或任何 MCP client）透過 MCP 剪片，人類在瀏覽器裡即時看到每一步、隨時介入調整，AI 讀回人類的調整繼續工作**。參考對象為 Vyra（usevyra.com）的「External AI Integration」模式。

### 1.2 目標

- **G1 可觀看**：AI 的每個編輯動作在 UI 上即時可見（片段出現、trim 改變、overlay 更新），不用等渲染。
- **G2 可介入**：人類可在 UI 上拖拉 trim、換片段順序、改 overlay/字幕文字、調整音量，改動立即成為專案狀態的一部分，AI 下次讀取就看到。
- **G3 有審核關卡**：AI 在關鍵步驟（選段完成、渲染前）暫停等人類核准；核准粒度是「看結果」而非「看意圖」。
- **G4 AI-agnostic**：MCP 是唯一的 AI 入口。Claude Code、Claude Desktop、Cursor 或任何 MCP client 都能連。
- **G5 承接現有管線**：`ranking-video-generator` skill 的掃描/峰值偵測/選段腳本原封不動，只把「拼 assemble_config → 自行合成」的尾段改成「寫入專案 → 請求審核 → 渲染」。
- **G6 成品輸出**：Node 端原生 ffmpeg 從專案 JSON 直接渲染 1080×1920 mp4，品質等同現有 assemble.py。

### 1.3 非目標（第一版明確不做）

- 內嵌 chat 面板（人跟 AI 的對話留在 Claude Code 終端機；UI 是視覺面）。
- 任意多軌自由編輯（軌道結構固定為：1 條影片主軌 + overlay 軌 + 字幕軌 + 音訊軌）。
- 轉場、濾鏡、keyframe 動畫（架構預留合成器升級路徑，但第一版不實作）。
- 多人協作、雲端、帳號系統、行動裝置支援。
- 匯出到剪輯軟體（FCPXML/Resolve）——留待後續階段。
- 素材上傳 UI——素材由 AI 端（yt-dlp 等）放進專案資料夾後以 `import_media` 登記。

### 1.4 成功標準

跑一次完整流程：使用者在 Claude Code 說「做一支 satisfying ranking 片」→ AI 掃描、下載、選段、把 5 個片段排上時間軸 → UI 即時顯示 → AI 呼叫 `request_review` → 使用者在瀏覽器預覽、把 No.3 的出點拖短 1.2 秒、改一行標題 → 按「核准」→ AI 讀到調整、呼叫 `render` → 產出 mp4。全程不需要使用者碰終端機（對話除外）。

## 2. 系統架構

### 2.1 總覽

單一 Node + TypeScript 常駐程序，綁定 `127.0.0.1:3845`，一個 port 服務四種流量：

```
┌────────────── 單一 Node 程序（127.0.0.1:3845）──────────────┐
│  Express 5 單一 http.Server                                  │
│   ├─ GET  /            靜態 React UI（vite build 產物）       │
│   ├─ GET  /media/*     express.static（原生支援 Range）       │
│   ├─ ALL  /mcp         MCP Streamable HTTP endpoint          │
│   └─ WS   /ws          ws.WebSocketServer（UI 狀態同步）      │
│                                                              │
│  ProjectStore（module 單例，唯一真相來源）                     │
│   doc（project JSON）· version 遞增 · immer produceWithPatches │
│   history ring buffer（patches + inversePatches, 200 筆）     │
│   pendingReviews Map · debounce 原子寫入磁碟                   │
│                                                              │
│  MCP 工具層（意圖級 ~15 個工具，closure 引用 ProjectStore）     │
│  Ingest 管線（ffmpeg proxy / filmstrip / peaks / ffprobe）    │
│  Render 管線（ffmpeg filter_complex，對原始檔渲染）            │
└──────────────────────────────────────────────────────────────┘
     ▲ /mcp（Streamable HTTP）        ▲ /ws（patch 廣播）
  Claude Code / 任何 MCP client     React UI（瀏覽器）
```

**核心原則：所有變更——不論來自 MCP 工具或 UI——都走 `ProjectStore.mutate()` 這一條序列化路徑。** 這是調研中反覆驗證的教訓：自己掌控文件格式與單一指令層的系統（FableCut、OpenChatCut、tldraw）幾乎免費獲得可觀看性、衝突偵測與原子 undo；掛在封閉 API 上的系統（Blender MCP、DaVinci Resolve MCP）繼承所有缺口。

### 2.2 為什麼是 Streamable HTTP 而非 stdio

stdio 模式下每個 MCP client 會各自 spawn 一份 server 程序，狀態分裂且瀏覽器 UI 連不到。Streamable HTTP 讓一個常駐程序同時服務多個 MCP client 與瀏覽器。註冊方式：專案根目錄 `.mcp.json` 提交 `{"mcpServers":{"vidcut":{"type":"http","url":"http://127.0.0.1:3845/mcp"}}}`，README 附 `claude mcp add --transport http vidcut http://127.0.0.1:3845/mcp` 一行指令。

### 2.3 技術選型

| 層       | 選擇                                                     | 理由                                                                                                      |
| -------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| MCP SDK  | `@modelcontextprotocol/server` v2（2.0.0）               | 官方新專案推薦；`input_required` + legacy shim 同時服務新舊 client，是 request_review 的最乾淨解          |
| HTTP     | Express 5 + 官方 `@modelcontextprotocol/express` adapter | `createMcpExpressApp` 自帶 Host/Origin 驗證（防 DNS rebinding）；`express.static` 原生支援 Range requests |
| WS       | `ws`                                                     | 事實標準、零依賴；不用 socket.io（單機 app 過重）                                                         |
| 狀態     | Immer `produceWithPatches`                               | 一次得到新 doc、廣播用 patches、undo 用 inversePatches                                                    |
| 前端     | React 19 + Vite + zustand                                | 使用者熟悉的生態；zustand 分 store（timeline/playback/media）學 OpenCut classic                           |
| 影音處理 | Node 端原生 ffmpeg（brew 安裝）                          | 比 ffmpeg.wasm 快 10 倍以上、無記憶體限制                                                                 |
| 波形     | ffmpeg raw PCM → Node 分桶取峰值                         | 免額外依賴（audiowaveform 為升級選項）                                                                    |
| 渲染引擎 | 不用 Remotion                                            | 授權綁定風險（≥4 人公司嵌 Player 觸發 $100/月起）；我們的合成需求（片段序列+PNG overlay+字幕）用不到它    |

授權紅線（不 fork、不引入）：`@designcombo/timeline` 等核心包（閉源無授權宣告）、Twick（SUL 不可再散布）、Remotion 內核。可安心學/用：OpenCut classic（MIT）、omniclip（MIT）、mediabunny（MPL-2.0，日後瀏覽器內處理需要時再引入）。

## 3. 資料模型：`project.json`

非破壞性、純 JSON、單一檔案。存放於專案資料夾（`projects/<name>/project.json`），媒體與衍生檔在同資料夾下。

```ts
interface Project {
  schemaVersion: 1;
  id: string; // 專案 id
  name: string;
  canvas: { width: 1080; height: 1920; fps: 30 };
  media: MediaAsset[]; // 素材登記表
  tracks: {
    video: VideoClip[]; // 主軌：磁性（無 gap，順序即時間）
    overlays: OverlayItem[]; // PNG/圖片 overlay（絕對時間或錨定片段）
    captions: CaptionItem[]; // 文字字幕（渲染時燒錄）
    audio: AudioItem[]; // 旁白/BGM（絕對時間）
  };
  review: ReviewState | null; // 當前待審核請求（見 §6）
  render: { lastOutput?: string; status: 'idle' | 'running' | 'done' | 'error'; progress?: number };
}

interface MediaAsset {
  id: string; // 穩定 id，clip 以此引用
  path: string; // 原始檔（相對專案資料夾）
  proxyPath?: string; // 540×960 GOP15 proxy（ingest 產出）
  filmstripPath?: string; // 縮圖條 sprite
  peaksPath?: string; // 波形峰值 JSON
  probe: {
    duration: number;
    width: number;
    height: number;
    fps: number;
    hasAudio: boolean;
    rotation: number;
  };
  label?: string; // 例 "N3 @fruit.centre5 (TikTok)"
  meta?: Record<string, unknown>; // AI 自由欄位（來源 URL、觀看數、outlier 倍率…）
}

interface VideoClip {
  id: string;
  mediaId: string;
  in: number; // 來源內起點（秒，= 現有腳本的 ss）
  duration: number; // = 現有腳本的 t
  label?: string; // 例 "No.3"
  volume: number; // 0–2，預設 1
  meta?: Record<string, unknown>; // 峰值來源 audio|motion、rank 等
}

interface OverlayItem {
  id: string;
  imagePath: string; // make_overlays.py 產出的 PNG
  // 錨定二選一：
  anchor?: { clipId: string; offset: number }; // 跟著片段（片段被拖動時 overlay 跟著走）
  start?: number; // 或絕對時間
  duration: number; // Infinity 表示到片尾（常駐排行榜）
  position: { x: number; y: number; scale: number };
}

interface ReviewState {
  id: string;
  summary: string; // AI 對這輪工作的說明（顯示在審核條）
  focus?: string[]; // 要高亮的 clipId
  sinceVersion: number; // 這輪 AI 工作的起始 version（退回時的回滾範圍、核准時的 feedback 範圍）
  requestedAt: string;
}
// resolve 後 review 置回 null，結果（approved/rejected/timeout + 留言）寫入 review 歷史供 get_feedback 讀取

interface CaptionItem {
  id: string;
  text: string;
  start: number;
  duration: number;
  style: { fontFamily: string; fontSize: number; fill: string; stroke?: string; y: number }; // 直式短片：垂直位置為主
}

interface AudioItem {
  id: string;
  mediaId: string; // 旁白 mp3 / BGM 也登記進 media
  start: number; // 絕對時間
  in: number;
  duration: number;
  volume: number;
  ducking?: boolean; // 渲染時對主軌音量 sidechain 壓低（第一版可只做固定比例）
}
```

設計要點：

- **影片主軌是磁性時間軸**（CapCut 慣例）：`video[]` 陣列順序即播放順序，無 gap、無絕對 start——換順序 = 移動陣列元素，trim = 改 `in`/`duration`。這符合 ranking 片的實際結構，也大幅簡化預覽與渲染。
- **overlay 可錨定片段**：常駐排行榜 overlay 的「第 N 段亮起」語意天然跟著片段走，人類拖動片段順序時 overlay 不會錯位。
- **`meta` 自由欄位**：AI 把來源追蹤資訊（TikTok id、outlier 倍率、峰值來源）存這裡，UI 顯示為 tooltip，`used_clip_ids.json` 回寫流程可從此讀取。
- 時間單位一律**秒（浮點）**，UI 顯示層再換算幀。

## 4. 狀態同步與歷史

### 4.1 mutation 路徑

```ts
store.mutate(source: 'ai'|'human', label: string, recipe: (draft) => void)
// → produceWithPatches → version++ → history.push({version,label,patches,inverse,source,ts})
// → WS 廣播 {type:'patch', version, patches, source, label}
// → debounce 500ms 原子寫入磁碟（temp + rename）
```

- UI 連上/重連時發 `{type:'resync'}` 取 `{type:'full', version, doc}` 全量快照。
- **UI 不做樂觀更新**：localhost RTT < 5ms，直接等 server echo，省掉整個 reconcile 邏輯。
- 併發控制：server 序列化所有 mutation，欄位級 LWW。不做 CRDT/OT（單機、兩個寫者，過度設計）。
- **AI 寫入的過期偵測**：AI 的寫入工具接受選填 `ifVersion`；若人類在該 version 之後改過專案，回 `isError`「使用者已修改，請先 `get_feedback` 再重試」——把衝突轉成 AI 看得見的回饋而非靜默覆寫（talk-to-figma「每次寫入前重讀」紀律的協定化）。
- 真正的防呆在審核層：`review` 進行中時 AI 的寫入工具會被拒絕（見 §6.3），這比通用鎖簡單且對症。

### 4.2 歷史與 undo

- history ring buffer 200 筆，含 `source` 標記——同時就是 UI 右側「AI 活動記錄」面板的資料來源（tldraw/OpenChatCut 的可觀看性模式）。
- undo = 套用 inversePatches，**以新 mutation 形式廣播**（版本號繼續遞增，不回捲）。
- **AI 會話級復原**：`request_review` 被「退回」時，server 自動把該審核區間內所有 `source:'ai'` 的 mutations 一次 undo（原子回滾整段 AI 工作——OpenChatCut 驗證過的正確預設，避免 Descript「回滾粒度太粗/太細」的兩難）。
- UI 提供 Cmd+Z（逐步 undo，人和 AI 的變更一視同仁）＋「**撤銷 AI 上一輪**」按鈕（回滾最近一段連續的 AI mutations——Premiere AI Assistant 的 turn-level undo 已驗證這個粒度是使用者要的）。
- 人類與 AI 動作交錯導致 undo 語意混亂是 Premiere AI Assistant 的已知失敗模式；我們以「審核期間擋 AI 寫入（§6.3）＋ history 逐筆標記 source」避開。

## 5. MCP 工具層

意圖級工具，~15 個（AWS/Resolve 調研共識：不要 1:1 映射 API 也不要包山包海）。所有工具回傳 `structuredContent`（含新 `version` 與變更摘要）+ 文字摘要；讀取工具回裁剪視圖（Claude Code 輸出上限 25k tokens）；媒體一律回 URL 不回 base64。

| 工具                                            | 說明                                                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `get_project`                                   | 裁剪後的專案總覽（片段列表含 in/duration/label、overlay/caption 摘要、version）。`{full:true}` 才回完整 JSON                             |
| `import_media`                                  | 登記素材檔 → 觸發 ingest 管線（ffprobe → proxy → filmstrip → peaks），回傳 mediaId + probe 結果。支援批次                                |
| `set_timeline`                                  | 整組設定影片主軌（初次排片用）：`[{mediaId,in,duration,label,meta}...]`                                                                  |
| `update_clip` / `reorder_clips` / `remove_clip` | 片段級修改                                                                                                                               |
| `set_overlays` / `set_captions` / `set_audio`   | 各軌整組替換（這些軌的項目少，整組替換比逐項 CRUD 對 LLM 更不易出錯）                                                                    |
| `request_review`                                | 見 §6。參數：`{summary, focus?: clipId[]}`                                                                                               |
| `get_feedback`                                  | 回傳自指定 version 以來的人類變更摘要（diff 語意化：「No.3 出點 -1.2s」「標題第 2 行改為…」）+ 使用者留言                                |
| `get_editor_context`                            | 人類在 UI 的當前選取、playhead 位置、拖選的時間範圍——使用者說「幫我改這段」時的空間指涉來源（Vyra 驗證過的最便宜有效的人→AI 回流機制）   |
| `get_frame`                                     | 回傳指定時間點的合成畫面（片段 + overlay + 字幕）JPEG URL——AI 的「眼睛」，用於驗證 overlay 疊加與字幕位置（Vyra 的 canvas 截圖工具同款） |
| `undo`                                          | `{steps}` 或 `{toVersion}`                                                                                                               |
| `render`                                        | 觸發渲染，回傳 job id；以 progress notification 回報進度，完成回輸出路徑                                                                 |
| `get_history`                                   | AI 活動記錄 + 人類變更記錄                                                                                                               |

另曝露 read-only resource `vidcut://project`（專案快照，Claude Code 可 `@` 引用）。server instructions（≤2KB）說明工作流程：import → set_timeline → request_review → 依 feedback 修改 → render。

**安全**：只綁 127.0.0.1；沿用 SDK 的 Host/Origin 驗證；WS upgrade 驗 Origin；不提供 execute/eval 類逃生艙（Blender MCP 的教訓）；`render`、`remove_clip` 標 `destructiveHint`。

## 6. 審核流程（人機協作核心）

### 6.1 互動模型

調研結論的綜合（Descript「審核結果而非意圖」、OpusClip「匯出才是關卡」、OpenChatCut「草稿核准」）：

- **平時不打斷**：AI 的一般編輯（排片、調整、上 overlay）直接套用、即時可見、事後可 undo——不做每個 tool call 都彈確認（會被 rubber-stamp，調研中有明確警告）。
- **關卡設在高成本動作前**：`request_review`（AI 自主呼叫，skill 指示在「初版時間軸完成」與「渲染前」各一次）與 `render`（渲染本身必經 review 通過，除非使用者在 UI 上勾「本專案免審渲染」）。
- **審核模式可調**（Premiere AI Assistant 的「Always ask / Auto approve」雙模式驗證了這個需求）：UI 設定提供「關卡審核（預設）／全自動」開關；全自動時 `request_review` 立即回 `approved`（活動記錄照常保留，事後仍可整輪撤銷）。

### 6.2 `request_review` 機制

1. AI 呼叫 `request_review({summary, focus})` → store 寫入 `review` 狀態 → WS 廣播 → UI 頂部亮出審核條（顯示 AI 的 summary、highlight `focus` 片段）。
2. 對支援 elicitation 的 client（Claude Code v2.1.76+）：以 **elicitation URL mode** 回傳 `http://127.0.0.1:3845/review/<id>`——Claude Code 會提示使用者打開瀏覽器，直接落在審核頁。偵測不支援時退回阻塞等待。
3. 使用者在 UI 上自由調整（拖 trim、改文字、換順序——全部走一般 mutation 路徑，被記為 `source:'human'`），然後三選一：
   - **核准**：review resolve 為 `approved`，工具回傳核准 + 自 review 開始以來的人類調整摘要。
   - **退回**：review resolve 為 `rejected` + 必填留言；server 原子回滾該區間的 AI mutations（§4.2）。
   - **留言不擋**：附註想法但讓 AI 繼續（resolve 為 `approved_with_notes`）。

   此外，**不限審核期間**，UI 隨時可對任一片段/overlay 留言（右鍵→留言），寫入 note 佇列，由 `get_feedback` 一併回傳——人的想法不必等 AI 開審核才能表達。

4. **保活與逾時**：等待期間每 20 秒送 progress notification（躲 Claude Code 5 分鐘 idle timeout）；預設 15 分鐘逾時回傳 `timeout`（AI 可決定續等或先做別的）；`ctx.mcpReq.signal` 中止時清理 pendingReview。

### 6.3 審核期間的寫入規則

`review` 進行中時：人類寫入照常；**AI 的寫入工具回 `isError`**（「審核進行中，請等待結果」）。先到先贏、規則簡單，避免 AI 在人類審核到一半時改動畫面（Figma 屬性級 LWW「靜默互蓋」的反面教訓）。

### 6.4 AI 變更的可視化

- 右側「活動」面板：mutation 流水（AI/人類分色、時間、label），點擊可跳到對應片段——這就是「human watches」的主介面。
- AI 最近一輪變更的片段在時間軸上短暫高亮（邊框脈衝 2 秒）。
- 審核條的 `focus` 片段持續高亮直到 review 結束。
- **來源徽章**：由 AI 建立/最後修改的片段帶小型「AI」badge（Premiere Generative Extend 的 provenance label 模式）；hover 顯示該片段的最近變更記錄。人類改過後 badge 轉為中性。

## 7. 預覽播放器

單影片軌是關鍵簡化——**雙 `<video>` A/B 交換**即可無縫，不需 WebCodecs：

- 每個 media 用 proxy 檔（540×960、H.264、**GOP 15**、`-sc_threshold 0`、faststart——scrub 順滑與檔案大小的甜蜜點）。
- 播放中：A 可見播放，B 提前 mount 下一片段（`opacity:0`，不可 `display:none` 否則不解碼）、pre-seek 到 `in`、等 `canplay`；邊界前 ~50ms 靜音啟播 B，到點交換可見性 + 解除靜音（Remotion premount 概念的自製版）。
- **主時鐘**：rAF + `performance.now()`，不信任 `<video>.currentTime`；每幀比對 active video 與期望時間，漂移 > 60ms 時校正。
- overlay/caption：絕對定位 DOM 疊在播放器上，依主時鐘顯隱——改文字/位置零成本即時反映。
- 音訊軌：WebAudio 排程旁白/BGM（proxy 已含音軌的片段聲音直接用 video 元素出聲）。
- scrub：只 seek active video；停留 300ms 以上才 seek 相鄰片段預備。
- 架構上「片段排程器」與「畫面合成器」分離——日後要轉場/濾鏡時只把合成器換成 canvas（引入 mediabunny），排程器不動。

**時間軸 UI**：自建 div + Pointer Events（`setPointerCapture`）——調研共識是現成元件（xzdarcy、dnd-timeline）最終都會被換掉，我們的軌道結構又特別簡單。慣例照抄業界：trim handle 8px 熱區＋`ew-resize`、吸附閾值 8px（換算 `8/pxPerSecond` 秒）吸 playhead/片段邊緣/整秒、Ctrl+滾輪以游標為錨縮放（`pxPerSecond` 單一縮放狀態）、S 鍵在 playhead 分割片段、主軌磁性閉合。filmstrip sprite 當 clip 背景圖依 zoom 算 `background-position`；波形每 clip 一個 canvas 畫峰值。

## 8. Ingest 與渲染管線

### 8.1 Ingest（`import_media` 觸發，Node spawn ffmpeg）

1. `ffprobe` → duration/解析度/fps/rotation/hasAudio（rotation 在 proxy 階段烘進像素）。
2. proxy：`scale=-2:960, fps=30, libx264 -preset veryfast -crf 23 -g 15 -keyint_min 15 -sc_threshold 0 -tune fastdecode -movflags +faststart`＋AAC 音軌。**無音軌素材補靜音軌**（`anullsrc`）——現有 skill 已踩過的坑，在 ingest 層一次解決。
3. filmstrip：`fps=1, scale=-2:80, tile=Nx1` sprite。
4. peaks：`ffmpeg -ac 1 -ar 8000 -f s16le -` raw PCM → Node 分桶 min/max → JSON。
5. 各步驟以 progress notification 回報；產物路徑寫回 `MediaAsset`。

### 8.2 渲染（`render` 觸發）

project.json → ffmpeg filter_complex 直譯，**對原始檔渲染**（非 proxy）：

- 每片段 `trim`/`setpts`（**一律完整重新編碼、不用 `-c copy`**——沿用 skill 實測的音畫對齊教訓）→ scale/pad 到 1080×1920 → `concat`。
- overlay PNG 依時間 `overlay=enable='between(t,…)'`；caption 走 `drawtext`（或組 ASS 字幕燒錄，第一版 drawtext 即可）。
- 音訊：片段原聲 + 旁白 + BGM `amix`，音量係數與（若啟用）對白時段 BGM 壓低。
- 渲染跑在子程序，進度 parse ffmpeg `-progress` 輸出 → progress notification + WS 廣播（UI 顯示進度條）。
- 輸出 `projects/<name>/output/<timestamp>.mp4`，完成後 UI 顯示可播放的成品預覽。
- 渲染結果與 assemble.py 的驗證方式相同：抽段連續畫面人工確認 + 波形互相關抽查（寫進 skill 指引，不做進系統）。

## 9. 與現有 skill 的整合

`ranking-video-generator` skill 修改（新增一節「vidcut 模式」）：

1. 步驟 1–3（掃描、下載、峰值、選段）不變——這些是 AI 的「理解」工作，本來就不需要 UI。
2. 步驟 3 尾端改為：`import_media`（5 支素材）→ `set_timeline`（帶 rank label 與 meta）→ 原本的 confirm_*.jpg 抽幀確認改為 `request_review`（人類直接在 UI 上看動態預覽，比靜態圖強得多）。
3. 步驟 4 的 overlay PNG 照舊由 `make_overlays.py` 產生，改以 `set_overlays` 錨定到片段。
4. 步驟 5 改為 `render`。
5. `used_clip_ids.json` 回寫邏輯不變，資料從 `get_project` 的 clip meta 讀取。

skill 之外，任何 MCP client 拿到 server instructions 就能操作同一套介面（G4）。

## 10. 錯誤處理

- **ffmpeg 失敗**（ingest/render）：stderr 尾段進 tool result 與 UI toast；render 狀態機 `error` 可重試。
- **MCP client 斷線**：pendingReview 保留（人類仍可核准，結果存入 review 歷史；AI 重連後用 `get_feedback` 補讀）。
- **server 重啟**：project.json 已落盤（debounce 500ms + 原子寫入）；history 不持久化（可接受：undo 歷史限本次會話）。
- **素材檔遺失**：UI 顯示占位框 + 錯誤標記；`get_project` 標注 missing，AI 可決定重下載。
- **瀏覽器沒開**：`request_review` 的 elicitation URL 本身就是入口；WS 無連線不影響 server 運作。

## 11. 測試策略

- **ProjectStore 單元測試**（核心）：mutation/patch/undo/review 狀態機、AI 會話回滾、審核期間 AI 寫入拒絕。
- **MCP 工具整合測試**：以 SDK client 連 in-process server，走完 import → set_timeline → request_review（程式化 resolve）→ render（假 ffmpeg）流程。
- **ffmpeg 管線煙霧測試**：對 fixtures 小影片跑真 ingest + render，驗證輸出時長/解析度/含音軌。
- **預覽播放器**：手動驗證為主（無縫切換、漂移校正屬體感問題）；片段排程器的純函數（時間 → 該顯示哪段的哪一刻）做單元測試。

## 12. 里程碑

| 里程碑         | 內容                                                                                | 完成標準                                              |
| -------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **M1 看得到**  | ProjectStore + WS 同步 + UI 時間軸唯讀顯示 + 預覽播放器 + ingest 管線               | 手寫 project.json，UI 能無縫播放 5 段 proxy + overlay |
| **M2 改得動**  | trim 拖拉、排序、overlay/caption 編輯、undo、活動面板                               | 人類全鍵鼠完成一次時間軸調整                          |
| **M3 AI 接上** | MCP server + 全部工具 + request_review（elicitation URL + 阻塞 fallback）+ 審核規則 | Claude Code 走完 §1.4 成功標準（渲染除外）            |
| **M4 渲染**    | render 管線 + 進度回報 + skill 改寫                                                 | §1.4 成功標準全程通過，成品品質 ≥ assemble.py         |

M1/M2 期間用手寫 fixture 專案開發，不依賴 MCP——確保每階段獨立可驗證。

## 13. 風險與緩解

| 風險                                | 緩解                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 無縫播放在實機上有感知 gap          | proxy 短 GOP + premount + 提前靜音啟播已是業界驗證組合；仍有 gap 時退而求其次：邊界 1 幀黑場淡切（短片觀感可接受），或後續升級 WebCodecs 合成器 |
| MCP SDK v2 太新（2.0.0 剛轉正）     | 工具層薄、狀態都在 ProjectStore；必要時降級 v1 `@modelcontextprotocol/sdk@1.30.0` + `elicitInput`，官方有 codemod 雙向遷移                      |
| elicitation URL mode 行為與預期不符 | 三層退化：URL mode → 阻塞等待 UI 按鈕（+保活）→ 輪詢工具                                                                                        |
| drawtext 中文字型/emoji 渲染品質    | 字幕改走 ASS（libass）燒錄；emoji 沿用現有 make_overlays.py 的 twemoji PNG 方案                                                                 |
| ffmpeg filter_complex 複雜度失控    | 渲染器輸入是結構固定的四軌模型，filtergraph 生成器可窮舉測試；不支援的組合直接報錯而非默默出錯                                                  |
