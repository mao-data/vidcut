// server/src/cardBudget.ts — 字卡的輸出像素預算：所有產卡路徑（HTTP 預覽、cardSync、
// 文字 overlay 前置）共用的同一套上限。放在獨立模組是刻意的：上限只有一份，
// 加新的產卡入口時不會又漏掉一條。
import { cardMargin, type CardRequest } from './rasterizer.js';

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
 * 單一字元的 advance（前進寬）上界，單位 em（＝ fontSize 的倍數）。
 *
 * Node 這側沒有字型量測，所以「這段文字有多寬」只能用「字元數 × 每字上界」估。
 * 3 em 是**量出來的**，不是拍腦袋的：對 `server/src/fonts.ts` 字型表裡每一個字型檔，
 * 用 Pillow 掃過整個 BMP（U+0020–U+FFFF）加上 emoji／數學字母／CJK ext-B 幾段星號平面，
 * 取最大 advance／fontSize：
 *   STHeiti Medium      1.188 em（U+2030 ‰）
 *   Hiragino Sans GB    1.000 em
 *   Arial Unicode MS    2.266 em（U+FDA9，阿拉伯連字）  ← 全表最寬
 *   Arial               1.375 em（U+0478 Ѹ）
 * 3 em 對實測最寬字元留 32% 餘裕。`server/test/textCards.test.ts` 有一條測試會**重跑
 * 這個掃描**（對 `loadFontTable()` 實際載得起來的字型），加了更寬的字型就會當場失敗。
 *
 * **什麼字元打得穿它**：阿拉伯連字 U+FDFD ﷽（BISMILLAH）在 Noto Naskh Arabic 這類
 * 字型裡約 11 em，U+FDFA ﷺ 在 Arial Unicode 裡也已經 1.94 em。本機字型表沒有一個字型
 * 真的畫得出 U+FDFD（都退回 1 em 的 .notdef），但**若哪天字型表加了那種字型，這個常數
 * 就必須跟著調大**——那正是上面那條掃描測試存在的理由。
 * 退化是漸進的、不是斷崖：真實最寬字元若是 R em，超出預算的倍率至多 R/3
 * （例如 11 em 的字型 → 最多 3.7 倍＝約 44 Mpx／4.5 秒／0.2 GB，不是 40 GB／17 分鐘）。
 *
 * 其他形狀的字元怎麼算：
 * - **全形 CJK**＝1 em；組合附加符號（U+0300…）advance 0 或很小 → 都遠在 3 em 內。
 * - **星號平面（emoji、CJK ext-B）**：JS 的 `string.length` 算 2 個 UTF-16 單位、
 *   python 算 1 個字元，所以每個星號平面字元會被記成 6 em——**高估安全**，刻意不正規化。
 * - **合字（ligature）／字距（kerning）**：Pillow 這邊 raqm 沒編進去
 *   （`PIL.features.check('raqm')` = False），走 BASIC layout ＝不做 complex shaping。
 *   ⚠️ 但**不做 shaping ≠ 完全可加**：FreeType 的 legacy `kern` 表仍然會套用，
 *   所以 `textlength(a+b)` 不保證恰好等於 `textlength(a)+textlength(b)`
 *   （本機 Arial 掃過 ASCII 字母數字＋常見標點的所有配對：88 組不可加，
 *   最大偏差 0.0020 em，而且實測**全部是負的**（`f`+`f`、`v`+`.` 這類 kerning pair
 *   把字拉近＝字串變窄）。變窄仍在上界這一側；就算某天出現正偏差，量級也比
 *   `MAX_ADVANCE_EM`(3) 與實測最寬字元(2.27 em) 之間的餘裕小三個數量級。
 *   換成 raqm 也一樣：shaping/kerning
 *   幾乎只會讓字串變窄（連字、負 kerning），仍在上界這一側。
 */
export const MAX_ADVANCE_EM = 3;

/**
 * 貪婪換行的行數上界：`L ≤ floor(2 × 總前進寬上界 ÷ 可用寬) + 1`。
 *
 * 論證（對照 `text_card.py` 的 `wrap_text()`／`layout_tokens()`，兩者是同一套貪婪迴圈）：
 * 1. 每送出一行是因為「目前這行非空，且再接下一塊就超過可用寬」：
 *    `W(第 i 行) + W(第 i+1 行的第一塊) > 可用寬`。
 * 2. `W(第 i+1 行的第一塊) ≤ W(第 i+1 行)`，所以每一組相鄰兩行的寬度和 > 可用寬。
 * 3. 把 i = 1..L−1 全部加起來，每一行最多被算進去兩次（一次當左邊、一次當右邊）：
 *    `2 × Σ W(行) > (L−1) × 可用寬`。
 * 4. 各行用到的字元互不重疊（換行點的空白會被丟掉，沒有字元出現在兩行），
 *    而 `textlength` 是逐字 advance 相加（見 `MAX_ADVANCE_EM` 註解）
 *    → `Σ W(行) ≤ Σ 每個字元的 advance ≤ MAX_ADVANCE_EM × fontSize × 字元數`。
 * ⇒ `L − 1 < 2 × advance 上界 ÷ 可用寬`，取整得本式。
 *
 * 那個 **2 倍不是保險係數，是這條式子的等號代價**：貪婪填行可以排出「窄一行、滿一行、
 * 窄一行…」的鋸齒（一個接近滿寬的不可斷長單字後面跟一個單字元），每兩行只用掉大約
 * 一個可用寬。本機字型實測最緊的對抗案例已經到 0.51（U+FDA9 ×4 為一個原子、
 * 實際 80 行 vs 估算 158 行，`textCards.test.ts` 有釘住）；理論上的等號要有 3 em 寬的
 * 字元才打得到，而本機字型表最寬只有 2.27 em。
 * （2026-08-05 有一次審查說這個數字「應該是 0.710」——覆核後**維持 0.51**：80/158
 * ＝0.5063，重跑那條測試也是 0.5063。0.710 是另一組取樣掃出來的最緊值，那組沒有
 * 涵蓋 U+FDA9 這個構造；「別處掃到 0.710」不會讓「這裡量到 0.51」變成錯的。）
 */
function greedyLineBound(advanceUpperBound: number, usable: number): number {
  return Math.floor((2 * advanceUpperBound) / usable) + 1;
}

/**
 * `text_card.py` 的可用寬（`max_width = max(1, width - margin*2)`）。
 *
 * `margin` 由呼叫端算（`cardMargin()`，見 rasterizer.ts —— **唯一**的換算來源），
 * 省略時 python 用自己的預設 `max(32, width // 20)`。這裡取**兩者較大**的 margin
 * （＝較窄的可用寬）純粹是保險：現行所有 spawn 點都有傳 margin，1080 寬 + 預設
 * maxWidthFrac 0.9 時兩式同值（54），但哪天有人漏傳，估算取窄邊才不會低估行數。
 */
function usableWidth(req: CardRequest): number {
  const width = Math.floor(req.width);
  const margin = Math.max(
    cardMargin(width, req.maxWidthFrac ?? 0.9),
    Math.max(32, Math.floor(width / 20)),
  );
  return Math.max(1, width - margin * 2);
}

/**
 * 沒有 tokens 時 `wrap_text()` 最多會排出幾行——**嚴格上界**（前提：沒有字元寬過
 * `MAX_ADVANCE_EM` em）。真的 `\n` 一律強制換行，所以總行數 = Σ 各段落的行數。
 *
 * 每段取兩個上界的**較小值**：
 * - **字元數上界**（`max(1, 段落字元數)`）：每一行至少含一個非空白字元、且各行不共用
 *   字元 → 行數 ≤ 字元數。這條與字型完全無關，永遠成立，也是 2026-08-04 上線時唯一的
 *   估算式。可用寬窄到只放得下一個字時它就是等號（1080 寬 / fontSize 512 /
 *   maxWidthFrac 0.1 → 可用寬 108 < 一個 512px 的全形字），`textCards.test.ts` 有測試釘住。
 * - **前進寬上界**（`greedyLineBound`）：一般文字緊得多。
 *
 * 為什麼要加後者：只有字元數上界時＝假設「每個字元各佔一行」，1080 寬 / fontSize 64
 * 的實務上限只有 **146 字**——自動換行剛上線（2026-08-04），使用者貼一段正常長度的
 * 段落就會被拒（實測一段 163 字的中文散文就已經被擋下）。同樣條件下新上限是
 * **369 字**（實際只會折成約 25 行）；fontSize 40 時 935 字（舊估算 232 字）。
 * 兩條都是上界，取 min 只會更緊、不會失去保證。
 */
function maxWrappedLines(text: string, size: number, usable: number): number {
  let n = 0;
  for (const para of text.split('\n')) {
    // UTF-16 長度（不是 code point 數）：星號平面字元在 JS 算 2、python 算 1，
    // 高估安全、低估致命，所以刻意不做正規化。空白也照算（同理）。
    const chars = para.length;
    n += Math.max(1, Math.min(chars, greedyLineBound(MAX_ADVANCE_EM * size * chars, usable)));
  }
  return n;
}

/**
 * 有 tokens（karaoke）時 `layout_tokens()` 的行數上界。同樣取兩者較小：
 * - 貪婪填行每行至少一個詞 → 行數 ≤ 詞數。
 * - 前進寬上界：字元總數要**加上詞間分隔空白**（`separator()` 最多一個空白，
 *   每個詞算一個，也是上界）。
 */
function maxTokenLines(tokens: string[], size: number, usable: number): number {
  let chars = 0;
  for (const t of tokens) chars += t.length + 1; // +1 = 這個詞前面可能有的分隔空白
  return Math.max(
    1,
    Math.min(tokens.length, greedyLineBound(MAX_ADVANCE_EM * size * chars, usable)),
  );
}

/**
 * 複刻 text_card.py 的幾何算式（render_cards）：
 *   line_h = size + max(6, size // 5)
 *   height = line_h * len(lines) + stroke_w * 2 + 8
 * 行數一律取**上界**（Node 這側沒有字型量測，寧可高估）：見 `maxWrappedLines`／
 * `maxTokenLines`。（2026-08-04 之前這裡是 `split('\n').length`，那在 python 開始自動
 * 換行之後會**低估**——一行長文字可以變成幾百行，預算就不再是保證。）
 */
export function estimateCard(req: CardRequest): CardEstimate {
  const size = Math.floor(req.style.fontSize); // python 的 int()
  const lineH = size + Math.max(6, Math.floor(size / 5));
  const strokeW = req.style.stroke ? Math.max(2, Math.floor(size / 16)) : 0;
  const usable = usableWidth(req);
  const lines = req.tokens?.length
    ? maxTokenLines(req.tokens, size, usable)
    : maxWrappedLines(req.text, size, usable);
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
      '（行數是**最壞情況**上界：伺服器這側量不到字寬，只能用「每個字元最寬 ' +
      `${MAX_ADVANCE_EM} em」去估——實際畫出來通常少很多。請縮短文字或縮小 fontSize。）`
    );
  }
  return null;
}
