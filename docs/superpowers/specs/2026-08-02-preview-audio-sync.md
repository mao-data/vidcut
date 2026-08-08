# 預覽音訊 seek 風暴修正 — SPEC

> **歷史文件（2026-08-02 的設計定案）**：記錄當時的決策與理由，**不隨程式碼更新**。
> 現況以 `CLAUDE.md`／`HANDOFF.md` 為準。

日期：2026-08-02。範圍：`ui/src/player/`（新增 `sync.ts`）＋驗收探針。Tier 2。
授權：使用者回報預覽雜音 → 診斷證實 seek 風暴（4.5s 內 audio/video 各 41 次
seek＋waiting，間隔 ~83ms）→ 計劃已提出並獲「好」核准。

## 根因（已證實）

rAF 主時鐘與 media 元素時鐘無耦合；偏差 >60ms 即硬 seek `currentTime`。
seek 後解碼器重啟延遲使偏差再次超標 → 永久循環。兩條斷續音軌疊加＝「混雜雜音」。
證據：headless 探針（`scripts/audio-probe.mjs`）；渲染成品已量測無削波（另案）。

## 行為

### B1 syncAction 純函式（`ui/src/player/sync.ts`）

`syncAction(drift)`，drift = 目標時間 − 元素 currentTime（秒）：

- `|drift| ≥ 0.25` → `{kind:'seek'}`（使用者拖 playhead、換片段等大跳）
- `|drift| ≤ 0.02` → `{kind:'rate', rate: 1}`（死區：復速）
- 其間 → `{kind:'rate', rate: 1 + clamp(drift × 0.5, ±0.08)}`
  （比例調速：落後加速、超前減速；上限 ±8%，`preservesPitch` 預設下人耳難察）
- 邊界值：0.25 屬 seek、0.02 屬復速。rate 保留 3 位小數內的精確比例值。

### B2 Player 接線（playing 時三處媒體全走 syncAction）

- 音訊軌 `<audio>`、active `<video>`、blur 背景 `<video>`：
  playing 時以 syncAction 取代「>60ms 硬 seek」；`kind:'rate'` 只寫
  `playbackRate`（值不同才寫），**不寫 currentTime**；`kind:'seek'` 寫
  currentTime 並把 playbackRate 復位 1。
- **paused 時維持既有行為**（偏差 >60ms 直接 seek）：暫停下拖 playhead
  必須立即跳幀，且無播放可調速。
- seek／swap／premount 後 playbackRate 復位 1（spare 起播不得帶殘留調速）。

### B3 驗收探針（`scripts/audio-probe.mjs`，收進 repo）

- 對 http://127.0.0.1:3845 播放 4.5s，統計 media 元素 seeking/waiting。
- 修正前基線：seeking 41+41、waiting 41+40（見 EVIDENCE）。
- 修正後目標：**seeking 合計 ≤ 4**（起播容許）、無週期性 waiting 風暴。
- headless 無實體音訊裝置，媒體時鐘偏移比真機誇張——本探針是「同環境前後對照」，
  不是絕對聽感證明；最終聽感親驗。

## 不變式

- 全部既有測試零新增失敗（尤其 Player.test.tsx 的 A/B 交換與音量斷言）。
- 不動渲染端、不動 DUCK_LEVEL（殘留原聲問題另案，待使用者修後聽感回報）。
- 播放效能架構不變（僅 3 個小元件訂閱 60fps time）。

## 設定計畫

- **新 devDependency：`playwright-core`（root）**——驗收探針驅動 headless
  Chromium 用（瀏覽器用既有 ms-playwright 快取，不下載）。微軟官方套件、
  僅 dev、npm audit 納管。此為本案唯一新依賴。
- git：沿用 checkpoint 節奏；`scripts/mutants.json` 加 4 隻（門檻/方向/死區/接線）。
- 修完 `npm run build`（ui）讓 :3845 服務新版。

## 已知限制

- ±8% 調速在極端媒體時鐘故障（如 headless 空音訊裝置）下收斂慢，
  屆時退化為每 ~0.5s 一次 seek——仍遠優於現況 83ms 一次。
- 不做媒體元素為主時鐘的架構改造（影響 A/B 引擎與 karaoke，收益不成比例）。
