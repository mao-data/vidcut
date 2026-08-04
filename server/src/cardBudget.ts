// server/src/cardBudget.ts — 字卡的輸出像素預算：所有產卡路徑（HTTP 預覽、cardSync、
// 文字 overlay 前置）共用的同一套上限。放在獨立模組是刻意的：上限只有一份，
// 加新的產卡入口時不會又漏掉一條。
import type { CardRequest } from './rasterizer.js';

/**
 * 一張字卡允許的最大輸出像素數（width × height）。
 *
 * 為什麼要管「輸出像素」而不是管 fontSize / text 長度：Pillow 的成本幾乎完全由
 * `Image.new("RGBA", (width, height))` 的面積決定，而高度是由「行數」驅動的。
 * 只限制 `text ≤ 4000 字` 等於允許 4000 行：實測 4096 寬 × fontSize 512 × 4001 行
 * = 10.06 Gpx ≈ 40 GB RGBA、約 17 分鐘；十分之一的量（1 Gpx）就要 102 秒、2.2 GB，
 * 而且還會回 HTTP 200。單一 worker 是序列化的，這種請求同時等於「把整條字卡佇列
 * 霸佔十幾分鐘」。（2026-08-04 起 text_card.py 的無 tokens 路徑會自動換行，
 * 行數不再只由 `\n` 決定——估算式怎麼跟上見 `estimateCard`。）
 *
 * 取 12,000,000 的理由（本機實測，見下）：
 * - 真正的畫布是 1080×1920 = 2.07 Mpx。一張字卡再大也大不過畫布——超出畫布的部分
 *   根本不會被看到，所以「合法的最大字卡」就是滿版畫布那張。12 Mpx ≈ 畫布的 5.8 倍。
 * - 最大匯出檔位 4K（2160×3840）滿版 = 8.29 Mpx，仍在預算內（留 45% 餘裕）。
 *   我能構造出的最大**正當**字幕/overlay 就是這個：滿版 4K 的整頁文字。
 * - 實測成本（python3 text_card.py --worker，本機）：
 *     1080×11104  = 12.0 Mpx → 1.4 秒、峰值 RSS 0.07 GB
 *     4096×3692   = 15.1 Mpx → 1.7 秒、峰值 RSS 0.08 GB
 *     1080×110284 = 119 Mpx  → 12.2 秒、峰值 RSS 0.50 GB   （線性，約 0.1 秒 / 5 MB 每 Mpx）
 *   也就是預算內的最壞情況 ≈ 1.5 秒 / 80 MB：佇列會頓一下，但不會 OOM、不會被訊號殺、
 *   更不會霸佔十幾分鐘。（正常字幕 1080×160 ≈ 0.17 Mpx，0.1 秒內、20 MB。）
 * - 端到端實測（真的起 server、真的 POST /text-card/preview）：
 *     貼齊上限 11.91 Mpx（1080×11104）→ HTTP 200，2.77 秒，峰值 worker RSS 0.07 GB
 *     貼齊上限 10.35 Mpx（4096×2528，含描邊）→ HTTP 200，1.96 秒，峰值 RSS 0.08 GB
 *     reviewer 那個 254 Mpx payload（舊行為 102 秒 / 2.2 GB / HTTP 200）→ HTTP 400，3 毫秒
 */
export const MAX_CARD_PIXELS = 12_000_000;

/**
 * 便宜的欄位級健檢。這些**不是**防 OOM 的主力（上面的像素預算才是），只是把明顯的
 * 垃圾輸入擋在前面、讓錯誤訊息指向真正填錯的那個欄位。
 * - width 16–4096：下限是「還畫得出東西」，上限涵蓋 4K 匯出（2160 寬）並留餘裕。
 * - fontSize 1–512：512px 的字在 1080 寬畫布上一行只放得下兩個中文字。
 * - maxWidthFrac 0.1–1：更小的換行寬會讓每個詞自己一行。
 * - text/tokens 長度：純粹是 payload 大小的護欄。
 */
export const CARD_LIMITS = {
  widthMin: 16,
  widthMax: 4096,
  fontSizeMin: 1,
  fontSizeMax: 512,
  maxWidthFracMin: 0.1,
  maxWidthFracMax: 1,
  textMax: 4000,
  tokensMax: 1000,
} as const;

export interface CardEstimate {
  lines: number;
  height: number;
  pixels: number;
}

/**
 * 沒有 tokens 時 `text_card.py` 的 `wrap_text()` 最多會排出幾行——**嚴格上界**。
 *
 * 論證（對照 `wrap_text` 的實作）：
 * 1. 真的 `\n` 一律強制換行，所以總行數 = Σ 各段落的行數。
 * 2. 段落內：貪婪填行只有在「目前這行非空、下一塊放不下」時才送出一行，而且
 *    行首的空白原子會被丟掉 → **每一行都至少含一個非空白字元**。
 * 3. 各行使用的字元互不重疊（空白可能被丟掉，但沒有字元會出現在兩行）。
 *    → 段落行數 ≤ 段落內的字元數；空段落仍佔一行 → 取 `max(1, len)`。
 *
 * 這個上界**是可以被打到的**（不是隨手放大的保險係數）：把可用寬壓到只放得下
 * 一個字（例如 `width` 1080、`fontSize` 512、`maxWidthFrac` 0.1 → 可用寬 108 < 512），
 * 每個 CJK 字就真的各佔一行，實際行數 = 字元數 = 這個上界。所以在「Node 這側沒有
 * 字型量測」的前提下，沒有比它更緊的安全上界（`server/test/textCards.test.ts`
 * 有一條測試把這個等號釘住）。
 *
 * **代價要講清楚**：一般情況它會高估很多（1080 寬、fontSize 64 的中文一行放得下
 * 15 字，估算卻當成 15 行）。實務上限＝ fontSize 64 時約 146 字、fontSize 40 時約
 * 232 字；再長就會被預算擋下，即使真的畫出來只有十幾行。這是刻意的取捨：低估會讓
 * 預算從「保證」退化成「看起來很安全的假數字」，而預算存在的理由是一個實測 ~40 GB／
 * ~17 分鐘的 payload。要拿回精確度只有一條路——把判斷搬到有字型量測的那一側
 * （python 排完版、`Image.new` 之前再擋一次），那會讓 `cardRequestError` 變成非同步，
 * 是另一個批次的事。
 */
function maxWrappedLines(text: string): number {
  let n = 0;
  // 用 UTF-16 長度（不是 code point 數）：星號平面字元在 JS 算 2、python 算 1，
  // 高估安全、低估致命，所以刻意不做正規化。空白也照算（同理）。
  for (const para of text.split('\n')) n += Math.max(1, para.length);
  return n;
}

/**
 * 複刻 text_card.py 的幾何算式（render_cards）：
 *   line_h = size + max(6, size // 5)
 *   height = line_h * len(lines) + stroke_w * 2 + 8
 * 行數一律取**上界**（Node 這側沒有字型量測，寧可高估）：
 * - 有 tokens：貪婪換行每行至少一個詞 → 行數 ≤ 詞數。
 * - 沒有 tokens：見 `maxWrappedLines`。（2026-08-04 之前這裡是 `split('\n').length`，
 *   那在 python 開始自動換行之後會**低估**——一行長文字可以變成幾百行，預算就不再是保證。）
 */
export function estimateCard(req: CardRequest): CardEstimate {
  const size = Math.floor(req.style.fontSize); // python 的 int()
  const lineH = size + Math.max(6, Math.floor(size / 5));
  const strokeW = req.style.stroke ? Math.max(2, Math.floor(size / 16)) : 0;
  const lines = req.tokens?.length ? req.tokens.length : maxWrappedLines(req.text);
  const height = lineH * lines + strokeW * 2 + 8;
  return { lines, height, pixels: Math.floor(req.width) * height };
}

/**
 * 產卡請求的唯一驗證入口：回 null 代表可以送進 worker，否則回一句可以直接給使用者/模型看的
 * 錯誤訊息。呼叫端各自決定怎麼呈現（HTTP 回 400、命令層回 {ok:false,error}）。
 */
export function cardRequestError(req: CardRequest): string | null {
  const size = req.style?.fontSize;
  if (typeof size !== 'number' || !Number.isFinite(size))
    return 'style.fontSize must be a finite number';
  if (size < CARD_LIMITS.fontSizeMin || size > CARD_LIMITS.fontSizeMax)
    return `style.fontSize must be within ${CARD_LIMITS.fontSizeMin}–${CARD_LIMITS.fontSizeMax} (got ${size})`;
  if (typeof req.width !== 'number' || !Number.isFinite(req.width))
    return 'width must be a finite number';
  if (req.width < CARD_LIMITS.widthMin || req.width > CARD_LIMITS.widthMax)
    return `width must be within ${CARD_LIMITS.widthMin}–${CARD_LIMITS.widthMax} (got ${req.width})`;
  if (typeof req.text !== 'string') return 'text must be a string';
  if (req.text.length > CARD_LIMITS.textMax)
    return `text must be at most ${CARD_LIMITS.textMax} characters (got ${req.text.length})`;
  if (req.tokens && req.tokens.length > CARD_LIMITS.tokensMax)
    return `tokens must be at most ${CARD_LIMITS.tokensMax} items (got ${req.tokens.length})`;
  if (req.maxWidthFrac !== undefined) {
    if (typeof req.maxWidthFrac !== 'number' || !Number.isFinite(req.maxWidthFrac))
      return 'maxWidthFrac must be a finite number';
    if (
      req.maxWidthFrac < CARD_LIMITS.maxWidthFracMin ||
      req.maxWidthFrac > CARD_LIMITS.maxWidthFracMax
    )
      return `maxWidthFrac must be within ${CARD_LIMITS.maxWidthFracMin}–${CARD_LIMITS.maxWidthFracMax}`;
  }
  const est = estimateCard(req);
  if (est.pixels > MAX_CARD_PIXELS) {
    return (
      `text card too large: at most ${est.lines} line(s) at fontSize ${size} → ` +
      `${Math.floor(req.width)}×${est.height} ≈ ${(est.pixels / 1e6).toFixed(1)} Mpx, ` +
      `limit ${MAX_CARD_PIXELS / 1e6} Mpx. ` +
      '（行數是**最壞情況**上界：伺服器這側量不到字寬，只能假設每個字元自己佔一行' +
      '——實際畫出來通常少很多。請縮短文字或縮小 fontSize。）'
    );
  }
  return null;
}
