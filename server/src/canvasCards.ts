// server/src/canvasCards.ts — 改畫布尺寸之後的字卡重烤與孤兒清理。
//
// 為什麼需要一個獨立的協調器：畫布寬進字卡的內容定址 key（`cardKey` 的 `w` 欄位），
// 所以 `setCanvas` 一成立，**專案裡每一張字卡的 hash 都變了**。兩條重烤路線本來就
// 各自存在，但都不是由畫布變更觸發的：
//
//   - 字幕：`CaptionCardSync.runNow()` 每輪都重讀 `store.doc.canvas.width`，
//     邏輯本身自動成立，缺的只是有人叫它。
//   - 文字 overlay：`imagePath` 烤在 doc 裡，要靠 `refreshTextOverlayCards()` 重解析；
//     它原本只在啟動時跑一次（給光柵器升版用）。
//
// 這裡把兩者串起來，**跑完之後**再掃一次孤兒。順序不能反：清理是「刪掉沒有被任何
// imagePath 指到的檔案」，重烤還沒跑完的話新卡尚未存在、舊卡也還被 doc 指著，
// 掃出來的集合毫無意義，而且會刪掉正要被重用的卡。
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectStore } from './store.js';
import type { CaptionCardSync } from './cardSync.js';
import type { TextCardService } from './textCards.js';
import { refreshTextOverlayCards } from './textOverlays.js';

/** `derived/text/` 底下一張卡的三種副檔名（見 TextCardService.ensure）。 */
const CARD_FILE_RE = /^([0-9a-f]{16})\.(base\.png|hl\.png|json)$/;

/**
 * 掃 `derived/text/`，刪掉 hash 不在 `liveHashes` 裡的檔案。回傳刪掉幾個檔。
 *
 * ⚠️ **只掃 `derived/text/`**，那是 `TextCardService` 唯一的落點（`dirAbs()`）。
 * `derived/captions/` 是匯出時燒字用的、以 caption id 命名、每次 render 直接覆寫，
 * 不是內容定址，不歸這裡管。
 *
 * ⚠️ **為什麼刪掉是安全的**：字卡是內容定址的——同一份輸入永遠算出同一把 key、
 * 落在同一個檔名。使用者按 undo 把畫布換回去，舊 hash 會原封不動地重新算出來，
 * 檔案不在就當快取未命中重畫一次（`TextCardService.ensure` 的 miss 分支）。
 * 也就是說這裡刪掉的東西沒有一樣是「刪了就回不來」的，最壞情況只是多花一次繪圖。
 *
 * 認不得的檔名（不符 `CARD_FILE_RE`）一律**保留**：這個掃描只對自己產的東西負責，
 * 別人放在這個目錄裡的檔案不是我們該處理的。
 *
 * 刪除失敗（權限、剛好被別的路徑刪掉、檔案系統打嗝）不能讓整條流程失敗——
 * 孤兒檔只是佔空間，遠不如把使用者剛做的畫布變更弄成錯誤來得嚴重。逐檔吞掉並 warn。
 */
export async function sweepOrphanCards(
  projectDir: string,
  liveHashes: ReadonlySet<string>,
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(join(projectDir, 'derived', 'text'));
  } catch {
    return 0; // 目錄還不存在（專案沒有任何字卡）＝沒有孤兒
  }
  let removed = 0;
  for (const name of names) {
    const m = CARD_FILE_RE.exec(name);
    if (!m || liveHashes.has(m[1]!)) continue;
    try {
      await unlink(join(projectDir, 'derived', 'text', name));
      removed++;
    } catch (e: unknown) {
      console.warn(`⚠ Orphan card ${name}: could not remove: ${(e as Error).message}`);
    }
  }
  return removed;
}

/** 從 doc 的 overlay `imagePath` 反推 hash（`derived/text/<hash>.base.png`）。 */
function overlayCardHashes(store: ProjectStore): string[] {
  const out: string[] = [];
  for (const o of store.doc.tracks.overlays) {
    const m = /([0-9a-f]{16})\.base\.png$/.exec(o.imagePath);
    if (m) out.push(m[1]!);
  }
  return out;
}

/**
 * 改畫布尺寸後的完整善後：重烤字幕字卡 → 重解析文字 overlay 字卡 → 清孤兒。
 *
 * 全程不 throw：呼叫端是同步的 patch 監聽器，這裡任何一段炸掉都只該變成一行 warn。
 * 字幕那段的單句錯誤已經在 `runNow` 內吞掉、overlay 那段在 `refreshTextOverlayCards`
 * 內逐張吞掉，這裡只是最外層的保險。
 */
export async function refreshCardsForCanvas(
  projectDir: string,
  store: ProjectStore,
  cardSync: CaptionCardSync,
  textCards: TextCardService,
): Promise<{ removed: number }> {
  // 1. 字幕。用 `runNow()` 而不是 `schedule()`：清理必須排在重烤**之後**，
  //    而 debounce 的排程沒有完成訊號可以等。
  const entries = await cardSync.runNow();
  // 2. 文字 overlay。會改寫 doc 的 imagePath，所以要在讀 live hash 之前跑完。
  await refreshTextOverlayCards(textCards, store);
  // 3. 清孤兒。live 集合 = 字幕這輪真的產出來的 hash ∪ doc 上 overlay 現在指著的 hash。
  //    字幕取 `entries` 而不是重算，是為了涵蓋「某句烤失敗（沒進 entries）」的情況——
  //    那句沒有卡，也就沒有東西要保留。
  const live = new Set<string>([...entries.map((e) => e.hash), ...overlayCardHashes(store)]);
  const removed = await sweepOrphanCards(projectDir, live);
  return { removed };
}
