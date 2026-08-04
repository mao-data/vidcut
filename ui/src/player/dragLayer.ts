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
      // x 錨=中心：clamp 到 [0,1] 讓中心點不出畫布，元素頂多露出一半，符合「不得完全
      // 拖出畫面」。
      x: clampAxis((s.x + bbox.w / 2) / canvas.w, 0, 1, startPos.x),
      // y 錨=上緣（不對稱！）：上限不能是 1——clamp 到 1 代表上緣頂到畫布最底端，
      // 也就是整個元素 100% 掉出畫面下緣，正是本任務要防的「拖到完全看不見」
      // （shared/src/snap.ts:5-8 記錄過的事故就是這個誤解）。上限必須是
      // 「上緣最多落在 canvas.h - bbox.h」，跟 dragCaption 下面同一種 clamp 一致。
      //
      // clamp 會不會蓋掉一個已吸附的結果？只要 bbox.h <= canvas.h（元素不比畫布高，
      // 一般情況恆成立），snapBBox 的三個垂直候選（中心 cy-h/2、上安全邊 top、
      // 下安全邊 bottom-h）算出來的 y 值全部落在 [0, canvas.h-h] 這個合法區間內
      // （見 dragLayer.test.ts 的 no-op 驗證）——所以這裡的 clamp 對任何已吸附的
      // 候選都是 no-op，snap 永遠贏；clamp 只在完全沒吸附、使用者硬拖出邊界時才生效。
      y: clampAxis(s.y / canvas.h, 0, 1 - bbox.h / canvas.h, startPos.y),
    },
    guides: s.guides,
  };
}

/**
 * 夾限單一軸，但**合法區間永遠含起點**（start 在區間外就把區間放寬到剛好含住它）。
 *
 * 為什麼不是單純 `min(hi, max(lo, v))`：那會讓 clamp 去動「使用者這次根本沒拖的那條軸」。
 * 實例：overlay 在 {x:0.4, y:0.9}、bbox 300×400，使用者純水平拖 dx=50/dy=0——y 的正常上限是
 * 1-400/1920=0.79167，一夾就把元素往上彈 208px，而且會跟著這次拖曳被送出、永久存進 doc。
 * 使用者只想左右挪一點，結果元素自己跳上去了。y 的起始值之所以會在合法範圍外，正常途徑就
 * 拿得到（例如 AI 用 update_overlay 設了偏下的位置、或字級/圖變大讓 bbox 長高），不是髒資料。
 *
 * 放寬後的語意：clamp 只能把元素「往畫布內拉」，永遠不能把它推得比起點更外面。
 *  - dx/dy = 0 的那條軸：raw 值就是起點，必落在放寬後的區間內 → 完全不動（本次要修的 bug）。
 *  - 起點本來就合法（絕大多數情況）：區間不變，行為與舊版逐字相同。
 *  - 起點在界外、使用者往界內拖：不受限，能一路拖回畫布內。
 *  - 起點在界外、使用者往界外拖：擋在起點，不會愈拖愈糟。
 * 對已吸附的結果一樣是 no-op（吸附候選本來就落在原本就更窄的 [lo,hi] 內，見下方註解與測試）。
 */
function clampAxis(v: number, lo: number, hi: number, start: number): number {
  return Math.min(Math.max(hi, start), Math.max(Math.min(lo, start), v));
}

/**
 * 字幕拖曳：只動 style.y(0–1，夾在 0..1-高度佔比)，clamp 規則與 dragOverlay 同一條
 * （clampAxis，區間永遠含起點）。
 *
 * 曾經以為「字幕只有一條軸，不會有沒碰到的軸被 clamp 挪走的問題」而留了硬 clamp——錯了。
 * 一樣會炸，只是換個樣子：字卡很高時（字級大或多行）上限 1-cardH/1920 會壓得很低，
 * 例如 cardH=400 時上限只有 0.7917；而 y=0.9 這種值透過 set_captions 正常設得出來。
 * 這時使用者只是輕輕碰一下（dy=1px），硬 clamp 會把字幕往上彈到 0.7917——1px 的手勢
 * 造成 208px 的跳動，而且跟著這次拖曳被送出、永久存進 doc。
 * 用 clampAxis 之後語意變成「clamp 只能把字幕往畫布內拉，不能推得比起點更外面」。
 */
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
  const y = clampAxis(s.y / canvasH, 0, 1 - cardH / canvasH, startY);
  return { y, guides: s.guides.filter((g) => g.axis === 'y') };
}
