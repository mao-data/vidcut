# 素材匯入的 MCP 面補完 + 文件/維護收尾

2026-08-03 使用者核准。承接 `2026-08-03-media-import-design.md` 階段 1。

## 為什麼要做

階段 1 的 spec 明寫「**做完即可透過 MCP 使用，不必等 UI**」。實際盤點後這句沒兌現 ——
29 個 MCP 工具裡沒有任何一個碰得到這次做的後端能力：

| 後端能力             | HTTP                  | MCP       | 實際使用者         |
| -------------------- | --------------------- | --------- | ------------------ |
| `scanSourceFolder`   | `GET /api/source` ✅  | ❌ 無工具 | 無（UI 也沒接）    |
| 批次零複製匯入       | `POST /api/import` ✅ | ❌ 無工具 | 無                 |
| `addClip` 接到主軌尾 | command ✅            | ❌ 無工具 | 只有 `/api/import` |

八輪 TDD + 全分支審查做出來的能力，目前沒有任何使用者觸得到。本案補上 MCP 面，
順帶收掉盤點時發現的文件與維護債。

**根因**：`CLAUDE.md` 的鐵則寫「加 Command variant → `commands.ts` 加驗證與 case →
UI 與 MCP **自動**都能用」。第三步不會自動發生（MCP 工具要手動 `registerTool`），
這條錯誤的鐵則直接造成了本次要補的缺口。因此鐵則本身也在修改範圍內。

## Tier 與失敗模型

**old-coder Tier 2（一般）。** 新增的是既有已驗證能力的薄殼：`add_clip` 包
`addClip` command（八輪審查、有 mutant），`list_source` 包 `scanSourceFolder`
（12 條測試，敵意輸入已覆蓋）。不是 Tier 3——沒有新的磁碟讀取面
（`list_source` 走的是 `GET /api/source` 已經開的同一條路）、沒有金流／認證／資料遺失。
唯一有新語意的是 `setAudio` 補驗證，它是本案唯一的行為變更。

| 失敗模式                                         | 抓得到它的層                                                    |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `add_clip` 繞過 `aiWrite`（審核進行中也能寫）    | MCP 測試：審核中呼叫 → 必須被拒                                 |
| `add_clip` 的 `ifVersion` 沒接上（覆蓋人的修改） | MCP 測試：過期 `ifVersion` → 必須被拒                           |
| `add_clip` 回的 clipId 不是新那一個              | MCP 測試：斷言回覆裡的 id === `tracks.video.at(-1).id`          |
| `setAudio` 新驗證擋掉本來合法的輸入（回歸）      | 既有 `mcp-tools.test.ts` / `mcp-optim.test.ts` 兩條 `set_audio` |
| `setAudio` 驗證寫了但沒作用                      | 新 mutant `setaudio-validate`                                   |
| `list_source` 洩漏素材夾以外的東西               | 沿用 `sourceFolder.test.ts` 既有敵意輸入測試                    |
| 大素材夾灌爆 AI context                          | 截斷測試 + 新 mutant `listsource-truncate`                      |
| 文件數字再度腐爛                                 | 常駐文件不再寫數字（見下）——移除來源而非加檢查器                |

**不覆蓋（記為已知限制）**：`list_source` 對超大目錄仍是同步 `readdir` + 逐檔 `stat`
（階段 1 既有限制，本案不改）。

## 範圍

### 做

**1. `list_source(dir)` —— 新 MCP 工具**

薄殼包 `scanSourceFolder(dir)`，另回 `imported` 標記（比對 `doc.media` 解析後的
絕對路徑），回應形狀與 `GET /api/source` 一致。標 `readOnlyHint: true`。

`dir` 為**絕對路徑**（與 `GET /api/source` 的 `dir` 同語意）。不做根目錄白名單——
server 綁 `127.0.0.1`，且限制會擋到使用者自己的素材（階段 1 spec 已核准的取捨）。
AI 本來就有自己的檔案系統工具，這個工具不構成新的能力升級。

超過 `MAX_FILES_INLINE = 200` 筆時只內嵌前 200 筆並回 `truncated: true` 與 `total`，
沿用 `transcribe` 的 `MAX_WORDS_INLINE` 慣例（`mcp.ts:160`）。

**2. `add_clip(mediaId, in, duration, label?, ifVersion?)` —— 新 MCP 工具**

走 `aiWrite` → `applyCommand`（**不是**直接 `store.mutate`；`set_timeline` 的直接
mutate 是既有例外，不再複製）。驗證全部沿用 command 層現有五道，MCP 層不重複驗。

成功後回覆文字附上新 clip 的 id：讀 `store.doc.tracks.video.at(-1)!.id`
（`addClip` 語意就是 append 到尾端）。**不改 `CommandResult` 型別**——把
`{ok, version}` 撐寬成能帶 clipId 會波及整個 codebase，代價與收益不成比例。

**3. `setAudio` 補驗證 —— 本案唯一的行為變更**

現況 `d.tracks.audio = cmd.audio` 零驗證。實測：打錯的 `mediaId` 被接受 → 落盤 →
重啟後 `undo` 回「nothing to undo」 → 直到 render 才丟
`render: media not found for audio bgm1`（且訊息報的是 audio item id，不是那個
找不到的 `mediaId`）。

補成與 `addClip` 對稱，**逐項**驗證：

- `mediaId` 必須存在於 `doc.media`
- `duration > 0`
- `in >= 0`
- `in + duration <= media.probe.duration + 1e-6`（容差與 `addClip` 一致，
  避免浮點誤差誤殺「剛好用滿素材長度」的合法輸入）

> **`audio: []` 必須繼續合法。** 那是清空音訊軌的慣用法，`mcp-tools.test.ts:174`
> 正在用。逐項驗證天然滿足（空陣列沒有項目要驗），但實作時極易寫成「必須非空」
> 而打破既有測試——這是本節最容易做錯的地方。

**已查證的影響面**：全 repo 只有兩處呼叫 `set_audio`（`mcp-optim.test.ts:262` 傳
真實 `mediaId`、`mcp-tools.test.ts:174` 傳 `[]`），兩處新驗證都會過；UI 完全不走
`setAudio`（`Inspector.tsx` / `Timeline.tsx` 只讀，寫走 `updateAudio` /
`removeAudio` / `extractAudio`）。沒有任何地方在做「先塞 audio item、之後再補素材」。
**正常路徑零影響，只有本來會被默默接受的壞資料開始被拒。**

**4. `render.ts:221` 錯誤訊息補上 `mediaId`**

`render: media not found for audio ${a.id}` → 同時帶上找不到的 `mediaId`，
否則拿到錯誤的人還要自己翻 `project.json`。

**5. MCP `instructions` 同步（`CLAUDE.md` 鐵則要求）**

- 典型流程補素材夾這段：`list_source 看素材夾 → import_media 匯入（吃專案外絕對
路徑）→ add_clip 接到軌尾`
- 補純音訊語意：純音訊素材只能走 `set_audio`，`add_clip` / `set_timeline` 會擋

**6. `CLAUDE.md` 鐵則修正**

「UI 與 MCP 自動都能用」改成明確三步，並標註第三步**不會自動發生**：
新增 command variant 後必須手動 `registerTool` 並同步 `instructions`。

**7. 常駐文件去數字化**

| 文件                                     | 性質                | 數字政策                                   |
| ---------------------------------------- | ------------------- | ------------------------------------------ |
| `EVIDENCE.md`                            | 快照，帶 commit SHA | **保留**具體數字，過期正常且無害           |
| `HANDOFF.md` / `README.md` / `CLAUDE.md` | 常駐                | **不寫**會過期的數字，改指跑 `gauntlet.sh` |

要改的三處：`HANDOFF.md:18`（「143 個測試（shared 27 / server 86 / ui 30）」，實際
412／27／215／170）、`HANDOFF.md:12`（「MCP server（15 工具）」）、`HANDOFF.md:141`
（「23 個 MCP 工具」，實際 29——且與 `:12` 自相矛盾）。同一份文件兩個數字互相打架，
正好證明手寫數字撐不住。**移除來源，不加檢查器**：多一支 script 就多一份要維護的東西。

**8. ROADMAP 修正與技術債歸檔**

- 第 9 條「剩下掛上音訊軌那半」不準——實測 `import_media(絕對路徑 .mp3)` +
  `set_audio` 已通並渲染成功（`set_audio` 的 schema 本來就吃 `mediaId`）。
  缺的只有 `/api/import` 的 `addToTimeline` 分流。
- `progress.md` 的 14 條 deferred minor 只活在分支的 `.superpowers/sdd/`，分支收掉
  就蒸發。挑仍有效的併進 ROADMAP 既有「可行方向」區塊：`commands.ts:155/:497` 的
  `1e-6` 無 mutant 覆蓋、Origin／Host header 檢查、無全域 ffmpeg 佇列、
  `/api/import` 的 `failed[]` 語意、素材夾權限分支無測試。其餘（純報告瑕疵類）丟棄。
- **不新開 `DEBT.md`**：多一份文件就多一份會腐爛的文件。

### 不做（YAGNI／另案）

- **UI 素材庫面板**——階段 1 spec 的階段 2，另開子專案。
- **`import_source` 批次匯入工具**——`POST /api/import` 的價值是「一次選多檔 +
  跨請求序列」，AI 本來就是序列呼叫 `import_media`，包了是重複路徑。
- **`addAudio` command 與 `/api/import` 的音訊分流**——產品決策，留 ROADMAP。
- **`set_timeline` 改走 `applyCommand`**——既有例外，動它超出本案範圍。

## 驗收條件（可執行）

### `list_source`

1. 素材夾有 3 支白名單檔 → 回 3 筆，含 `name` / `size` / `mtime`，依 name 排序
2. 其中一支已匯入 → 該筆 `imported: true`，其餘 `false`
3. 已匯入的是相對路徑素材 → `imported` 仍正確（解析後比對）
4. 目錄不存在 → 回 `isError`，訊息可讀
5. 250 支檔 → 只內嵌前 200 筆，`truncated: true`，`total: 250`
6. 工具 metadata 標 `readOnlyHint: true`

### `add_clip`

7. 合法呼叫 → `ok`，`tracks.video` 尾端多一個 clip，回覆文字含新 clip 的 id
8. 回覆裡的 id === `tracks.video.at(-1).id`
9. `mediaId` 不存在 → `isError`
10. 純音訊素材（`hasVideo: false`）→ `isError`，訊息含 `audio-only`
11. `in + duration` 超過素材長度 → `isError`
12. 審核進行中 → `isError`（`aiWrite` 守衛生效）
13. 過期 `ifVersion` → `isError`（`aiWrite` 守衛生效）

### `setAudio` 驗證

14. `audio: []` → `ok`，音訊軌清空（**既有行為必須不變**）
15. 合法 item（真實 `mediaId`、在界內）→ `ok`
16. `mediaId` 不存在 → `ok: false`，音訊軌**維持原樣**（不得半套寫入）
17. `duration <= 0` → `ok: false`
18. `in < 0` → `ok: false`
19. `in + duration` 剛好等於素材長度 → `ok`（1e-6 容差保護）
20. 多個 item 其中一個壞 → 整批拒，音訊軌維持原樣

### 錯誤訊息

21. `tracks.audio` 有壞 `mediaId` 時 render → 錯誤訊息同時含 audio item id 與 `mediaId`

### 不得破壞的既有不變式（負向約束）

- 既有 412 條測試零新增失敗
- `set_audio` 的兩條既有測試不得修改斷言
- `scripts/gauntlet.sh` 不得放寬任何關卡
- 不得動 `sourceFolder.ts` 的白名單、`commands.ts:155/:497` 的 `1e-6`
- 不得為配合文件而加無意義的程式碼（反之亦然：程式碼沒有的檢查不得寫進文件）

## Gauntlet 計劃

跑完整 `bash scripts/gauntlet.sh`（非 `--fast`）。新增 3 隻 mutant：

| id                    | 突變                                            | 該紅的測試                |
| --------------------- | ----------------------------------------------- | ------------------------- |
| `addclip-mcp-aiwrite` | `add_clip` 的 `aiWrite` 換成直接 `applyCommand` | 審核中 / `ifVersion` 兩條 |
| `setaudio-validate`   | 拿掉 `setAudio` 的逐項驗證迴圈                  | 驗收 16–20                |
| `listsource-truncate` | 拿掉 200 筆截斷                                 | 驗收 5                    |

數字寫進 `EVIDENCE.md` 新補記，引用的那次執行必須在最後一次程式碼修改之後。

## 設定計劃

- **無新依賴。** 全部用既有的 `@modelcontextprotocol/sdk`、`zod`、`vitest`。
- **無新工具。** gauntlet 既有八關已足夠。
- **git**：在既有 worktree `media-import-backend` 上續做，每個 Task 一個 commit，
  只 stage 動過的路徑（`CLAUDE.md` 鐵則：不得 `git add -A`）。
- **不動 `main`**，也不碰 `caption-wysiwyg` 工作區。

## 待使用者決定（不阻擋本案）

- 分支收尾：`main` 是否快轉到本分支（目前分支已含 `main` 全部內容，可無衝突快轉）
- `/api/import` 帶 `addToTimeline` 匯純音訊時是否改成自動掛音訊軌（需新 `addAudio`
  command，屬產品決策）
