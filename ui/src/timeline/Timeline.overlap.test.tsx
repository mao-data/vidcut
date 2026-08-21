import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { render } from '@testing-library/react';
import { Timeline } from './Timeline.js';
import { demoProject, seedProject, resetStores } from '../test/fixtures.js';
import { useView } from '../stores/view.js';

/**
 * Plan 11 Task 4（裁決 7）：同軌重疊視覺提示的 DOM 層驗證——絕對時間軌
 * （audio／caption／overlay）上兩個項目同軌重疊時，在重疊區間畫一條
 * `.overlap-line`；不重疊則完全不畫。座標換算同 Timeline.test.tsx：
 * PPS=40 固定、STUB_CLIENT_WIDTH 讓掛載時的自動 fit 落在同一個值上。
 */
const PPS = 40;
const STUB_CLIENT_WIDTH = 472;

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return STUB_CLIENT_WIDTH;
    },
  });
});

beforeEach(() => {
  resetStores();
  useView.setState({ pxPerSecond: PPS, snapEnabled: false });
});

describe('同軌重疊視覺提示', () => {
  it('caption 軌兩項重疊時，重疊區間畫出 danger 線', () => {
    const doc = demoProject();
    // cap1 是 start:1 duration:3 → [1,4)；改第二句到 [3,6) 與它重疊 [3,4)
    doc.tracks.captions[1]!.start = 3;
    doc.tracks.captions[1]!.duration = 3;
    seedProject(doc);
    const { container } = render(<Timeline />);
    const lines = container.querySelectorAll('.overlap-line');
    expect(lines.length).toBeGreaterThan(0);
    // 重疊子區間 [3,4) → left = 3*PPS = 120，width = 1*PPS = 40
    const lefts = Array.from(lines).map((l) => (l as HTMLElement).style.left);
    const widths = Array.from(lines).map((l) => (l as HTMLElement).style.width);
    expect(lefts).toContain(`${3 * PPS}px`);
    expect(widths).toContain(`${1 * PPS}px`);
  });

  it('caption 軌不重疊時完全沒有 danger 線', () => {
    // demoProject 預設 cap1=[1,4)、cap2=[5,8)：不重疊
    const doc = demoProject();
    seedProject(doc);
    const { container } = render(<Timeline />);
    expect(container.querySelectorAll('.overlap-line')).toHaveLength(0);
  });

  it('overlay 軌兩項重疊時畫出 danger 線（含 anchor 解析後的窗口）', () => {
    const doc = demoProject();
    // ovAbs: start:1 duration:3 → [1,4)。ovAnchor 錨定 c2（clip start=6）+offset 0.5
    // → start=6.5，duration:2 → [6.5,8.5)：預設不重疊。把 ovAnchor 的 offset
    // 改成 -5，讓它的窗口變成 [1,3)（6 + -5 = 1），與 ovAbs 的 [1,4) 重疊 [1,3)。
    doc.tracks.overlays[1]!.anchor = { clipId: 'c2', offset: -5 };
    seedProject(doc);
    const { container } = render(<Timeline />);
    const lines = container.querySelectorAll('.overlap-line');
    expect(lines.length).toBeGreaterThan(0);
    const lefts = Array.from(lines).map((l) => (l as HTMLElement).style.left);
    const widths = Array.from(lines).map((l) => (l as HTMLElement).style.width);
    expect(lefts).toContain(`${1 * PPS}px`);
    expect(widths).toContain(`${2 * PPS}px`);
  });

  it('overlay 軌不重疊時完全沒有 danger 線', () => {
    const doc = demoProject();
    seedProject(doc);
    const { container } = render(<Timeline />);
    // demoProject 的兩個 overlay 預設不重疊：ovAbs=[1,4)、ovAnchor=[6.5,8.5)
    expect(container.querySelectorAll('.overlap-line')).toHaveLength(0);
  });

  it('audio 軌重疊時畫出 danger 線', () => {
    const doc = demoProject();
    // a1 是 start:2 duration:5 → [2,7)。加一個 a2 = [5,9)，重疊 [5,7)
    doc.tracks.audio.push({
      id: 'a2',
      mediaId: 'm2',
      start: 5,
      in: 0,
      duration: 4,
      volume: 1,
      label: 'sfx',
    });
    seedProject(doc);
    const { container } = render(<Timeline />);
    const lines = container.querySelectorAll('.overlap-line');
    expect(lines.length).toBeGreaterThan(0);
    const lefts = Array.from(lines).map((l) => (l as HTMLElement).style.left);
    const widths = Array.from(lines).map((l) => (l as HTMLElement).style.width);
    expect(lefts).toContain(`${5 * PPS}px`);
    expect(widths).toContain(`${2 * PPS}px`);
  });

  it('main 軌（video）沒有重疊線邏輯——磁性排列本就不會重疊', () => {
    // 這裡不需要特別建構重疊情境（主軌結構上不可能重疊），只驗證有
    // clip 存在時主軌區域內不會意外出現 .overlap-line（防止未來誤把主軌也接上）。
    const doc = demoProject();
    seedProject(doc);
    const { container } = render(<Timeline />);
    // 全域目前也沒有其他重疊，總數應為 0；這條測試與上面「不重疊時完全沒有」
    // 重複驗證同一件事，但明確標註主軌不適用本機制，供後續讀者對照裁決 7。
    expect(container.querySelectorAll('.overlap-line')).toHaveLength(0);
  });
});
