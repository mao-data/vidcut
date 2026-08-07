// 預覽畫布拖曳吸附。純函式,不碰 DOM/React,供 UI 的 dragLayer 呼叫。
//
// 一律吃「實際 bbox」(左上角 x/y + 寬高),不是 overlay 的 position 錨點。
// overlay 的 position 錨點刻意不對稱:x 是圖片水平「中心」,y 卻是「上緣」
// (預覽用 translate(-50%, 0)、ffmpeg 端 x=(W*x)-(w/2), y=H*y)。曾經因為
// 這個不對稱出過事故:AI 以為 y: 0.5 會置中,結果把整片畫布大小的圖推出畫面
// 960px。若直接拿錨點座標算「垂直置中」會用錯半個元素高度的偏移量,所以
// 這裡強制只認 bbox,呼叫端(dragLayer.ts)負責把錨點換算成 bbox 再進來、
// 把回傳的 bbox 左上角換算回錨點出去。
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一條命中的吸附導線,畫在畫布座標 pos 處(x 導線是條垂直線、y 導線是條水平線)。 */
export interface SnapGuide {
  axis: 'x' | 'y';
  pos: number;
}

/** 上/下安全邊距,佔畫布高度的比例。 */
const SAFE_FRAC = 0.05;

/**
 * 把 bbox 吸附到畫布的水平中心、垂直中心、上安全邊距、下安全邊距。
 *
 * 水平只有一個候選(中心),在 threshold 內就吸附。
 * 垂直有三個候選(中心、上邊距、下邊距),互斥——同時算出離每個候選的距離,
 * 只讓「最近的那一個」在 threshold 內時生效,不會同時吸兩條 y 導線。
 *
 * 回傳吸附後的 bbox 左上角(x, y)與命中的導線列表(未命中的軸不出現在裡面)。
 */
export function snapBBox(
  b: BBox,
  canvas: { w: number; h: number },
  threshold = 16,
): { x: number; y: number; guides: SnapGuide[] } {
  const guides: SnapGuide[] = [];
  let { x, y } = b;

  // 水平:bbox 中心 vs 畫布中心
  const cx = canvas.w / 2;
  if (Math.abs(b.x + b.w / 2 - cx) <= threshold) {
    x = cx - b.w / 2;
    guides.push({ axis: 'x', pos: cx });
  }

  // 垂直:三個候選取最近的一個(中心、安全上緣、安全下緣),避免同時吸兩條
  const cy = canvas.h / 2;
  const top = canvas.h * SAFE_FRAC;
  const bottom = canvas.h * (1 - SAFE_FRAC);
  const candidates: Array<{ delta: number; y: number; pos: number }> = [
    { delta: Math.abs(b.y + b.h / 2 - cy), y: cy - b.h / 2, pos: cy },
    { delta: Math.abs(b.y - top), y: top, pos: top },
    { delta: Math.abs(b.y + b.h - bottom), y: bottom - b.h, pos: bottom },
  ];
  const best = candidates.reduce((a, c) => (c.delta < a.delta ? c : a));
  if (best.delta <= threshold) {
    y = best.y;
    guides.push({ axis: 'y', pos: best.pos });
  }

  return { x, y, guides };
}
