import { describe, it, expect, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { Timeline } from './Timeline.js';
import { useView } from '../stores/view.js';
import { seedProject, resetStores } from '../test/fixtures.js';

/**
 * Ctrl/⌘+滾輪縮放的**掛載時序**。
 *
 * 這裡刻意重現真實 app 的順序:mount 時 doc 還沒從 WS 抵達(Timeline 首次
 * render `return null`),專案稍後才進來。wheel listener 是 `useEffect` 裡的
 * `addEventListener`——若 effect 只在首渲染跑一次(空 deps),那一次拿到的
 * `scrollRef.current` 是 null,listener 永遠掛不上,Ctrl+滾輪縮放整個是死的、
 * 而且**不會有任何錯誤**(ui-verification.md 記過的 useRef+空 deps 陷阱;
 * 這隻 bug 從功能加入起就在,2026-08-16 真瀏覽器探針才抓到——事件到達容器
 * 但 defaultPrevented 恆為 false)。
 *
 * 先 render 再 seed,缺 re-attach 的版本必紅;mutant `tl-wheel-attach-deps`
 * 守著 deps 不被改回 []。
 */

beforeEach(() => {
  resetStores();
});

describe('Ctrl+滾輪縮放 listener 掛載時序', () => {
  it('doc 在 mount 之後才抵達:ctrl+wheel 仍要能縮放', () => {
    const { container } = render(<Timeline />); // doc=null → 首渲染 null
    act(() => {
      seedProject(); // 專案抵達 → 這一輪 re-render 才長出 DOM
    });
    const well = container.querySelector('div[style*="overflow: auto"]');
    expect(well).not.toBeNull();
    const before = useView.getState().pxPerSecond;
    act(() => {
      well!.dispatchEvent(
        new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true }),
      );
    });
    expect(useView.getState().pxPerSecond).toBeGreaterThan(before);
  });

  it('不帶修飾鍵的 wheel 不縮放(那是捲動,不能被縮放搶走)', () => {
    const { container } = render(<Timeline />);
    act(() => {
      seedProject();
    });
    const well = container.querySelector('div[style*="overflow: auto"]')!;
    const before = useView.getState().pxPerSecond;
    act(() => {
      well.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }),
      );
    });
    expect(useView.getState().pxPerSecond).toBe(before);
  });
});
