import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PeaksFile } from '@vidcut/shared';
import { audioWave, clipWave, drawWaveform } from './waveform.js';

/**
 * canvas 查表（spec `2026-08-14-dual-theme-design.md` §4）。
 *
 * canvas 沒有 CSS 變數，所以波形顏色一定得在 JS 手上拿到一個字串。單一真值來源
 * 仍是 `theme.css`——這裡驗的是「真的去查了表」，以及 jsdom（無樣式表、
 * `getComputedStyle` 回空字串）下的回退不會把畫布畫成空白。
 */

/** 在 `<html>` 的 inline style 上灌 CSS 變數＝jsdom 的 getComputedStyle 讀得到的路徑 */
function setVars(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
}

beforeEach(() => {
  document.documentElement.removeAttribute('style');
});

afterEach(() => {
  document.documentElement.removeAttribute('style');
  vi.restoreAllMocks();
});

describe('clipWave() / audioWave() 查表', () => {
  it('CSS 變數存在時取其值（不是 JS 常數）', () => {
    setVars({
      '--wave-clip-peak': 'rgba(1, 2, 3, 0.1)',
      '--wave-clip-rms': 'rgba(4, 5, 6, 0.2)',
      '--wave-audio-peak': 'rgba(7, 8, 9, 0.3)',
      '--wave-audio-rms': 'rgba(10, 11, 12, 0.4)',
    });
    expect(clipWave()).toEqual({
      peakColor: 'rgba(1, 2, 3, 0.1)',
      rmsColor: 'rgba(4, 5, 6, 0.2)',
    });
    expect(audioWave()).toEqual({
      peakColor: 'rgba(7, 8, 9, 0.3)',
      rmsColor: 'rgba(10, 11, 12, 0.4)',
    });
  });

  it('前後空白會被 trim 掉（CSS 變數值常帶一個前導空白）', () => {
    setVars({ '--wave-clip-peak': '  rgba(1, 2, 3, 0.1)  ' });
    expect(clipWave().peakColor).toBe('rgba(1, 2, 3, 0.1)');
  });

  it('CSS 變數是空的（jsdom 無樣式表）時回退到暗版字面值', () => {
    expect(clipWave()).toEqual({
      peakColor: 'rgba(167, 139, 250, 0.30)',
      rmsColor: 'rgba(196, 181, 253, 0.85)',
    });
    expect(audioWave()).toEqual({
      peakColor: 'rgba(14, 165, 233, 0.30)',
      rmsColor: 'rgba(125, 211, 252, 0.85)',
    });
  });

  it('只設了其中一個變數時，另一個仍走回退（逐項各自判斷）', () => {
    setVars({ '--wave-clip-rms': 'rgba(4, 5, 6, 0.2)' });
    expect(clipWave()).toEqual({
      peakColor: 'rgba(167, 139, 250, 0.30)',
      rmsColor: 'rgba(4, 5, 6, 0.2)',
    });
  });
});

/** 極簡 canvas 樁：只收集 fillStyle 被指派過哪些值 */
function stubCanvas(): { fills: string[]; cv: HTMLCanvasElement } {
  const fills: string[] = [];
  const ctx = {
    scale: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    set fillStyle(v: string) {
      fills.push(v);
    },
    get fillStyle(): string {
      return fills[fills.length - 1] ?? '';
    },
  };
  const cv = document.createElement('canvas');
  Object.defineProperty(cv, 'clientWidth', { configurable: true, value: 20 });
  Object.defineProperty(cv, 'clientHeight', { configurable: true, value: 10 });
  cv.getContext = vi.fn(() => ctx) as unknown as HTMLCanvasElement['getContext'];
  return { fills, cv };
}

const peaks: PeaksFile = {
  sampleRate: 100,
  samplesPerBucket: 1,
  peaks: [0.5, 0.4, 0.3, 0.2],
  rms: [0.2, 0.1, 0.1, 0.1],
};

describe('drawWaveform 的中線色', () => {
  it('讀 --wave-midline', () => {
    setVars({ '--wave-midline': 'rgba(1, 1, 1, 0.5)' });
    const { fills, cv } = stubCanvas();
    drawWaveform(cv, peaks, { from: 0, duration: 0.04, peakColor: 'a', rmsColor: 'b' });
    expect(fills).toContain('rgba(1, 1, 1, 0.5)');
  });

  it('無 CSS 變數時回退到暗版字面值', () => {
    const { fills, cv } = stubCanvas();
    drawWaveform(cv, peaks, { from: 0, duration: 0.04, peakColor: 'a', rmsColor: 'b' });
    expect(fills).toContain('rgba(230, 231, 240, 0.18)');
  });

  it('midline:false 時完全不畫中線', () => {
    setVars({ '--wave-midline': 'rgba(1, 1, 1, 0.5)' });
    const { fills, cv } = stubCanvas();
    drawWaveform(cv, peaks, {
      from: 0,
      duration: 0.04,
      peakColor: 'a',
      rmsColor: 'b',
      midline: false,
    });
    expect(fills).not.toContain('rgba(1, 1, 1, 0.5)');
  });
});
