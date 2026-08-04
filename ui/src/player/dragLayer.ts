// 預覽畫布拖曳數學：純函式，不碰 DOM/React。
// overlay 的 position 是不對稱錨點（x=水平中心、y=上緣，見 shared/src/snap.ts 開頭註解與
// OverlayItem.position 的說明）；snapBBox 只認 bbox（左上角 x/y + 寬高），所以這裡負責
// 「錨點 → bbox 左上角」「bbox 左上角 → 錨點」的雙向換算，snapBBox 本身不用知道這個不對稱。
import { snapBBox, type SnapGuide } from '@vidcut/shared';

/** overlay 拖曳：回吸附後 position(0–1)與導線。bboxW/H = 該 overlay 目前顯示尺寸(畫布 px)。 */
export function dragOverlay(
  startPos: { x: number; y: number },
  deltaCanvas: { dx: number; dy: number },
  bbox: { w: number; h: number },
  canvas: { w: number; h: number },
): { position: { x: number; y: number }; guides: SnapGuide[] } {
  // position → bbox 左上角（x 錨=中心、y 錨=上緣）
  const raw = {
    x: startPos.x * canvas.w - bbox.w / 2 + deltaCanvas.dx,
    y: startPos.y * canvas.h + deltaCanvas.dy,
    w: bbox.w,
    h: bbox.h,
  };
  const s = snapBBox(raw, canvas);
  return {
    position: {
      x: Math.min(1, Math.max(0, (s.x + bbox.w / 2) / canvas.w)),
      y: Math.min(1, Math.max(0, s.y / canvas.h)),
    },
    guides: s.guides,
  };
}

/** 字幕拖曳：只動 style.y(0–1，夾在 0..1-高度佔比)。 */
export function dragCaption(
  startY: number,
  dyCanvas: number,
  cardH: number,
  canvasH: number,
): { y: number; guides: SnapGuide[] } {
  // 字幕卡全寬置中，x 固定；只吸 y 軸（x 導線濾掉）
  const s = snapBBox(
    { x: 0, y: startY * canvasH + dyCanvas, w: 1080, h: cardH },
    { w: 1080, h: canvasH },
  );
  const y = Math.min(1 - cardH / canvasH, Math.max(0, s.y / canvasH));
  return { y, guides: s.guides.filter((g) => g.axis === 'y') };
}
