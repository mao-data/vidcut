import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { CaptionLayer, __resetCaptionGeoCacheForTests } from './CaptionLayer.js';
import type { CaptionItem } from '@vidcut/shared';

const CAP: CaptionItem = {
  id: 'c1', text: '你好世界', start: 0, duration: 2,
  style: { fontFamily: 'PingFang TC', fontSize: 64, fill: '#ffffff', y: 0.72, highlight: '#FCDE5A' },
  tokens: [
    { text: '你好', start: 0, end: 1 },
    { text: '世界', start: 1, end: 2 },
  ],
};
// Latin caption fixture — CJK-only CAP above can't exercise the space-vs-no-space branch
// (finding 2: separator() 的規則要在拉丁詞之間才看得出差別).
const CAP_LATIN: CaptionItem = {
  id: 'c2', text: 'second line', start: 0, duration: 2,
  style: { fontFamily: 'sans-serif', fontSize: 48, fill: '#ffffff', y: 0.8 },
  tokens: [
    { text: 'second', start: 0, end: 1 },
    { text: 'line', start: 1, end: 2 },
  ],
};
const META = { width: 1080, height: 92, lines: 1, tokens: [
  { x: 400, y: 8, w: 128, h: 76 }, { x: 528, y: 8, w: 128, h: 76 },
] };

beforeEach(() => {
  __resetCaptionGeoCacheForTests();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => META })));
});

describe('CaptionLayer', () => {
  it('有卡:render base img,播放到第二詞時 hl img 有 2 個矩形的 clip-path', async () => {
    const { container } = render(
      <CaptionLayer captions={[CAP]} cards={{ c1: 'abc123' }} time={1.5} />,
    );
    await waitFor(() => {
      const imgs = container.querySelectorAll('img');
      expect(imgs).toHaveLength(2);
      expect(imgs[0]!.getAttribute('src')).toBe('/text-card/abc123.base.png');
      expect(imgs[1]!.getAttribute('src')).toBe('/text-card/abc123.hl.png');
      expect(imgs[1]!.style.clipPath).toContain('M');
    });
  });
  it('無卡:DOM 文字 fallback,字級為全尺寸 64px(1080 空間)', () => {
    const { container } = render(<CaptionLayer captions={[CAP]} cards={{}} time={0.5} />);
    expect(container.querySelector('img')).toBeNull();
    const div = [...container.querySelectorAll('div')].find((d) => d.textContent?.includes('你好'))!;
    expect(div.style.fontSize).toBe('64px');
  });

  // ---- Finding 1: 失敗的 geometry fetch 不得讓字幕永久消失 ----
  it('geometry fetch 404:退回 DOM fallback,不是空白(不永久消失)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const { container } = render(
      <CaptionLayer captions={[CAP]} cards={{ c1: 'deadhash' }} time={0.5} />,
    );
    await waitFor(() => {
      expect(container.querySelector('img')).toBeNull();
      const div = [...container.querySelectorAll('div')].find((d) => d.textContent?.includes('你好'))!;
      expect(div.style.fontSize).toBe('64px');
    });
  });

  it('geometry fetch 失敗不永久快取——之後重新掛載會重試', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => META });
    vi.stubGlobal('fetch', fetchMock);

    const first = render(<CaptionLayer captions={[CAP]} cards={{ c1: 'retryhash' }} time={1.5} />);
    await waitFor(() => expect(first.container.querySelector('img')).toBeNull());
    first.unmount();

    const second = render(<CaptionLayer captions={[CAP]} cards={{ c1: 'retryhash' }} time={1.5} />);
    await waitFor(() => expect(second.container.querySelectorAll('img')).toHaveLength(2));
  });

  it('base.png 載入失敗(onError):退回 DOM fallback,不留一張看不到的卡', async () => {
    const { container } = render(
      <CaptionLayer captions={[CAP]} cards={{ c1: 'badimg' }} time={1.5} />,
    );
    const base = await waitFor(() => {
      const el = container.querySelector('img[src="/text-card/badimg.base.png"]');
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.error(base);
    await waitFor(() => {
      expect(container.querySelector('img')).toBeNull();
      const div = [...container.querySelectorAll('div')].find((d) => d.textContent?.includes('你好'))!;
      expect(div.style.fontSize).toBe('64px');
    });
  });

  // ---- Finding 2: DOM fallback 要用 CJK-aware separator,不是黏在一起 ----
  it('無卡 fallback 的拉丁詞之間要有空格(second line,不是 secondline)', () => {
    const { container } = render(<CaptionLayer captions={[CAP_LATIN]} cards={{}} time={0.5} />);
    const second = [...container.querySelectorAll('span')].find((s) => s.textContent === 'second')!;
    const line = [...container.querySelectorAll('span')].find((s) => s.textContent === 'line')!;
    expect(second.parentElement).toBe(line.parentElement);
    expect(second.parentElement!.textContent).toBe('second line');
  });

  // ---- Finding 3: hash 換了不能沿用舊 hash 的 geometry ----
  it('hash 變更時不沿用舊 geometry(新卡片抵達前寧可空一幀,不畫錯尺寸/clip)', async () => {
    let resolveHash2: (v: { ok: boolean; json: () => Promise<unknown> }) => void = () => {};
    const hash2Promise = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
      resolveHash2 = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('hash1')) return Promise.resolve({ ok: true, json: async () => META });
        return hash2Promise;
      }),
    );

    const { container, rerender } = render(
      <CaptionLayer captions={[CAP]} cards={{ c1: 'hash1' }} time={1.5} />,
    );
    await waitFor(() =>
      expect(container.querySelector('img[src="/text-card/hash1.base.png"]')).not.toBeNull(),
    );

    rerender(<CaptionLayer captions={[CAP]} cards={{ c1: 'hash2' }} time={1.5} />);
    // hash2 的 geometry 還沒回來:不得用 hash1 的舊 geo 畫 hash2 的圖(尺寸/clip 會對不上)
    expect(container.querySelector('img[src="/text-card/hash1.base.png"]')).toBeNull();
    expect(container.querySelector('img[src="/text-card/hash2.base.png"]')).toBeNull();

    resolveHash2({ ok: true, json: async () => ({ ...META, width: 999 }) });
    await waitFor(() => {
      const img = container.querySelector('img[src="/text-card/hash2.base.png"]');
      expect(img).not.toBeNull();
      expect(img!.getAttribute('width')).toBe('999'); // 用的是 hash2 自己的 geometry
    });
  });
});
