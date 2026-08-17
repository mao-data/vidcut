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
// jsdom 也沒有 `Element.scrollTo`（Chat 分頁的「新訊息捲到底」會呼叫）。
// 同上：環境邊界補在這裡，不逐檔補、也不為了測試在產品碼裡加 `typeof` 守衛。
Element.prototype.scrollTo = vi.fn();

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

// 7) fetch 的相對 URL：Node 的 global fetch（undici）不像瀏覽器會把相對路徑解成
//    document.baseURI，遇到 `/api/fonts` 這種相對 URL 直接丟 TypeError（Invalid URL）
//    而不是打去 origin。App 掛載一律會發這種請求（@font-face 注入,Task 12）——
//    這裡補一個環境邊界的預設：相對路徑一律當成打不到（404），不讓它把測試炸成
//    unhandled rejection。個別測試要驗證真實回應時，照舊用 vi.stubGlobal('fetch', ...)
//    蓋過這個預設值（vitest 每個測試檔獨立 module registry，不會互相汙染）。
const realFetch = globalThis.fetch?.bind(globalThis);
if (realFetch) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('/')) return Promise.resolve(new Response(null, { status: 404 }));
    return realFetch(input, init);
  }) as typeof fetch;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
