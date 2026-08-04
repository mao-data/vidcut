// 逐字稿 → 字幕分頁。純函式，不碰檔案與 ffmpeg，所以能單獨測、單獨調參。
// 「何時換頁」是整個自動字幕唯一有主觀判斷的地方，刻意隔離在這裡。
import type { CaptionItem, CaptionStyle, CaptionToken } from './types.js';

/** ASR 產出的一個詞。時間為**時間軸絕對秒數**（見 CaptionToken 註解）。 */
export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
}

export interface CaptionPageOptions {
  /** 詞間停頓超過此值就換頁（毫秒） */
  maxGapMs?: number;
  /** 單頁最長（毫秒） */
  maxDurationMs?: number;
  /** 單頁最大寬度單位（CJK 計 2、其他計 1） */
  maxUnits?: number;
  /** 保留逐詞時間戳以做 karaoke 高亮（預設 true） */
  karaoke?: boolean;
}

/** 直式短片 1080 寬、fontSize 64 下約可容 12 個中文字，故單位上限預設 24。 */
export const DEFAULT_PAGE_OPTIONS: Required<Omit<CaptionPageOptions, 'karaoke'>> = {
  maxGapMs: 400,
  maxDurationMs: 2500,
  maxUnits: 24,
};

export interface TokenBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: 'PingFang TC',
  fontSize: 64,
  fill: '#ffffff',
  stroke: '#000000',
  y: 0.72,
  highlight: '#FCDE5A',
};

// CJK 統一漢字、假名、全角標點——這些字寬約為拉丁字母兩倍
// 用 \u 逃脫而非直接貼字元：全角空白 U+3000 在原始碼裡看不出來（lint 也會攔）
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
/** 句末標點：出現就在該詞之後斷頁 */
const SENTENCE_END = /[。！？!?…]$/;
/** whisper 對靜音段會吐這種標記，不是台詞 */
const NON_SPEECH = /^\[.*\]$|^\(.*\)$/;

/**
 * 修正 ASR 時間戳的兩種已知病態（實測 whisper.cpp 1.9.1）：
 *
 * 1. **最後一個詞的結束時間會是 30 秒**——whisper 內部把音訊補齊成 30 秒區塊，
 *    尾段的結束時間就吐區塊邊界。不修的話最後一句字幕會掛在畫面上好幾十秒。
 * 2. **短音訊（約 4 秒以下）時詞會全部擠在同一個時間點**——這是 whisper 的弱點，
 *    不是我們的音訊管線問題（用純 ffmpeg 轉出的 wav 也一樣）。
 *
 * 對第 2 種只能退化處理：把擠在一起的詞在「該點到下一個有效時間」之間平均分配。
 * 不精確，但遠好過讓整句字幕的高亮卡在最後一個詞上。
 */
export function normalizeWords(words: TranscriptWord[], totalDuration: number): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  let prevStart = 0;
  for (const w of words) {
    const start = Math.min(Math.max(w.start, prevStart), totalDuration);
    const end = Math.min(Math.max(w.end, start), totalDuration);
    out.push({ text: w.text, start, end });
    prevStart = start;
  }

  // 零長度的連續區間 → 在該點到下一個有效起點之間平均攤開
  let i = 0;
  while (i < out.length) {
    if (out[i]!.end > out[i]!.start) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && out[j]!.end <= out[j]!.start && out[j]!.start === out[i]!.start) j++;
    const from = out[i]!.start;
    const to = j < out.length ? out[j]!.start : totalDuration;
    const step = (to - from) / (j - i);
    if (step > 0) {
      for (let k = i; k < j; k++) {
        out[k]!.start = from + step * (k - i);
        out[k]!.end = from + step * (k - i + 1);
      }
    }
    i = j;
  }
  return out;
}

/** 估算顯示寬度：CJK 計 2、其他計 1。用於換頁而非精確排版（精確量測在 text_card.py）。 */
export function textUnits(s: string): number {
  let n = 0;
  for (const ch of s) n += CJK.test(ch) ? 2 : 1;
  return n;
}

/** CJK 與 CJK／CJK 與拉丁之間不加空白（中文排版慣例）；拉丁之間加空白。 */
function joinTokens(parts: string[]): string {
  let out = '';
  for (const p of parts) {
    if (out === '') {
      out = p;
      continue;
    }
    const prev = out[out.length - 1]!;
    const next = p[0]!;
    out += CJK.test(prev) || CJK.test(next) ? p : ` ${p}`;
  }
  return out;
}

function toCaption(
  tokens: CaptionToken[],
  style: CaptionStyle,
  karaoke: boolean,
): CaptionItem | null {
  if (tokens.length === 0) return null;
  const start = tokens[0]!.start;
  const end = tokens[tokens.length - 1]!.end;
  return {
    // 依起點毫秒推導，所以同一份逐字稿重跑會得到同樣的 id（diff 友善、AI 可重試）
    id: `cap_${Math.round(start * 1000)}`,
    text: joinTokens(tokens.map((t) => t.text)),
    start,
    duration: Math.max(0.01, end - start),
    style,
    ...(karaoke ? { tokens } : null),
  };
}

/**
 * 把逐詞時間戳切成一頁一頁的字幕。
 * 換頁條件（任一成立即斷）：詞間停頓過長、頁長超時、寬度超過上限、前一詞以句末標點結尾。
 */
export function buildCaptionPages(
  words: TranscriptWord[],
  options: CaptionPageOptions = {},
  style: CaptionStyle = DEFAULT_CAPTION_STYLE,
): CaptionItem[] {
  const { maxGapMs, maxDurationMs, maxUnits } = { ...DEFAULT_PAGE_OPTIONS, ...options };
  const karaoke = options.karaoke !== false;

  const clean = words
    .map((w) => ({ ...w, text: w.text.trim() }))
    .filter((w) => w.text !== '' && !NON_SPEECH.test(w.text));

  const pages: CaptionItem[] = [];
  let cur: CaptionToken[] = [];

  const flush = () => {
    const cap = toCaption(cur, style, karaoke);
    if (cap) pages.push(cap);
    cur = [];
  };

  for (const word of clean) {
    if (cur.length > 0) {
      const prev = cur[cur.length - 1]!;
      const gapMs = (word.start - prev.end) * 1000;
      const spanMs = (word.end - cur[0]!.start) * 1000;
      const nextUnits = textUnits(joinTokens([...cur.map((t) => t.text), word.text]));
      if (
        gapMs > maxGapMs ||
        spanMs > maxDurationMs ||
        nextUnits > maxUnits ||
        SENTENCE_END.test(prev.text)
      ) {
        flush();
      }
    }
    cur.push({ text: word.text, start: word.start, end: word.end });
  }
  flush();
  return pages;
}

/**
 * 目前該高亮到第幾個詞（-1 = 還沒開始）。
 * 用 start 判斷而非 end，所以詞間空隙會停在前一個詞、不會閃回未高亮。
 */
export function activeTokenIndex(cap: CaptionItem, t: number): number {
  const tokens = cap.tokens;
  if (!tokens || tokens.length === 0) return -1;
  let idx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (t >= tokens[i]!.start) idx = i;
    else break;
  }
  return idx;
}

/**
 * 逐詞揭色的 CSS clip-path。active<0 → null(hl 層整個不顯示)。pad=描邊外擴補償
 * 回傳 `path('M.. Z M.. Z')`:0..active 每個 box 一個矩形子路徑(先 pad 外擴)。
 */
export function karaokeClip(boxes: TokenBox[], active: number, pad = 0): string | null {
  if (active < 0 || boxes.length === 0) return null;
  const rects = boxes
    .slice(0, Math.min(active + 1, boxes.length))
    .map((b) => {
      const x = b.x - pad;
      const y = b.y - pad;
      const w = b.w + pad * 2;
      const h = b.h + pad * 2;
      return `M${x},${y} h${w} v${h} h${-w} Z`;
    })
    .join(' ');
  return `path('${rects}')`;
}
