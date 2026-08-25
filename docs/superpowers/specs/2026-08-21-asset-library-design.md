# 跨專案素材庫（asset library）

> **歷史文件（2026-08-21 的設計定案）**：記錄當時的決策與理由，**不隨程式碼更新**。
> 現況以 `CLAUDE.md`／`HANDOFF.md` 為準。

2026-08-21 使用者核准。需求釐清定案：

- **第一階段做「跨專案素材庫」**，是 stock／AI 生成／專案內媒體管理之後都要接上的共同地基。
- **產品線**：素材庫地基進**開源線（main）**；stock 搜尋與 AI 生成**維持既有 Pro-only 決定**
  （見 `plans/2026-08-20-ai-generation-and-stock-search.md` 開頭的邊界宣告），但必須能接在
  同一套地基上。
- **儲存語意**：**入庫即複製**（庫有自己的目錄），非零複製索引。
- **庫內容**：媒體（影／音／圖）先行；資料模型預留字型、style preset、自製 mograph 的
  `kind`，各自留待獨立成案。

## 競品研究結論（節錄，僅留影響決策的部分）

三組研究：短影音（CapCut／VN／InShot）、AI 原生（Descript／OpusClip／Captions／Veed）、
專業 NLE（Premiere／DaVinci Resolve／FCP）。

**支持本案決策的**：

- 「入庫即複製」是業界成熟答案：CapCut Space、Premiere CC Libraries、FCP managed media
  皆是；DaVinci 純引用模型乾淨但把斷鏈全留給使用者。
- 衍生檔（proxy／波形／縮圖）三家 NLE 共識：**視為可拋棄快取**，與原檔分離、可整批刪除
  lazy 重建 —— vidcut 現有 `derived/` 已是此模型。
- 組織模型：FCP 的「扁平存放 + keyword + 存成查詢的集合」公認優於 bin 資料夾樹；
  個人短影音庫規模下 tag 的投報比最高。
- AI 共用素材的標竿是 Descript 的「檢索式」：素材自帶語意元資料（逐字稿／speaker／
  visual role），AI 查庫選材不用瞎猜。Veed 的「Save to Brand Kit」反向沉澱
  （人在監修時把好東西一鍵存庫）完美貼合 vidcut「AI 剪、人監修」的閉環。
- **市場空白**：沒有任何一家給 AI 生成物做出處紀錄（OpusClip 生成 B-roll 只留 prompt
  不進庫）。`origin` 溯源欄位是 vidcut 能贏的點，剛好接 Pro 已實作的 stock import。

**明確不抄的**：Premiere 三套共享機制並存；Resolve 的資料庫囚籠（專案不落地成檔）；
匯入時 Copy／Transcode／Proxy 多模式決策樹（固定一條路即可）；CapCut 用容量分層當
付費牆（會卡死 AI 工作流）；「複製範本專案」當樣式重用（缺 preset 系統的 workaround）。

## 核心決策：內容定址複製庫 + 既有零複製引用接軌

素材庫是**伺服器上獨立於任何專案的目錄**，預設 `~/.vidcut/library/`，
環境變數 `VIDCUT_LIBRARY_DIR` 覆寫（測試靠它指到暫存目錄）：

```
~/.vidcut/library/
  library.json          # 索引，唯一狀態來源（同 project.json 哲學：落地 JSON，不用資料庫）
  files/<sha256>.<ext>  # 入庫複製的原檔，內容定址命名
  derived/<sha256>/     # proxy / filmstrip / peaks —— 可拋棄快取，可整批刪除重建
```

- **內容定址（sha256）**：同內容只存一份，入庫天然去重 —— 重複入庫是冪等操作，
  回傳既有 asset。命名對齊 Pro 雲端 R2 的 `{sha256}` 佈局：未來 Pro 同步就是
  「同步 `files/` + `library.json`」，模型不用改。
- **庫→專案引用走現有零複製語意**：匯入專案＝用「指向庫內檔案的絕對路徑」走既有
  `registerMedia` 流程，`resolveMediaPath`（`server/src/paths.ts`）一行不改。
  庫檔內容定址、永不改名不搬家，所以**引用庫檔＝不會斷鏈的零複製** ——
  「入庫即複製」與零複製哲學的接縫，兩邊不妥協。
- **derived 入庫時就生**（沿用 `prepareMedia` 管線），匯入專案時複製／硬連結進
  `projects/<p>/derived/<mediaId>/`，同一素材第二次用免跑 ffmpeg
  （ingest 約 7× 實時，是整條路的瓶頸，能省就省）。
- **併發**：工作區常態多 session 同開。`library.json` 用 temp+rename 原子寫、
  每次 mutate 前重讀。不做鎖 —— 單人本地庫，最後寫贏可接受；此風險明文記錄。

## 資料模型

新增在 `shared/src/types.ts`（與 `MediaAsset` 並列）：

```ts
interface LibraryAsset {
  id: string; // 'lib-' 前綴 + 隨機字串（比照現有 media id 產生方式），永久穩定
  kind: 'media'; // 第一階段只有 media；schema 預留 'font' | 'stylePreset' | 'mograph'
  hash: string; // sha256，同時是 files/ 與 derived/ 的定址鍵
  file: string; // 庫內相對路徑，如 'files/<hash>.mp4'
  probe: ProbeInfo; // 沿用現有型別
  label: string; // 人/AI 取的名字（「片頭 v2」「常用 BGM-輕快」）
  tags: string[]; // 扁平標籤；不做資料夾樹、不做 smart collection
  origin: { type: 'upload' | 'project' | 'source'; note?: string };
  // 預留 'stock' | 'generated'（Pro 用，含授權/prompt 溯源）
  addedAt: string;
  meta?: Record<string, unknown>;
}
```

- **組織模型 = `label + tags` 全文比對搜尋**。先例：mograph 庫 373 筆純 `.includes()`
  掃全表（Pro 線 `mographLibrary.ts`），這個規模不需要索引結構。
- **專案端溯源**：匯入時在 `MediaAsset.meta` 記 `{ libraryId, libraryHash }`。
  反向追蹤（庫記錄被哪些專案用過）**不做** —— 專案目錄可在任何地方，全域追蹤做不可靠，
  寧可不做也不做半套。
- **`LibraryStore`（`server/src/libraryStore.ts`，新）**：比照 ProjectStore 的單一
  mutate 紀律，所有庫變更走它；獨立於專案 doc，**不進 undo 堆疊**
  （與 `registerMedia` 不進 undo 的先例一致）。

## 命令層與 MCP 工具面

**鐵則的適用邊界**：庫變更不是專案狀態 → 走 `LibraryStore.mutate()`，不加 `Command`
variant。專案狀態變更（登記庫素材進專案）沿用既有 `registerMedia`，也不需要新 variant。
要守的是第三步：**每支新工具在 `server/src/mcp.ts` 手動 `registerTool` 並同步
instructions**；`mcp-surface-snapshot` 會紅，先讀 diff 確認描述屬實再 `-u`。

新增 MCP 工具四支：

| 工具                   | 行為                                                                                     | 備註                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `list_library`         | 搜尋庫：`query`（對 label+tags 比對）、`tag`、`kind`、`limit`（預設 20、上限 50）        | 唯讀，比照 `search_mograph_library` 不走 command；筆數上限防灌爆 context（同 `list_source` 的教訓）                        |
| `add_to_library`       | 入庫：`{ path }`（本機絕對路徑）或 `{ mediaId }`（專案內既有素材），可帶 `label`、`tags` | 複製→hash→去重→生 derived→寫索引；同 hash 冪等回傳既有 asset                                                               |
| `import_from_library`  | `{ assetId, addToTimeline? }` → 複製 derived 進專案 + `registerMedia`                    | `addToTimeline` 語意與 `import_media` 一致（audio-only 被 `addClip` 擋的既有限制不在本案處理，見 ROADMAP「音訊素材支援」） |
| `update_library_asset` | 改 `label` / `tags`                                                                      | 元資料是 AI 選材的依據，要讓 AI 自己維護得動                                                                               |

- **刻意不做 `remove_from_library`（MCP）**：庫檔可能被任何專案引用，AI 誤刪的代價是
  別的專案輸出斷鏈，且沒有跨專案用量追蹤。刪除只給人類 UI，確認框寫明後果。
- **工具描述紀律**（照 2026-08-20 生成計畫 §1.1 既定規矩）：`add_to_library` 描述要求
  給描述性 `label`、建議掛 `tags`；`import_from_library` 描述講明「查與拿是兩步」——
  先 `list_library` 確認再匯入。

## HTTP 路由與 UI

**路由**（`server/src/app.ts`）：

- `GET /api/library?query=&tag=` —— 搜尋（UI 用，不設 MCP 那個小上限）
- `POST /api/library` —— 上傳入庫。**`req.pipe` 串流寫檔**，不走 `express.raw`：
  ROADMAP「上傳路徑串流化」實測 300MB 檔 `arrayBuffer()` 吃 300MB 記憶體、串流只要
  1MB；庫素材（片頭、BGM）遠大於疊圖的 20MB 上限，一開始就做對
- `PATCH /api/library/:id`、`DELETE /api/library/:id` —— 改 label/tags、刪除
  （連 `files/` 與 `derived/` 一起清）
- `POST /api/library/:id/import` —— 匯入目前專案
- `GET /library/*` —— 靜態服務庫目錄（UI 預覽／縮圖／試聽），比照 `/media/*`

**UI：右側面板新增 `Media` 分頁**（現況只有 captions／properties，`ui/src/App.tsx`），
內部三區 —— 同時收掉 ROADMAP 素材匯入「階段 2」欠的專案媒體 UI；三分區呼應
CapCut Space 驗證過的心智模型：

1. **專案媒體**：`Project.media[]` 清單（縮圖／時長／label、來自素材庫的掛標記），
   點選加到時間軸；每列有「存入素材庫」鈕 —— Veed 式反向沉澱：AI 匯入的好素材，
   人監修時一鍵入庫。
2. **素材庫**：搜尋框 + 標籤 chip 過濾、拖曳上傳、卡片縮圖／試聽、「匯入專案」、
   label/tags 就地編輯、刪除（帶後果確認）。
3. **素材夾**：既有 `GET /api/source` 掃描 + 勾選匯入（ROADMAP 階段 2 原案），
   每列另有「直接入庫」。

視覺遵循 `ui/DESIGN.md`；改 UI 後 `npm run build -w @vidcut/ui` 鐵則照舊。

## 錯誤處理

- **入庫全有全無**：複製原檔→算 hash→生 derived→寫索引，任一步失敗就清掉已落地檔案
  （比照 Pro 線 stock import「任何失敗路徑都刪檔」與雲端「半套狀態是延遲引爆的資料
  遺失」紀律）。索引 temp+rename，程序中途死掉不會留壞的 `library.json`。
- **hash 一致性**：庫檔不可變、derived 以內容 hash 定址，不存在「derived 對不上原檔」
  的狀態。
- **啟動自癒**：載庫時索引有記錄但 `files/` 缺檔 → 標記壞（列出但拒絕匯入）；
  `derived/` 缺檔 → 匯入時 lazy 重建。
- **路徑安全**：`/library/*` 與帶 id 路由先 `path.normalize` 再驗 containment
  （雲端線 `media/./a.mp4` 變體教訓）；`add_to_library` 的 `path` 只收絕對路徑並過
  白名單副檔名（`sourceFolder.ts` 同一組）。

## 測試（TDD，真 ffmpeg）

- `libraryStore.test.ts` —— 入庫／去重冪等／搜尋／改標籤／刪除／原子寫／壞索引恢復
- `library-api.test.ts` —— 全部路由（五條 `/api/library*` + `/library/*` 靜態），
  含串流上傳大檔與 containment 攻擊路徑
- `import-from-library.test.ts` —— 匯入後 `meta.libraryId` 溯源、derived 複用
  （第二次匯入不重跑 ffmpeg，以 mtime 驗證）
- MCP 面：`mcp-surface-snapshot` 更新（先讀 diff）；工具行為測試比照 `import_media` 組
- UI：`verify:panels` 加 Media 分頁控制項 case

## 分期交付

每期獨立可交付、可驗收：

1. **庫核心**：`LibraryStore` + 儲存佈局 + 四支 MCP 工具 + HTTP 路由。
   做完 AI 即可用完整素材庫，不必等 UI。
2. **Media 面板**：三區 UI + 反向沉澱 + 刪除。

**後續獨立成案（不在本 spec）**：`kind: 'stylePreset'`（字幕／overlay 樣式預設，補
CapCut caption 不能存 preset 的公認缺口）、`kind: 'font'`（牽動字幕渲染管線）、
relink 與專案打包（ROADMAP 既有項）。

## Pro 接點（本 spec 只留縫，不實作）

- `origin.type` 預留 `'stock' | 'generated'`：Pro 的 `import_stock_media` 與生成管線
  落庫時帶授權／prompt 溯源 —— 競品全缺的一塊。
- `files/<sha256>` 佈局 = R2 同步單位，Pro 雲端個人庫直接映射
  `{userId}/library/{sha256}`。
- brand kit = 未來一個 `stylePreset` 集合 + 一支 `get_brand_kit` 唯讀工具
  （Descript「宣告式偏好包」路線），屬 Pro。
- 自製 mograph 入庫（`kind: 'mograph'`）留在 Pro 線 —— mograph 能力本身是 Pro。
