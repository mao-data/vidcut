import { describe, it, expect } from 'vitest';
import {
  buildCaptionPages,
  activeTokenIndex,
  normalizeWords,
  textUnits,
  DEFAULT_CAPTION_STYLE,
  karaokeClip,
  type TranscriptWord,
} from './captions.js';

const w = (text: string, start: number, end: number): TranscriptWord => ({ text, start, end });

describe('textUnits', () => {
  it('counts CJK as 2 units and latin as 1', () => {
    expect(textUnits('abcd')).toBe(4);
    expect(textUnits('你好')).toBe(4);
    expect(textUnits('你好ab')).toBe(6);
  });
});

describe('buildCaptionPages', () => {
  it('keeps a short continuous phrase on one page', () => {
    const pages = buildCaptionPages([w('this', 0, 0.3), w('is', 0.3, 0.5), w('fine', 0.5, 0.9)]);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.text).toBe('this is fine');
    expect(pages[0]!.start).toBe(0);
    expect(pages[0]!.duration).toBeCloseTo(0.9);
  });

  it('breaks on a long pause between words', () => {
    const pages = buildCaptionPages([w('before', 0, 0.4), w('after', 2.0, 2.4)], {
      maxGapMs: 400,
    });
    expect(pages.map((p) => p.text)).toEqual(['before', 'after']);
    // 第一頁不該延伸到第二頁的起點——停頓期間不該掛著字
    expect(pages[0]!.start + pages[0]!.duration).toBeCloseTo(0.4);
  });

  it('breaks when the page grows past maxUnits', () => {
    const words = Array.from({ length: 10 }, (_, i) => w(`word${i}`, i * 0.3, i * 0.3 + 0.25));
    const pages = buildCaptionPages(words, { maxUnits: 12, maxGapMs: 10_000 });
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) expect(textUnits(p.text)).toBeLessThanOrEqual(12);
  });

  it('breaks after sentence-ending punctuation', () => {
    const pages = buildCaptionPages(
      [w('好。', 0, 0.4), w('接', 0.4, 0.6), w('下', 0.6, 0.8), w('來', 0.8, 1.0)],
      { maxGapMs: 10_000, maxUnits: 100 },
    );
    expect(pages.map((p) => p.text)).toEqual(['好。', '接下來']);
  });

  it('breaks when the page gets too long even without pauses', () => {
    const words = Array.from({ length: 12 }, (_, i) => w('字', i * 0.3, i * 0.3 + 0.28));
    const pages = buildCaptionPages(words, {
      maxDurationMs: 1000,
      maxGapMs: 10_000,
      maxUnits: 100,
    });
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) expect(p.duration).toBeLessThanOrEqual(1.0 + 0.3);
  });

  it('joins CJK without spaces and latin with spaces', () => {
    expect(buildCaptionPages([w('你', 0, 0.2), w('好', 0.2, 0.4)])[0]!.text).toBe('你好');
    expect(buildCaptionPages([w('hi', 0, 0.2), w('there', 0.2, 0.4)])[0]!.text).toBe('hi there');
    // 混排：CJK 與拉丁交界不塞空白（中文排版慣例）
    expect(buildCaptionPages([w('用', 0, 0.2), w('AI', 0.2, 0.4)])[0]!.text).toBe('用AI');
  });

  it('carries word timestamps as tokens in timeline coordinates', () => {
    const pages = buildCaptionPages([w('a', 1.0, 1.2), w('b', 1.2, 1.5)]);
    expect(pages[0]!.tokens).toEqual([
      { text: 'a', start: 1.0, end: 1.2 },
      { text: 'b', start: 1.2, end: 1.5 },
    ]);
  });

  it('omits tokens when karaoke is off', () => {
    const pages = buildCaptionPages([w('a', 0, 0.2)], { karaoke: false });
    expect(pages[0]!.tokens).toBeUndefined();
  });

  it('gives deterministic ids derived from start time', () => {
    const words = [w('a', 1.234, 1.4)];
    expect(buildCaptionPages(words)[0]!.id).toBe(buildCaptionPages(words)[0]!.id);
    expect(buildCaptionPages(words)[0]!.id).toContain('1234');
  });

  it('applies the given style to every page', () => {
    const style = { ...DEFAULT_CAPTION_STYLE, fill: '#ff0000' };
    const pages = buildCaptionPages([w('a', 0, 0.2), w('b', 3, 3.2)], {}, style);
    expect(pages).toHaveLength(2);
    for (const p of pages) expect(p.style.fill).toBe('#ff0000');
  });

  it('ignores empty words and returns [] for no input', () => {
    expect(buildCaptionPages([])).toEqual([]);
    expect(buildCaptionPages([w('  ', 0, 0.2), w('[BLANK_AUDIO]', 0.2, 0.4)])).toEqual([]);
  });
});

describe('normalizeWords', () => {
  it('clamps the 30s padding artifact down to the real duration', () => {
    // 實測 whisper.cpp：最後一個詞的 end 會是 30（內部 30 秒區塊邊界）
    const r = normalizeWords([w('next.', 8.8, 30)], 9.99);
    expect(r).toEqual([{ text: 'next.', start: 8.8, end: 9.99 }]);
  });

  it('spreads words that whisper collapsed onto one timestamp', () => {
    // 短音訊的病態輸出：五個詞全部 3.79-3.79，之後沒有其他詞
    const collapsed = ['a', 'b', 'c', 'd'].map((t) => w(t, 3.79, 3.79));
    const r = normalizeWords(collapsed, 4.19);
    expect(r.map((x) => [+x.start.toFixed(2), +x.end.toFixed(2)])).toEqual([
      [3.79, 3.89],
      [3.89, 3.99],
      [3.99, 4.09],
      [4.09, 4.19],
    ]);
  });

  it('spreads a collapsed run only up to the next real word', () => {
    const r = normalizeWords([w('a', 1, 1), w('b', 1, 1), w('c', 3, 3.4)], 10);
    expect(r[0]).toEqual({ text: 'a', start: 1, end: 2 });
    expect(r[1]).toEqual({ text: 'b', start: 2, end: 3 });
    expect(r[2]).toEqual({ text: 'c', start: 3, end: 3.4 });
  });

  it('keeps starts monotonic and inside the timeline', () => {
    const r = normalizeWords([w('a', 5, 5.5), w('b', 2, 2.5), w('c', 99, 99)], 8);
    expect(r.map((x) => x.start)).toEqual([5, 5, 8]);
    for (const x of r) expect(x.end).toBeLessThanOrEqual(8);
  });

  it('leaves healthy timestamps untouched', () => {
    const healthy = [w('a', 0, 0.6), w('b', 0.6, 1.15)];
    expect(normalizeWords(healthy, 12)).toEqual(healthy);
  });
});

describe('activeTokenIndex', () => {
  const cap = buildCaptionPages([w('a', 1.0, 1.2), w('b', 1.4, 1.6)])[0]!;

  it('is -1 before the first token', () => {
    expect(activeTokenIndex(cap, 0.5)).toBe(-1);
  });

  it('highlights the token being spoken', () => {
    expect(activeTokenIndex(cap, 1.1)).toBe(0);
    expect(activeTokenIndex(cap, 1.5)).toBe(1);
  });

  it('keeps the last spoken token lit during the gap to the next one', () => {
    // 1.2–1.4 是詞間空隙：仍停在第 0 個詞（不要閃回未高亮）
    expect(activeTokenIndex(cap, 1.3)).toBe(0);
  });

  it('stays on the last token after it ends', () => {
    expect(activeTokenIndex(cap, 99)).toBe(1);
  });

  it('is -1 for captions without tokens', () => {
    expect(activeTokenIndex({ ...cap, tokens: undefined }, 1.5)).toBe(-1);
  });
});

describe('karaokeClip', () => {
  const boxes = [
    { x: 100, y: 10, w: 50, h: 70 },
    { x: 150, y: 10, w: 60, h: 70 },
    { x: 80, y: 80, w: 90, h: 70 }, // 第二行
  ];
  it('active < 0 → null', () => {
    expect(karaokeClip(boxes, -1)).toBeNull();
  });
  it('active=0 → 只含第一個矩形', () => {
    const p = karaokeClip(boxes, 0, 0)!;
    expect(p).toBe("path('M100,10 h50 v70 h-50 Z')");
  });
  it('active=2 → 三個子路徑,含第二行', () => {
    const p = karaokeClip(boxes, 2, 0)!;
    expect(p.match(/M/g)).toHaveLength(3);
    expect(p).toContain('M80,80');
  });
  it('pad 外擴矩形', () => {
    expect(karaokeClip([boxes[0]!], 0, 4)!).toBe("path('M96,6 h58 v78 h-58 Z')");
  });
});
