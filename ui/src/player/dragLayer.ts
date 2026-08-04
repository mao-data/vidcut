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
  return { position: clampCentre(s, bbox, canvas, startPos), guides: s.guides };
}

/**
 * 夾制規則：**元素的中心必須留在畫布內**，四個邊一視同仁——每一邊最多露出自身的一半。
 *
 * 在 **bbox 空間**做，不是各自夾錨點的值。舊版就是各自夾錨點，寫起來看似對稱
 * （兩條都是「夾在 0 到某值」），但因為 x 錨的是水平中心、y 錨的是上緣，
 * 同樣的寫法產生了完全不同的視覺語意：x 可以露出一半，y 卻必須整個留在畫布內
 * （上限 1-h/H）——使用者拖起來就是「左右出得去、上下出不去」（2026-08-04 回報）。
 * 錨點不對稱只該活在「錨點↔bbox」的換算裡，不該滲進規則本身；這也是 snapBBox
 * 只認 bbox 的同一個理由。
 *
 * 注意 `clampAxis` 的 `start` 必須跟被夾的值在**同一個空間**：y 這條夾的是「中心」，
 * 所以起點也要換算成起點的中心（`startPos.y + h/2H`），不能直接傳上緣的 startPos.y。
 *
 * 允許 y 為負值（元素掛在畫布上緣外）。實測 ffmpeg `overlay=y=負數` 會從畫面上緣裁掉
 * 超出的部分（1920 畫布、200px 高的圖、y=-0.05 → 只露下面 104px），與預覽 stage 的
 * `overflow: hidden` 裁切方式一致，所以放寬夾制不會製造新的「預覽≠成品」。
 *
 * clamp 會不會蓋掉已吸附的結果？只要 bbox 不比畫布大，snapBBox 的候選（中心、上/下
 * 安全邊距）算出來的 bbox 中心必然落在畫布內，所以對任何已吸附的候選都是 no-op，
 * snap 永遠贏；clamp 只在完全沒吸附、使用者硬拖到連中心都要出畫布時才生效。
 */
function clampCentre(
  s: { x: number; y: number },
  bbox: { w: number; h: number },
  canvas: { w: number; h: number },
  startPos: { x: number; y: number },
): { x: number; y: number } {
  const halfH = bbox.h / (2 * canvas.h); // 上緣錨點 → 中心的正規化位移
  const cy = clampAxis((s.y + bbox.h / 2) / canvas.h, 0, 1, startPos.y + halfH);
  return {
    x: clampAxis((s.x + bbox.w / 2) / canvas.w, 0, 1, startPos.x), // x 錨本來就是中心
    y: cy - halfH, // 中心 → 上緣，換算回 position 的語意
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
 * 字幕拖曳：只動 style.y，clamp 規則與 dragOverlay 同一條（中心留在畫布內、
 * 上下各可露出半張卡；clampAxis 的區間永遠含起點）。
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
  const { y } = clampCentre(
    s,
    { w: 1080, h: cardH },
    { w: 1080, h: canvasH },
    { x: 0.5, y: startY },
  );
  return { y, guides: s.guides.filter((g) => g.axis === 'y') };
}
