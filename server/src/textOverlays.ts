// server/src/textOverlays.ts — 文字 overlay 的「命令前置」:產卡並把 imagePath 併進同一個命令。
// 這樣 applyCommand 仍是同步、一次 mutate 內 text 與 imagePath 原子生效(spec §6)。
import type { Command, OverlayText } from '@vidcut/shared';
import type { ProjectStore } from './store.js';
import type { CardRequest } from './rasterizer.js';
import type { TextCardService } from './textCards.js';

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

export async function resolveTextCommand(
  svc: TextCardService,
  store: ProjectStore,
  cmd: Command,
): Promise<Command> {
  if (cmd.name === 'addOverlay' && cmd.overlay.text) {
    const r = await svc.ensure(overlayTextToCardRequest(cmd.overlay.text, store.doc.canvas.width));
    return { ...cmd, overlay: { ...cmd.overlay, imagePath: svc.relBasePath(r.hash) } };
  }
  if (cmd.name === 'updateOverlay' && cmd.patch.text) {
    // overlay id 不存在的話 applyCommand 反正會擋掉(overlay not found)——
    // 別浪費一次產卡,原樣放行讓既有的「找不到」錯誤照舊產生。
    if (!store.doc.tracks.overlays.some((o) => o.id === cmd.id)) return cmd;
    const r = await svc.ensure(overlayTextToCardRequest(cmd.patch.text, store.doc.canvas.width));
    return { ...cmd, patch: { ...cmd.patch, imagePath: svc.relBasePath(r.hash) } };
  }
  return cmd;
}
