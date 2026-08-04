// server/src/cardBudget.ts — 字卡的輸出像素預算：所有產卡路徑（HTTP 預覽、cardSync、
// 文字 overlay 前置）共用的同一套上限。放在獨立模組是刻意的：上限只有一份，
// 加新的產卡入口時不會又漏掉一條。
import type { CardRequest } from './rasterizer.js';

/**
 * 一張字卡允許的最大輸出像素數（width × height）。
 *
 * 為什麼要管「輸出像素」而不是管 fontSize / text 長度：Pillow 的成本幾乎完全由
 * `Image.new("RGBA", (width, height))` 的面積決定，而 text_card.py 的**無 tokens 路徑
 * 根本不換行**（只 split("\n")），所以高度是由「行數」驅動的。只限制 `text ≤ 4000 字`
 * 等於允許 4000 行：實測 4096 寬 × fontSize 512 × 4001 行 = 10.06 Gpx ≈ 40 GB RGBA、
 * 約 17 分鐘；十分之一的量（1 Gpx）就要 102 秒、2.2 GB，而且還會回 HTTP 200。
 * 單一 worker 是序列化的，這種請求同時等於「把整條字卡佇列霸佔十幾分鐘」。
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
 * 複刻 text_card.py 的幾何算式（render_cards）：
 *   line_h = size + max(6, size // 5)
 *   height = line_h * len(lines) + stroke_w * 2 + 8
 * 行數：有 tokens 走貪婪換行，每行至少一個詞 → 行數 ≤ 詞數（取上界，因為我們在 Node
 * 這側量不到字寬；正常 karaoke 一頁約 24 個單位、實際只有 1–2 行，估得保守只會更安全）。
 * 沒有 tokens 時 python **完全不換行**，行數就是 text 裡的 "\n" 數 + 1 ——這正是漏洞所在。
 */
export function estimateCard(req: CardRequest): CardEstimate {
  const size = Math.floor(req.style.fontSize); // python 的 int()
  const lineH = size + Math.max(6, Math.floor(size / 5));
  const strokeW = req.style.stroke ? Math.max(2, Math.floor(size / 16)) : 0;
  const lines = req.tokens?.length ? req.tokens.length : req.text.split('\n').length;
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
      `text card too large: ${est.lines} line(s) at fontSize ${size} → ` +
      `${Math.floor(req.width)}×${est.height} ≈ ${(est.pixels / 1e6).toFixed(1)} Mpx, ` +
      `limit ${MAX_CARD_PIXELS / 1e6} Mpx. ` +
      '（每一個 "\\n" 都是一整行，換行不會自動 wrap；請減少行數或縮小 fontSize。）'
    );
  }
  return null;
}
