# HANDOFF — vidcut 開發交接

> 這份檔案記錄「目前做到哪、怎麼驗、已知限制、下一步」。每個里程碑完成都會更新。
> 最後更新：M1 完成（tag `m1-done`）之後，M2 進行中。

## 現況總覽

| 里程碑 | 狀態 | tag |
|---|---|---|
| M1 看得到 | ✅ 完成、自動化測試全綠、端到端煙霧測試通過 | `m1-done` |
| M2 改得動 | 🚧 見下方進度 | — |
| M3 AI 接上 | ⏳ 待做 | — |
| M4 渲染 | ⏳ 待做 | — |

## 明天第一件事：親眼驗收 M1

我（AI）能驗證「邏輯正確、程式能跑、API/媒體端點正常」，但**無法驗證「無縫播放的視覺體感」**——這要你的眼睛。請這樣做：

```bash
cd ai-video-cut
npm run demo        # 終端機 A：建 demo + 起 server
npm run dev:ui      # 終端機 B：開 http://localhost:5173
```

驗收清單（對照 spec §12）：

1. 頁面顯示 🟢 已連線、專案 `demo`、時間軸有 5 個 clip（縮圖 + 底部綠色波形；No.3 是無音軌 clip，波形應為平線）。
2. 按 ▶：5 段連續播放（各 3 秒、共 15 秒），**切換點有沒有黑幀/白閃或明顯停頓**（這是 M1 最關鍵的體感驗收）。
3. 橙白橫幅 overlay 全程在頂部；字幕在 1–4s、6–10s 出現消失。
4. 音訊：各段 sine 音高不同、切換不爆音；No.3 靜音。
5. 點時間軸任意處：playhead 跳過去、預覽同步跳轉。
6. 播到片尾自動停、▶ 可再按。

**如果切換有可感知的破綻**：這是 spec §13 已預期的風險。緩解手段（M2 可加）：邊界處 1 幀淡切，或把合成層升級為 canvas + WebCodecs。先記錄現象（哪幾段、什麼破綻）給我，別急著改。

## 環境限制（重要，會影響 M4）

**本機 Homebrew ffmpeg 8.1.2 沒有編入 `drawtext`／`libfreetype`／`libass`。** 實測只有 `drawbox`/`overlay`/`colorize` 這類不需字型的濾鏡。影響與對策：

- **M1 demo 標題**：已改用 `drawbox` 畫橫幅（不燒字），不受影響。
- **M4 字幕/文字 burn-in**：不能用 `drawtext` 或 `subtitles`(ass) 濾鏡。**正確方向是把文字先渲染成透明 PNG 字卡，再用 `overlay` 濾鏡合成**——這剛好跟你現有 `ranking-video-generator` skill 的 `make_overlays.py`（Pillow 產字卡）完全一致，M4 會沿用這條路。屆時二選一：
  1. 重裝含 freetype 的 ffmpeg：`brew reinstall ffmpeg`（若 bottle 仍缺，需 `--build-from-source` 或換 tap，較慢）——最省事但不保證。
  2. **（建議）文字一律 PNG 化**：caption/標題都由字卡 PNG 走 `overlay`，render 管線完全不依賴 ffmpeg 的字型支援，跨機器最穩。需要一個文字→PNG 的產生器（Pillow，或 Node 端 `@napi-rs/canvas`）。你的 skill 已用 Pillow，建議 `pip3 install pillow --break-system-packages` 後沿用。

決定放到 M4 開頭，我會在 M4 計畫裡把兩條路都寫清楚。

## 已知取捨（M1 範圍內、非 bug）

- `undo` 的「撤 undo = redo」語意是 M1 簡化（spec §4.2 只要求逐步 undo）；M2 若要正式 redo stack 再擴。
- 字幕預覽字級用 `fontSize/3` 粗略換算（1080 畫布→預覽像素），非逐像素精準；M2 改為依容器實寬換算。
- 播放是 client 端狀態，多分頁各自獨立 playhead（專案內容一致）——這是刻意設計。
- Safari 未測（開發用 Chrome）。
- workspace 有兩份 vite 副本導致 `vite.config.ts` 型別衝突，已把它移出 tsconfig include（Vite 執行期自行處理），不影響 app 原始碼 typecheck。

## 程式碼地圖（給明天改動用）

```
shared/src/types.ts      所有資料型別（spec §3）；改資料模型從這裡開始
shared/src/timeline.ts   純時間軸計算（locate/overlayWindow…）；播放器與渲染共用
server/src/store.ts      ProjectStore：唯一真相來源。所有變更走 mutate()
server/src/ffmpeg.ts     runFfmpeg/probe
server/src/ingest.ts     proxy/filmstrip/peaks 產生（spec §8.1）
server/src/app.ts        HTTP 路由
server/src/wsHub.ts      WS full/patch 協議
server/src/index.ts      startServer + CLI
server/src/demo.ts       demo 專案產生器
ui/src/stores/project.ts 專案狀態（patch 套用）
ui/src/stores/playback.ts 播放時鐘狀態
ui/src/ws.ts             WS client（重連 + resync）
ui/src/player/plan.ts    planAt：時間→該顯示什麼（純函數，播放器的大腦）
ui/src/player/Player.tsx A/B 雙 video 引擎
ui/src/timeline/         唯讀時間軸
```

**改動原則**：任何專案狀態的變更都必須走 `ProjectStore.mutate()`，不要旁路直改 doc——這是可觀看性、undo、衝突偵測的基礎。UI 端所有渲染都從 `useProject().doc` 這份唯一狀態衍生。

## 測試

```bash
npm test          # 全部（含真 ffmpeg 的 ingest/demo 測試，約 10 秒）
npm run typecheck # 三 workspace tsc
```

M1 共 29 個測試：shared 5、server 14、ui 10。
