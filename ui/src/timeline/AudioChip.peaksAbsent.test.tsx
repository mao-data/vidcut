import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { AudioChip } from './AudioChip.js';
import * as waveform from './waveform.js';
import { __resetPeaksCacheForTests } from './usePeaks.js';
import { demoProject, resetStores } from '../test/fixtures.js';

/**
 * Plan 8 Task 4：分階段 ingest 下 `peaksPath` 的過渡態查證。
 *
 * A0 探測時媒體就註冊進 doc，但 `peaksPath` 是背景 patch 之後才補上——期間
 * UI 會拿到 `media.peaksPath === undefined` 去 render。這裡釘住 `usePeaks.ts`／
 * `AudioChip.tsx` 對三種過渡態都安全：
 *   1. 缺席：完全不 fetch，canvas 保持空白，不炸
 *   2. fetch 404（伺服器還沒生出 peaks.json，或 R2 直傳跳過某些 derived）：
 *      不拋 unhandled rejection，波形照樣不畫
 *   3. 遲到：doc patch 把 peaksPath 從 undefined 補上之後，元件會自己補畫
 *      （不需要整個 AudioChip remount）
 */

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  resetStores();
  __resetPeaksCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('peaksPath 缺席容忍（AudioChip / usePeaks）', () => {
  it('peaksPath 為 undefined：不 fetch、不畫波形、不拋錯', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const drawSpy = vi.spyOn(waveform, 'drawWaveform');

    const p = demoProject();
    // 模擬 A0 剛註冊、derived 尚未產生：拿掉 audio item 所引用媒體的 peaksPath
    const media = p.media.find((m) => m.id === p.tracks.audio[0].mediaId)!;
    media.peaksPath = undefined;

    render(
      <AudioChip p={p} a={p.tracks.audio[0]} pps={40} selected={false} onDragStart={() => {}} />,
    );
    await settle();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(drawSpy).not.toHaveBeenCalled();
  });

  it('peaksPath 存在但 fetch 404：不拋 unhandled rejection、不畫波形', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
    );
    const drawSpy = vi.spyOn(waveform, 'drawWaveform');

    const p = demoProject();
    render(
      <AudioChip p={p} a={p.tracks.audio[0]} pps={40} selected={false} onDragStart={() => {}} />,
    );
    await settle();
    await settle();

    expect(drawSpy).not.toHaveBeenCalled();
  });

  it('peaksPath 從 undefined 遲到補上（doc patch）：元件自行補畫波形', async () => {
    const peaksFile = {
      sampleRate: 100,
      samplesPerBucket: 1,
      peaks: [0.5, 0.4, 0.3, 0.2],
      rms: [0.2, 0.1, 0.1, 0.1],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(peaksFile), { status: 200 }))),
    );
    const drawSpy = vi.spyOn(waveform, 'drawWaveform');

    const p = demoProject();
    const media = p.media.find((m) => m.id === p.tracks.audio[0].mediaId)!;
    media.peaksPath = undefined;

    const { rerender } = render(
      <AudioChip p={p} a={p.tracks.audio[0]} pps={40} selected={false} onDragStart={() => {}} />,
    );
    await settle();
    expect(drawSpy).not.toHaveBeenCalled();

    // 背景 patch 補上 peaksPath 之後重新渲染（同一個物件的新版本，比照 WS doc patch 落地後的 re-render）
    const p2 = { ...p, media: p.media.map((m) => ({ ...m })) };
    const media2 = p2.media.find((m) => m.id === p2.tracks.audio[0].mediaId)!;
    media2.peaksPath = 'derived/m2/peaks.json';

    rerender(
      <AudioChip p={p2} a={p2.tracks.audio[0]} pps={40} selected={false} onDragStart={() => {}} />,
    );
    await settle();

    expect(drawSpy).toHaveBeenCalled();
  });
});
