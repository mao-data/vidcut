// server/src/textOverlays.ts — 文字 overlay 的「命令前置」:產卡並把 imagePath 併進同一個命令。
// 這樣 applyCommand 仍是同步、一次 mutate 內 text 與 imagePath 原子生效(spec §6)。
import type { Command, OverlayText } from '@vidcut/shared';
import type { ProjectStore } from './store.js';
import type { CardRequest } from './rasterizer.js';
import type { TextCardService } from './textCards.js';
import { cardRequestError } from './cardBudget.js';
import { applyCommand } from './commands.js';

export function overlayTextToCardRequest(t: OverlayText, canvasWidth: number): CardRequest {
  return {
    text: t.text,
    style: {
      fontFamily: t.fontFamily,
      fontSize: t.fontSize,
      fill: t.fill,
      ...(t.stroke ? { stroke: t.stroke } : {}),
    },
    width: canvasWidth,
    maxWidthFrac: t.maxWidth ?? 0.9,
  };
}

/**
 * 超出像素預算就別產卡：跟「overlay 不存在」「目標是純圖 overlay」同一個模式——
 * 這裡靜靜跳過，讓命令層用它那套 {ok:false,error} 回一句可讀的拒絕理由。
 * 直接在這裡產卡的話，svc.ensure 會 throw，呼叫端（WS / MCP）只會看到一句
 * 「字卡產生失敗」外面再包一層 stack，而不是「這張卡有幾行、超了多少」。
 */
function overBudget(t: OverlayText, canvasWidth: number): boolean {
  return cardRequestError(overlayTextToCardRequest(t, canvasWidth)) !== null;
}

/**
 * 啟動時把文字 overlay 的字卡重新解析一次，`imagePath` 對不上就更新。
 *
 * 為什麼需要：字卡是內容定址的，`imagePath` 在命令套用當下就烤進了 project.json。
 * 光柵器行為改變（`PillowRasterizer.id` 往上加號碼）之後，新的 key 會變，但**既有專案
 * 裡那些 imagePath 仍指著舊 hash 的檔案**，而且使用者在 UI 上重打一模一樣的字也救不回來
 * （同輸入→同 key→命中舊卡）。沒有這道重解析，換行這種修正對已存檔的作品等於沒發生。
 *
 * 走 applyCommand（鐵則：任何狀態變更都走命令層），但**只在 hash 真的變了才送命令**，
 * 所以第二次啟動起是完全靜默的 no-op。單張失敗不影響其餘（產卡可能因預算或 worker
 * 掛掉而失敗），錯誤只記 warn。
 *
 * 三件事情是這道遷移的正確性關鍵，改動時請一併讀完：
 *
 * 1. **只 patch `imagePath`，不送 `text`。** 送 text 的話它就不只是修一個指標，而是
 *    「把我開檔那一刻讀到的文字寫回去」——使用者在產卡的空檔改了字，這裡就把他的編輯
 *    覆蓋掉了。要修的是衍生資料，那就只寫衍生資料那一格。
 *
 * 2. **`await` 之後重讀 doc，而且用 `keyOf` 判斷「這張卡現在還是它要的嗎」。** 產卡要
 *    spawn Pillow，overlay 多的話累積好幾秒，正好落在使用者剛開檔開始動手的那段時間；
 *    迴圈開頭抓的那份快照到這裡已經可能過期。判斷與 `applyCommand` 之間沒有 `await`
 *    ——Node 單執行緒，同一個同步 tick 內插不進別的命令，所以「檢查」與「寫入」之間
 *    沒有縫。文字被改掉的那些，改字那條路徑（resolveTextCommand）本來就會產自己的新卡，
 *    這裡跳過才是對的。`keyOf` 一併涵蓋了樣式與畫布寬度變動，比只比對 text 精確。
 *
 * 3. **`runWithoutUndo`**：這是系統維護，不是使用者的編輯。理由見 store.ts 該方法的註解。
 */
export async function refreshTextOverlayCards(
  svc: TextCardService,
  store: ProjectStore,
): Promise<number> {
  const ids = store.doc.tracks.overlays.filter((o) => o.text).map((o) => o.id);
  let changed = 0;
  for (const id of ids) {
    const before = store.doc.tracks.overlays.find((o) => o.id === id);
    if (!before?.text) continue; // 開檔後隨即被刪掉／被改成純圖 overlay
    try {
      const r = await svc.ensure(overlayTextToCardRequest(before.text, store.doc.canvas.width));
      // ↓ 以下到 applyCommand 為止不得再有 await（見上方第 2 點）。
      const cur = store.doc.tracks.overlays.find((o) => o.id === id);
      if (!cur?.text) continue;
      if (svc.keyOf(overlayTextToCardRequest(cur.text, store.doc.canvas.width)) !== r.hash)
        continue;
      const next = svc.relBasePath(r.hash);
      if (next === cur.imagePath) continue;
      const res = store.runWithoutUndo(() =>
        applyCommand(store, 'human', { name: 'updateOverlay', id, patch: { imagePath: next } }),
      );
      if (res.ok) changed++;
      else console.warn(`⚠ 文字 overlay ${id} 的字卡重新解析被拒：${res.error}`);
    } catch (e: unknown) {
      console.warn(`⚠ 文字 overlay ${id} 的字卡重新解析失敗：${(e as Error).message}`);
    }
  }
  return changed;
}

export async function resolveTextCommand(
  svc: TextCardService,
  store: ProjectStore,
  cmd: Command,
): Promise<Command> {
  if (cmd.name === 'addOverlay' && cmd.overlay.text) {
    if (overBudget(cmd.overlay.text, store.doc.canvas.width)) return cmd;
    const r = await svc.ensure(overlayTextToCardRequest(cmd.overlay.text, store.doc.canvas.width));
    return { ...cmd, overlay: { ...cmd.overlay, imagePath: svc.relBasePath(r.hash) } };
  }
  if (cmd.name === 'updateOverlay' && cmd.patch.text) {
    // overlay id 不存在的話 applyCommand 反正會擋掉(overlay not found)——
    // 別浪費一次產卡,原樣放行讓既有的「找不到」錯誤照舊產生。
    // 目標不是文字 overlay(沒有 text 欄位)時同理:命令層會拒絕(不把純圖 overlay
    // 轉成文字卡),這裡先產卡只會在 derived/text/ 留下一張沒人用的孤兒卡。
    const target = store.doc.tracks.overlays.find((o) => o.id === cmd.id);
    if (!target || !target.text) return cmd;
    if (overBudget(cmd.patch.text, store.doc.canvas.width)) return cmd;
    const r = await svc.ensure(overlayTextToCardRequest(cmd.patch.text, store.doc.canvas.width));
    return { ...cmd, patch: { ...cmd.patch, imagePath: svc.relBasePath(r.hash) } };
  }
  if (cmd.name === 'setOverlays') {
    // 整組替換：文字 overlay 各自獨立產卡(可平行),沒帶 text 的原樣放行。
    // 陣列裡完全沒有 text overlay 時回同一個 cmd 參考(呼叫端可用 === 判斷「沒變」)。
    if (!cmd.overlays.some((o) => o.text)) return cmd;
    const overlays = await Promise.all(
      cmd.overlays.map(async (o) => {
        if (!o.text) return o;
        if (overBudget(o.text, store.doc.canvas.width)) return o;
        const r = await svc.ensure(overlayTextToCardRequest(o.text, store.doc.canvas.width));
        return { ...o, imagePath: svc.relBasePath(r.hash) };
      }),
    );
    return { ...cmd, overlays };
  }
  return cmd;
}
