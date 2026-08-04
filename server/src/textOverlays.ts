// server/src/textOverlays.ts — 文字 overlay 的「命令前置」:產卡並把 imagePath 併進同一個命令。
// 這樣 applyCommand 仍是同步、一次 mutate 內 text 與 imagePath 原子生效(spec §6)。
import type { Command, OverlayText } from '@vidcut/shared';
import type { ProjectStore } from './store.js';
import type { CardRequest } from './rasterizer.js';
import type { TextCardService } from './textCards.js';
import { cardRequestError } from './cardBudget.js';

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
