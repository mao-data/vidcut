import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ClipBlock } from './ClipBlock.js';
import { demoProject } from '../test/fixtures.js';

/**
 * Plan 9 Task 3：filmstrip 時間對齊逐格渲染 + windowing 的元件層驗證。
 * 純數學已由 `filmstripTiles.test.ts` 蓋住，這裡只驗證 ClipBlock 有沒有
 * 把數學結果正確轉成 DOM（tile 數量、windowing 生效、相容分支）。
 *
 * `data-testid="filmstrip-tile"` 是新加的掛鉤——舊實作只有一個 background div，
 * 沒有可數的「格」，這裡的測試本身就要求元件改成逐格渲染。
 */

const noop = () => {};

describe('ClipBlock filmstrip：逐格渲染', () => {
  it('無 filmstrip（media 沒有 filmstripPath）→ 底色，不渲染任何 tile', () => {
    const p = demoProject();
    const media = p.media.find((m) => m.id === p.tracks.video[1].mediaId)!; // m2 沒有 filmstripPath
    expect(media.filmstripPath).toBeUndefined();
    const clip = p.tracks.video[1];

    const { container } = render(
      <ClipBlock
        p={p}
        clip={{ ...clip, frozen: false }}
        leftPx={0}
        pps={40}
        selected={false}
        animate={false}
        floating={false}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
      />,
    );

    expect(container.querySelectorAll('[data-testid="filmstrip-tile"]')).toHaveLength(0);
  });

  it('frozen clip → 不渲染任何 tile（即使 media 有 filmstripPath）', () => {
    const p = demoProject();
    const clip = p.tracks.video[0]; // c1 → m1，m1 有 filmstripPath
    const media = p.media.find((m) => m.id === clip.mediaId)!;
    expect(media.filmstripPath).toBeDefined();

    const { container } = render(
      <ClipBlock
        p={p}
        clip={{ ...clip, frozen: true }}
        leftPx={0}
        pps={40}
        selected={false}
        animate={false}
        floating={false}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
      />,
    );

    expect(container.querySelectorAll('[data-testid="filmstrip-tile"]')).toHaveLength(0);
  });

  it('有 filmstrip 且未 frozen → 渲染至少一個 tile', () => {
    const p = demoProject();
    const clip = p.tracks.video[0]; // c1: in=2, duration=6 → m1

    const { container } = render(
      <ClipBlock
        p={p}
        clip={clip}
        leftPx={0}
        pps={40}
        selected={false}
        animate={false}
        floating={false}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
      />,
    );

    const tiles = container.querySelectorAll('[data-testid="filmstrip-tile"]');
    expect(tiles.length).toBeGreaterThan(0);
  });

  it('w < frameW（極窄 clip）→ 仍渲染恰好一個 tile（消失 bug 修法）', () => {
    const p = demoProject();
    const clip = { ...p.tracks.video[0], duration: 0.05 }; // 極短

    const { container } = render(
      <ClipBlock
        p={p}
        clip={clip}
        leftPx={0}
        pps={5} // clipWidthPx = 0.25px，遠小於 frameW
        selected={false}
        animate={false}
        floating={false}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
      />,
    );

    const tiles = container.querySelectorAll('[data-testid="filmstrip-tile"]');
    expect(tiles).toHaveLength(1);
  });
});

describe('ClipBlock filmstrip：windowing（視窗外格不進 DOM）', () => {
  it('visibleRange 只覆蓋 clip 的一小段時，DOM 裡的 tile 數量遠少於「全渲染」', () => {
    const p = demoProject();
    // 造一個很長的 clip 撐開 tile 數：60s duration, pps=40 → 2400px 寬,
    // frameW ≈ (70-4)*1080/1920 ≈ 37px → 約 65 格全渲染。
    const longClip = { ...p.tracks.video[0], in: 0, duration: 60 };
    p.tracks.video[0] = longClip;

    const full = render(
      <ClipBlock
        p={p}
        clip={longClip}
        leftPx={0}
        pps={40}
        selected={false}
        animate={false}
        floating={false}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
      />,
    );
    const fullCount = full.container.querySelectorAll('[data-testid="filmstrip-tile"]').length;
    // frameW = (70-4)*1080/1920 = 37.125 → totalSlots = ceil(2400/37.125) = 65
    expect(fullCount).toBe(65);

    const windowed = render(
      <ClipBlock
        p={p}
        clip={longClip}
        leftPx={0}
        pps={40}
        selected={false}
        animate={false}
        floating={false}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
        visibleRange={{ start: 0, end: 100 }}
      />,
    );
    const windowedTiles = windowed.container.querySelectorAll<HTMLElement>(
      '[data-testid="filmstrip-tile"]',
    );
    // review round 1 Important 4：只斷言「比全部少」放不住視窗算錯幾百 px 的
    // 回歸——這裡照 filmstripTilesFor 的算式手算精確值：visibleRange=[0,100]，
    // firstSlot=floor(0/37.125)=0、lastSlot=floor(100/37.125)=2 → 恰好 3 格，
    // x=[0, 37.125, 74.25]。
    expect(windowedTiles).toHaveLength(3);
    const xs = Array.from(windowedTiles)
      .map((el) => parseFloat(el.style.left))
      .sort((a, b) => a - b);
    expect(xs).toEqual([0, 37.125, 74.25]);
  });

  it('clip 完全落在 visibleRange 之外 → 不渲染任何 tile', () => {
    const p = demoProject();
    const clip = p.tracks.video[0]; // leftPx 0, duration 6, pps 40 → 佔 [0,240)px

    const { container } = render(
      <ClipBlock
        p={p}
        clip={clip}
        leftPx={0}
        pps={40}
        selected={false}
        animate={false}
        floating={false}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
        visibleRange={{ start: 10000, end: 20000 }}
      />,
    );

    expect(container.querySelectorAll('[data-testid="filmstrip-tile"]')).toHaveLength(0);
  });

  it('visibleRange 平移（模擬 scroll）後，渲染的 tile x 範圍跟著移動', () => {
    const p = demoProject();
    const longClip = { ...p.tracks.video[0], in: 0, duration: 60 };
    p.tracks.video[0] = longClip;

    const left = render(
      <ClipBlock
        p={p}
        clip={longClip}
        leftPx={0}
        pps={40}
        selected={false}
        animate={false}
        floating={false}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
        visibleRange={{ start: 0, end: 200 }}
      />,
    );
    const leftXs = Array.from(
      left.container.querySelectorAll<HTMLElement>('[data-testid="filmstrip-tile"]'),
    ).map((el) => el.style.left);

    const right = render(
      <ClipBlock
        p={p}
        clip={longClip}
        leftPx={0}
        pps={40}
        selected={false}
        animate={false}
        floating={false}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
        visibleRange={{ start: 1000, end: 1200 }}
      />,
    );
    const rightXs = Array.from(
      right.container.querySelectorAll<HTMLElement>('[data-testid="filmstrip-tile"]'),
    ).map((el) => el.style.left);

    expect(rightXs).not.toEqual(leftXs);
    // 窗移到後段之後最小 x 應該明顯變大
    const minLeft = Math.min(...leftXs.map((s) => parseFloat(s)));
    const minRight = Math.min(...rightXs.map((s) => parseFloat(s)));
    expect(minRight).toBeGreaterThan(minLeft);
  });
});
