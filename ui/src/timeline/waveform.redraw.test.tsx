import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { AudioChip } from './AudioChip.js';
import { useTheme } from '../stores/theme.js';
import * as waveform from './waveform.js';
import { __resetPeaksCacheForTests } from './usePeaks.js';
import { demoProject, resetStores } from '../test/fixtures.js';

/**
 * 主題切換 → 波形重畫（spec `2026-08-14-dual-theme-design.md` §4）。
 *
 * canvas 是 imperative 的：CSS 變數換了它不會自己重繪，一定要有人再呼叫一次
 * `drawWaveform`。這裡驗的就是那條線——`useEffect` 的依賴陣列裡有沒有 theme。
 * 沒有的話，切到亮版時波形會維持暗版紫色留在紙上，而且**不會有任何錯誤**。
 */

// peaks 走 fetch：給一份最小的 PeaksFile，讓 draw 這條路徑真的會被走到
const peaksFile = {
  sampleRate: 100,
  samplesPerBucket: 1,
  peaks: [0.5, 0.4, 0.3, 0.2],
  rms: [0.2, 0.1, 0.1, 0.1],
};

beforeEach(() => {
  resetStores();
  __resetPeaksCacheForTests();
  useTheme.setState({ theme: 'dark' });
  document.documentElement.removeAttribute('data-theme');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(peaksFile), { status: 200 }))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-theme');
});

/** 等 usePeaks 的 fetch 解析完並讓 React flush */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('主題切換觸發波形重畫', () => {
  // ClipBlock 的重畫測試已隨「主軌不顯示波形帶」(2026-08-16 使用者定案)移除——
  // 主軌不再有 canvas。機制與 token 保留,音訊軌仍走同一條線(下面這條測試守著)。
  it('AudioChip：切到 paper 之後 drawWaveform 被再次呼叫', async () => {
    const spy = vi.spyOn(waveform, 'drawWaveform');
    const p = demoProject();
    render(
      <AudioChip p={p} a={p.tracks.audio[0]} pps={40} selected={false} onDragStart={() => {}} />,
    );
    await settle();
    const before = spy.mock.calls.length;
    expect(before).toBeGreaterThan(0);

    await act(async () => {
      useTheme.getState().setTheme('paper');
    });
    expect(spy.mock.calls.length).toBeGreaterThan(before);
  });
});
