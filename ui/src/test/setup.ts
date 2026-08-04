import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * jsdom 缺的**環境邊界**補齊——只補瀏覽器 API，不碰任何應用邏輯
 * （anti-gaming rule 3：mock 邊界，不 mock 被測單元）。
 */

// 1) HTMLMediaElement：jsdom 對 play/pause/load 拋 "Not implemented"。
//    play/pause 同時要能被觀測（Player 的播放決策就是靠它們表達）。
Object.defineProperty(HTMLMediaElement.prototype, 'play', {
  configurable: true,
  writable: true,
  value: vi.fn(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false });
    return Promise.resolve();
  }),
});
Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
  configurable: true,
  writable: true,
  value: vi.fn(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: true });
  }),
});
Object.defineProperty(HTMLMediaElement.prototype, 'load', {
  configurable: true,
  writable: true,
  value: vi.fn(),
});
// jsdom 的 paused 唯讀恆 true；改成可寫入的實例屬性，預設仍是 true
Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
  configurable: true,
  get() {
    return true;
  },
});

// 2) canvas 2D context：波形繪製會呼叫，jsdom 無實作
HTMLCanvasElement.prototype.getContext = vi.fn(
  () =>
    ({
      scale: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      fillStyle: '',
    }) as unknown as CanvasRenderingContext2D,
) as unknown as HTMLCanvasElement['getContext'];

// 3) Pointer capture：jsdom 未實作，Timeline 拖曳一定會呼叫
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();
Element.prototype.hasPointerCapture = vi.fn(() => false);
Element.prototype.scrollIntoView = vi.fn();

// 4) matchMedia：motionOK() 讀 prefers-reduced-motion
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// 5) ResizeObserver：jsdom 無實作。Player 量 stage 寬（1080 座標空間縮放係數）要用，
//    任何會 mount Player 的測試（直接或經 App/面板）都需要——放在全域邊界，不要逐檔補。
if (typeof window.ResizeObserver === 'undefined') {
  class ResizeObserverPolyfill {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.ResizeObserver = ResizeObserverPolyfill as unknown as typeof ResizeObserver;
}

// 6) PointerEvent：舊 jsdom 沒有；用 MouseEvent 補出拖曳測試需要的欄位
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
