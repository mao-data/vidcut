import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { CaptionLayer, __resetCaptionGeoCacheForTests } from './CaptionLayer.js';
import type { CaptionItem } from '@vidcut/shared';

const CAP: CaptionItem = {
  id: 'c1',
  text: '你好世界',
  start: 0,
  duration: 2,
  style: {
    fontFamily: 'PingFang TC',
    fontSize: 64,
    fill: '#ffffff',
    y: 0.72,
    highlight: '#FCDE5A',
  },
  tokens: [
    { text: '你好', start: 0, end: 1 },
    { text: '世界', start: 1, end: 2 },
  ],
};
// Latin caption fixture — CJK-only CAP above can't exercise the space-vs-no-space branch
// (finding 2: separator() 的規則要在拉丁詞之間才看得出差別).
const CAP_LATIN: CaptionItem = {
  id: 'c2',
  text: 'second line',
  start: 0,
  duration: 2,
  style: { fontFamily: 'sans-serif', fontSize: 48, fill: '#ffffff', y: 0.8 },
  tokens: [
    { text: 'second', start: 0, end: 1 },
    { text: 'line', start: 1, end: 2 },
  ],
};
const META = {
  width: 1080,
  height: 92,
  lines: 1,
  tokens: [
    { x: 400, y: 8, w: 128, h: 76 },
    { x: 528, y: 8, w: 128, h: 76 },
  ],
};

beforeEach(() => {
  __resetCaptionGeoCacheForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => META })),
  );
});

describe('CaptionLayer', () => {
  // 這是「兩張卡 + clip-path 揭色」整套機制唯一的自動化守門,所以斷言的是**確切的
  // 揭色邊界**,不是「clipPath 裡有個 M」——後者對任何 active index(甚至錯的軸、錯的
  // 位移)都會通過。META 的兩個 token bbox 是 (400,8,128,76) 與 (528,8,128,76),
  // CAP 的詞起點是 0 與 1s,無 stroke → pad=0,所以每個時間點的 clip 都算得出來:
  //   t=0.5 → active 0 → 只揭第一個詞;t=1.5 → active 1 → 兩個詞都揭。
  // off-by-one(揭多/揭少一詞)、換軸(h/v 對調)、pad 算錯,任何一種都會讓字串對不上。
  const RECT0 = 'M400,8 h128 v76 h-128 Z';
  const RECT1 = 'M528,8 h128 v76 h-128 Z';

  it('有卡:render base img,播放到第二詞時 hl img 的 clip 剛好蓋住前兩個詞', async () => {
    const { container } = render(
      <CaptionLayer captions={[CAP]} cards={{ c1: 'abc123' }} time={1.5} />,
    );
    await waitFor(() => {
      const imgs = container.querySelectorAll('img');
      expect(imgs).toHaveLength(2);
      expect(imgs[0]!.getAttribute('src')).toBe('/text-card/abc123.base.png');
      expect(imgs[1]!.getAttribute('src')).toBe('/text-card/abc123.hl.png');
      expect(imgs[1]!.style.clipPath).toBe(`path('${RECT0} ${RECT1}')`);
      // 兩張卡必須同尺寸同位置疊著,不然揭出來的色塊會對不到底下的字
      expect(imgs[1]!.getAttribute('width')).toBe(imgs[0]!.getAttribute('width'));
      expect(imgs[1]!.getAttribute('height')).toBe(imgs[0]!.getAttribute('height'));
      expect(imgs[1]!.style.left).toBe('0px');
      expect(imgs[1]!.style.top).toBe('0px');
    });
  });

  it('播放到第一詞時只揭第一個詞（off-by-one 會在這裡露餡）', async () => {
    const { container } = render(
      <CaptionLayer captions={[CAP]} cards={{ c1: 'abc123' }} time={0.5} />,
    );
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(2));
    expect(container.querySelectorAll('img')[1]!.style.clipPath).toBe(`path('${RECT0}')`);
  });

  it('還沒到第一個詞:hl 圖整張不掛（不是先揭再說）', async () => {
    const capLater: CaptionItem = {
      ...CAP,
      tokens: [
        { text: '你好', start: 1, end: 1.5 },
        { text: '世界', start: 1.5, end: 2 },
      ],
    };
    const { container } = render(
      <CaptionLayer captions={[capLater]} cards={{ c1: 'abc123' }} time={0.5} />,
    );
    await waitFor(() =>
      expect(container.querySelector('img[src="/text-card/abc123.base.png"]')).not.toBeNull(),
    );
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });
  it('無卡:DOM 文字 fallback,字級為全尺寸 64px(1080 空間)', () => {
    const { container } = render(<CaptionLayer captions={[CAP]} cards={{}} time={0.5} />);
    expect(container.querySelector('img')).toBeNull();
    const div = [...container.querySelectorAll('div')].find((d) =>
      d.textContent?.includes('你好'),
    )!;
    expect(div.style.fontSize).toBe('64px');
  });

  it('DOM fallback 的字不可被選取(選得到字 → 第二次拖曳會被判成原生 text drag → 拖曳靜默失敗)', () => {
    // 字卡那條路徑是兩張 draggable={false} 的 <img>、沒有文字節點,天生免疫;
    // 這條 DOM fallback 是真的文字,在字上按下再移動就會選到字(真 Chromium 實測會發
    // selectstart),而從**已選取的文字**上開始的下一次拖曳會被瀏覽器接管成 text drag:
    // dragstart → pointercancel,自訂的 pointer 拖曳手勢被攔腰砍斷(CLAUDE.md「UI 驗證的
    // 陷阱」記過的同一種靜默失敗)。加了 user-select:none 之後實測 selectstart 不再出現。
    const { container } = render(<CaptionLayer captions={[CAP]} cards={{}} time={0.5} />);
    const div = [...container.querySelectorAll('div')].find((d) =>
      d.textContent?.includes('你好'),
    )!;
    expect(div.style.userSelect).toBe('none');
  });

  // ---- Finding 1: 失敗的 geometry fetch 不得讓字幕永久消失 ----
  it('geometry fetch 404:退回 DOM fallback,不是空白(不永久消失)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    const { container } = render(
      <CaptionLayer captions={[CAP]} cards={{ c1: 'deadhash' }} time={0.5} />,
    );
    await waitFor(() => {
      expect(container.querySelector('img')).toBeNull();
      const div = [...container.querySelectorAll('div')].find((d) =>
        d.textContent?.includes('你好'),
      )!;
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
      const div = [...container.querySelectorAll('div')].find((d) =>
        d.textContent?.includes('你好'),
      )!;
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

  // ---- Task 12: 打字三段式的 draft 覆寫 ----
  it('draft 命中該句且無 previewHash:顯示 draft.text 的 DOM 近似,忽略舊 tokens(不高亮)', () => {
    const { container } = render(
      <CaptionLayer
        captions={[CAP]}
        cards={{ c1: 'abc123' }} // 就算已有成品卡,draft 命中時也要蓋過
        time={1.5} // 落在第二詞(舊 tokens)的時間點
        draft={{ id: 'c1', text: '哈囉世界', previewHash: null }}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    const div = [...container.querySelectorAll('div')].find((d) =>
      d.textContent?.includes('哈囉世界'),
    );
    expect(div).toBeDefined();
    // 舊 tokens('你好'/'世界')沒有被拿來切詞高亮——整句就是純文字,沒有內層 <span>
    expect(div!.querySelector('span')).toBeNull();
  });

  it('draft 命中該句且 previewHash 有值:用 draft.previewHash 當單卡(不是 cards[id] 那顆舊卡)', async () => {
    const { container } = render(
      <CaptionLayer
        captions={[CAP]}
        cards={{ c1: 'abc123' }}
        time={1.5}
        draft={{ id: 'c1', text: '哈囉世界', previewHash: 'draftHash' }}
      />,
    );
    await waitFor(() => {
      const img = container.querySelector('img[src="/text-card/draftHash.base.png"]');
      expect(img).not.toBeNull();
    });
    expect(container.querySelector('img[src="/text-card/abc123.base.png"]')).toBeNull();
    // 只有一張圖 = 沒有 hl 層 = 草稿不高亮。理由**不是**「geometry 沒有 tokens」——
    // 這裡的 fetch mock 回的 META 是有 tokens 的(舊卡的幾何)。真正的原因是
    // CaptionLayer 把 draftCap 的 `tokens` 剝成 undefined,activeTokenIndex 因此回 -1,
    // karaokeClip(active<0) 回 null → hl 圖不掛。這條就是「不得拿改字前的舊詞界去
    // 高亮新文字」的守門(拿掉 `tokens: undefined` 的話 t=1.5 會揭到第二個詞,這裡會變 2 張)。
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });

  it('draft 不命中任何一句時,其他句照常走 cards/ApproxCaption 原本邏輯', () => {
    const { container } = render(
      <CaptionLayer
        captions={[CAP]}
        cards={{}}
        time={0.5}
        draft={{ id: 'other-id', text: 'x', previewHash: null }}
      />,
    );
    const div = [...container.querySelectorAll('div')].find((d) => d.textContent?.includes('你好'));
    expect(div).toBeDefined();
  });
});
