# vidcut 快速 ingest 批(Plan 8)實作計畫——秒級可剪:分階段就緒 + 相容跳轉

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 素材匯入後**秒級可剪**:probe 完成即登記(播原檔),filmstrip/peaks/proxy 全部
降級為背景升級;來源已是瀏覽器可播的 H.264 時**整個 proxy 跳過**。28 分鐘 1080p 實測
案例(2026-08-20 真雲端煙霧):現況「可開始剪」要等 ~7 分鐘,本批目標 **≤3 秒**。

**Architecture:** ingest 拆三階段——A0(probe→`registerMedia`,同步、秒級)→
A1(filmstrip+peaks,背景)→ A2(proxy,背景,`proxyPlan` 判 skip/remux/transcode)。
每階段自身「檔案+雲端寫穿都成功才寫 doc」,「不留半套」紀律 per-stage 維持。
UI 早已是 `proxyPath ?? path`(`ui/src/ws.ts` 的 `mediaUrl`),原檔播放的地基天然存在;
純音訊素材本來就沒有 proxyPath,先例在。

**Tech Stack:** 既有(ffmpeg/ffprobe、Express、React)。零新依賴。

**Spec:** 無獨立 spec——本計畫的「範圍裁決」節即定案,依據是 2026-08-20 的競品/技術
調研(下節摘要)與同日真雲端煙霧的實測痛點。

---

## 競品調研摘要(2026-08-20;完整出處已查證,關鍵主張附來源)

- **沒有任何主流競品把「完整 proxy 轉檔」放在編輯的關鍵路徑上。**
  Frame.io「Friendly Files」:瀏覽器可播的 codec(H.264)上傳完**立即串流原檔**,
  transcodes 背景生成(support.frame.io/articles/5118269);hover-scrub 縮圖條
  在 transcode **之前**就緒(help.frame.io/articles/9101026)。
  CapCut:上傳完即可拖上時間軸;桌面版 proxy 在背景生成、「不需等它完成就能粗剪」
  (editlogic.io)。Kapwing:預覽零轉碼、重活全押匯出端(kapwing.com 官方 FAQ)。
  Clipchamp:直接對原檔在瀏覽器內編輯,證明 H.264 類素材原檔編輯是產品級路線
  (support.microsoft.com)。YouTube:低清先可用、高清數小時後補——分級就緒
  是使用者已被馴化接受的模型(support.google.com/youtube/answer/71674)。
- **Mux 的 JIT+切段平行**:10 分鐘影片 9 秒可發布(mux.com blog)。本批不做(P2),
  但方向一致:「可用性」與「保真度」解耦。
- **瀏覽器 codec 現實**:唯一全綠=H.264 8-bit 4:2:0(yuv420p);HEVC 只有 Safari 穩、
  10-bit 幾乎全滅、AV1 看硬解。web-compatible H.264 精確定義=yuv420p+faststart+bt709
  (Academy Software Foundation Encoding Guidelines)。
- **Scrub 手感 vs keyframe**:seek 落點=前一個 I-frame,GOP 越長 scrub 越鈍;串流通用
  基線 2s(Apple HLS spec),編輯器建議 ≤1–2s(coconut.co、liveapi.com)。手機/下載
  原檔常見長 GOP——**proxy 的價值一半在 keyframe 密度,不只在解析度**,所以「跳過
  proxy」必須量測 keyframe 間隔把關。

## 範圍裁決(controller 已定,實作者不要重開)

1. **三階段狀態機**:A0 probe+登記(同步,`ingestMedia` 回 mediaId 的時點)→
   A1 filmstrip+peaks → A2 proxy。A1/A2 在**模組級序列佇列**跑(ffmpeg 不並行,
   `/api/import` 既有紀律),同一素材 A1 先於 A2。
2. **A0 失敗=整體失敗**(同今天:probe 不過就 reject);**A1/A2 失敗=素材保持可用**,
   `console.error` 記錄,doc 不寫該階段欄位(P1 再談重試)。雲端寫穿失敗視同該階段
   失敗——doc 永不指向 R2 沒有的檔案(per-stage 不留半套)。
3. **`proxyPlan(probe) → 'skip' | 'remux' | 'transcode'`**(shared 純函數):
   - `skip`:codec=h264 且 pixFmt=yuv420p 且 max(w,h)≤1920 且 fps≤60 且容器 mp4/mov
     且 keyframeIntervalSec≤3 → **不產 proxy**,proxyPath 永遠缺席,播放/抽幀直接吃原檔。
   - `remux`:同上但容器不是 mp4/mov(mkv 裝 h264 等)→ `-c copy -movflags +faststart`
     產 proxy.mp4(秒級,無重編碼)。
   - `transcode`:其餘(HEVC/10-bit/>1080p/fps>60/長 GOP/量測失敗)→ 現行參數
     (g=15≈0.5s,scrub 手感刻意超密,不動)。
   - **量測失敗或欄位缺席一律保守走 `transcode`**(= 今天的行為;閘門只在確定安全時
     才開快路)。
4. **keyframe 量測**:`probeKeyframeInterval(file)`——ffprobe 只讀**前 60 秒**
   (`-read_intervals %+60 -select_streams v:0 -show_entries packet=pts_time,flags`),
   取 I-frame(flags 含 K)平均間距;<2 個 keyframe → 回 undefined(保守)。
   60 秒窗是成本上限(28 分鐘檔不能為了量測掃全檔)。
5. **`ProbeInfo` 擴充**(全部可選,舊檔缺席=未知=保守):`codec?: string`、
   `pixFmt?: string`、`container?: string`(ffprobe format_name 第一段)、
   `keyframeIntervalSec?: number`。probe() 本來就拿到 ffprobe 全量輸出,只是沒存。
6. **新命令 `updateMediaDerived`**(`Command` variant;欄位:mediaId + 可選
   proxyPath/filmstripPath/filmstripTiles/peaksPath):A1/A2 寫 doc 的唯一通道
   (鐵則:狀態變更走 applyCommand)。**內部命令,不進 MCP 工具面**——與
   `registerMedia` 同級:它是 ingest 管線的內部步驟,AI 沒有合法理由直接呼叫
   (鐵則第三步的「不需要」要在 commands.ts 註解寫明,防止未來有人誤補)。
   驗證:mediaId 存在、路徑是專案內相對路徑形狀、filmstripTiles 正整數。
7. **`ingestMedia` 語意改變=A0 回傳**;新增 `ingestMediaFully`(await 三階段全完成)
   給 demo.ts 與既有測試用(demo 建置期望衍生檔齊全,不該改變)。呼叫端盤點:
   `toolRegistry.ts` import_media(改用 A0,描述更新——鐵則三)、`app.ts` `/api/import`
   (A0;回應含 mediaId 不變)、demo.ts(`ingestMediaFully`)、商業線 upload pipeline
   (Task 6)。
8. **UI 幾乎零改動**:`mediaUrl` 已回退原檔;ClipBlock filmstrip 缺席已有底色 fallback,
   出現時 doc patch 自動刷新;**v1 不加「處理中」badge**(Frame.io 同款靜默升級;
   少一個 UI 面)。唯一要驗的是 AudioChip/波形對 `peaksPath` 缺席的容忍(查+補測試)。
9. **`frame.ts`/`render.ts` 的「proxyPath 一律存在」註解級不變量作廢**——程式碼已是
   `?? path` 寫法,只改註解與補測試(skip 模式下 get_frame/render 吃原檔)。
10. **修正 Plan 7 final fix wave 的過度清理**(商業線,Task 6):`app.ts` ingest 管線的
    `finally { rm(localAbs) }` 在**成功**時也刪掉剛拉回的原檔快取,下次 render 要從
    R2 重拉(28 分鐘檔=130MB/次)。改回「只在失敗時清理」——成功後的本地檔就是
    media cache 的鏡像,生命週期歸 LRU 管。
11. **本批不做**:切段平行轉碼(Mux 式,P2,搭 Modal render 池一起設計)、
    sparse→dense filmstrip 漸進補密(P1;A1 已把 filmstrip 提前,28 分鐘實測 ~50s
    在背景可接受)、硬體編碼、A1/A2 失敗自動重試、「處理中」UI 指示。
12. **執行基地=main**(開源線):ingest 提速是基礎品質不是 Pro 差異化(Pro 能力表
    無此項),且 bug 級的等待體驗開源線同樣該修。從 main 開 worktree(分支
    `fast-ingest`),完成後 Task 6 把它 merge 進 `cloud-upload`(方向合法:main→商業)。
    ⚠️ 若使用者想把「秒級 ingest」改列 Pro 差異化,喊停重排——這是產品決策,
    controller 不代決。

## Global Constraints

- 執行於 main 基底的 `fast-ingest` worktree;**worktree 第一件事 `npm install`**
  (CLAUDE.md:shared symlink 陷阱)。不碰 cloud/ 與任何商業內容(Task 6 除外,
  那一個 task 在 cloud-upload worktree 做)。
- 開源線既有行為的向後相容:舊專案(無新欄位)行為逐位元組不變;audioOnly 路徑不變;
  demo 建置產物不變(走 `ingestMediaFully`)。
- 鐵則:狀態變更走 applyCommand;改工具語意同步 toolRegistry 描述與 mcp.ts
  instructions(snapshot 測試按流程 `-u`);commit 前 docs-sync-review;
  收尾 `bash scripts/gauntlet.sh`(main 線的門檻數字以它為準)。
- 不要 `git add -A`;gauntlet 跑時不 commit。

---

## File Structure

```
shared/src/proxyPlan.ts            新:proxyPlan 純函數(skip/remux/transcode 判準)
shared/src/proxyPlan.test.ts       新:判準全分支測試
shared/src/types.ts                改:ProbeInfo 四個可選欄位、Command 加 updateMediaDerived
server/src/ffmpeg.ts               改:probe() 填新欄位;新 probeKeyframeInterval()
server/src/commands.ts             改:updateMediaDerived 驗證與 case
server/src/ingest.ts               改:拆三階段 + 背景佇列 + ingestMediaFully
server/src/toolRegistry.ts         改:import_media 描述(回傳時機=A0)
server/src/mcp.ts                  改:instructions 對應句
server/src/demo.ts                 改:改用 ingestMediaFully
ui/src/…(AudioChip/相關測試)     改:peaks 缺席容忍(查證後定點)
docs/…                             改:HANDOFF ingest 節、ROADMAP
(Task 6,cloud-upload worktree)    改:app.ts upload 管線 ready@A0 + localAbs 修正
```

---

### Task 1: `proxyPlan` 純函數 + probe 擴充

**Files:** Create `shared/src/proxyPlan.ts`(+test);Modify `shared/src/types.ts`
(ProbeInfo 欄位)、`server/src/ffmpeg.ts`(+server 側測試,放既有 ffmpeg/probe 測試檔旁)

**Interfaces(後續 task 依賴):**

```ts
// shared/src/proxyPlan.ts
export type ProxyMode = 'skip' | 'remux' | 'transcode';
export function proxyPlan(p: {
  codec?: string;
  pixFmt?: string;
  container?: string;
  width: number;
  height: number;
  fps: number;
  keyframeIntervalSec?: number;
}): ProxyMode;

// server/src/ffmpeg.ts
export async function probeKeyframeInterval(file: string): Promise<number | undefined>;
// probe() 回傳的 ProbeInfo 多帶 codec/pixFmt/container/keyframeIntervalSec
// (keyframe 量測獨立 ffprobe 呼叫,由 probe() 內部對 hasVideo 的檔案追加)
```

- [ ] **Step 1**:`proxyPlan` 失敗測試——skip 全條件成立;codec≠h264→transcode;
      pixFmt=yuv420p10le→transcode;1440×2560→transcode(直式 ≤1080×1920 要 skip);
      fps 59.94→skip、120→transcode;container=matroska+其餘全綠→remux;
      keyframeIntervalSec=undefined→transcode;=3.0 邊界→skip、3.1→transcode。
- [ ] **Step 2** 跑紅 → **Step 3** 實作(檔頭註解引調研出處:瀏覽器相容矩陣與 GOP 門檻)
      → **Step 4** 綠。
- [ ] **Step 5**:server 側——`probe()` 填新欄位(ffprobe 輸出的 codec_name/pix_fmt/
      format_name 已在手上);`probeKeyframeInterval` 用真 ffmpeg fixture 測:產兩支
      10 秒測試片(`-g 15` 與 `-g 300`),斷言量測值分別 ≈0.5 與 ≥9;無視訊檔回 undefined。
- [ ] **Step 6**:`npm test`(shared+server)+ typecheck + lint 綠 → **Step 7** Commit:
      `feat(ingest): proxyPlan 判準+probe codec/GOP 量測(Plan 8 Task 1)`

### Task 2: `updateMediaDerived` 命令

**Files:** Modify `shared/src/types.ts`(Command variant)、`server/src/commands.ts`(+測試,放 registerMedia 測試旁)

- [ ] 失敗測試:合法更新(逐欄可選)寫進 doc;mediaId 不存在→拒;路徑帶 `..` 或絕對
      →拒;filmstripTiles 0/-1/非整數→拒;不覆蓋未提供的欄位。
- [ ] 實作(commands.ts 註解寫明「內部命令,刻意不進 MCP 工具面」的理由——鐵則三的
      顯式豁免)→ 綠 → Commit:`feat(ingest): updateMediaDerived 內部命令(Plan 8 Task 2)`

### Task 3: ingest 拆三階段

**Files:** Modify `server/src/ingest.ts`(+既有 ingest 測試檔補 case)、`server/src/demo.ts`、`server/src/app.ts`(`/api/import`)、`server/src/toolRegistry.ts`

**Interfaces:**

```ts
// A0:probe + registerMedia,回 mediaId(prepareMedia 的冪等檢查保留)。
// 衍生階段丟進模組級序列佇列;完成各自 applyCommand('human', updateMediaDerived)。
export async function ingestMedia(store, projectDir, relPath, opts?): Promise<string>;
// 三階段全部 await(demo/測試用;衍生失敗會 throw——demo 要的是完整產物)
export async function ingestMediaFully(store, projectDir, relPath, opts?): Promise<string>;
```

- [ ] 失敗測試(真 ffmpeg 短 fixture):A0 回傳時 doc 已有 media(無 proxy/filmstrip/
      peaks 欄位)且可再 await 佇列排空後三欄位齊;`proxyPlan=skip` 的來源(h264 短片)
      最終 doc **沒有** proxyPath;remux 來源(mkv 裝 h264,ffmpeg 產)proxy 存在且
      轉出秒級(斷言 codec copy:ffprobe proxy 的 codec 與原檔一致);A1 失敗(fixture
      設不可寫目錄或注入)→ media 仍在、無 filmstrip 欄位、console.error 有記;
      audioOnly 全鏈不變;`ingestMediaFully` 等到全齊。
- [ ] 實作:佇列=ingest.ts 模組級 promise chain(app.ts `ingestQueue` 同款註解紀律);
      寫穿:A0 寫原檔(維持既有 `writeThroughToCloud` 拆分——原檔部分歸 A0,衍生檔
      各歸其階段);`frame.ts`/`render.ts` 的過期註解一併更新。
- [ ] 呼叫端:demo.ts→`ingestMediaFully`;`/api/import`+import_media→A0(toolRegistry
      描述改「returns as soon as the media is usable; preview/filmstrip keep upgrading in
      the background」語意,mcp.ts instructions 同步,snapshot 測試按流程 `-u`)。
- [ ] `npm test` 全綠 + typecheck + lint → Commit:
      `feat(ingest): 三階段就緒——probe 即登記,filmstrip/peaks/proxy 背景升級(Plan 8 Task 3)`

### Task 4: UI 容忍查證

**Files:** 查證後定點(候選:`ui/src/timeline/AudioChip.tsx`、waveform 相關)+ 測試

- [ ] 查:`peaksPath` 缺席時 AudioChip/波形繪製是否安全(null 容忍或 fetch 404 兜底);
      filmstrip 缺席 ClipBlock 已知安全(底色 fallback)。發現不容忍就修(最小改動),
      各補一條缺席測試。`npm run build -w @vidcut/ui`。
- [ ] Commit:`fix(ui): 衍生檔缺席容忍——分階段 ingest 的過渡態(Plan 8 Task 4)`

### Task 5: docs + gauntlet(main 線收尾)

- [ ] HANDOFF.md ingest 節重寫(三階段+proxyPlan);ROADMAP 對應項打勾;
      docs-sync-review skill 走一輪;`bash scripts/gauntlet.sh` 全綠(期間不 commit)。
- [ ] Commit:`docs: 快速 ingest 批文件同步(Plan 8 Task 5)`

### Task 6: 商業線適配(cloud-upload worktree)

- [ ] merge `fast-ingest` → `cloud-upload`(方向合法;衝突預期:ingest.ts 的
      originalAlreadyInCloud 旗標與 shared/index.ts 匯出清單)。
- [ ] `app.ts` upload 管線:ready 時點=A0(addClip 用 probe.duration,已可用);
      **撤回 `finally { rm(localAbs) }` 的成功路徑清理**(裁決 10)——失敗才清;
      upload-routes 測試對應更新(ready 秒級、衍生欄位晚到)。
- [ ] `npm test` 全綠 + 28 分鐘檔真雲端重驗:上傳完成→**托盤 Done + 時間軸可播 ≤3 秒**
      (該檔 h264/yuv420p/620kbps → 預期 `proxyPlan=skip`,proxy 完全不產;若 GOP 量測
  > 3s 則背景 transcode、期間播原檔)。結果記入 r2-upload-bucket.md 驗收表。
- [ ] Commit:`feat(cloud): upload ready@A0——秒級可剪(Plan 8 Task 6)`

---

## P1/P2(記帳)

- P1:A1/A2 失敗自動重試;sparse→dense filmstrip 漸進;「背景升級中」的 UI 微指示;
  ffmpeg 直吃 R2 signed URL(Plan 5 既有帳,與本批相乘:skip 模式+直吃=零下載)。
- P2:切段平行轉碼(Mux 式 ~10s chunk;搭 Modal render 池設計);JIT 縮圖(Mux
  storyboard 式)。
