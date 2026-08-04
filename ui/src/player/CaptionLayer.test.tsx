import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { CaptionLayer } from './CaptionLayer.js';
import type { CaptionItem } from '@vidcut/shared';

const CAP: CaptionItem = {
  id: 'c1', text: '你好世界', start: 0, duration: 2,
  style: { fontFamily: 'PingFang TC', fontSize: 64, fill: '#ffffff', y: 0.72, highlight: '#FCDE5A' },
  tokens: [
    { text: '你好', start: 0, end: 1 },
    { text: '世界', start: 1, end: 2 },
  ],
};
const META = { width: 1080, height: 92, lines: 1, tokens: [
  { x: 400, y: 8, w: 128, h: 76 }, { x: 528, y: 8, w: 128, h: 76 },
] };

beforeEach(() => {
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
});
