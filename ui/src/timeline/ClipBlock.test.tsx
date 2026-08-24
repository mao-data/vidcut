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

/**
 * Plan 11 Task 1（裁決 3）：選取項把手常駐 + 命中區放大 + 窄片外溢。
 * `.handle` 是 ClipBlock／AudioChip／Timeline 字幕軌／overlay 軌四端共用的規則
 * （theme.css），選取態靠 chip 的 `selected` class 觸發（不是 inline style），
 * 這裡只驗證 ClipBlock 有沒有把 `selected` prop 正確轉成那個 class、以及窄片時
 * 有沒有算出外溢座標。
 */
describe('ClipBlock 把手：選取常駐 + 窄片外溢（Plan 11 Task 1）', () => {
  it('未選取：chip 沒有 selected class（維持現行 hover-only 行為）', () => {
    const p = demoProject();
    const { container } = render(
      <ClipBlock
        p={p}
        clip={p.tracks.video[0]}
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
    const chip = container.querySelector('.clipblk')!;
    expect(chip.className.split(' ')).not.toContain('selected');
  });

  it('選取：chip 帶 selected class（.handle 常駐可見/命中區放大靠這個 class 觸發）', () => {
    const p = demoProject();
    const { container } = render(
      <ClipBlock
        p={p}
        clip={p.tracks.video[0]}
        leftPx={0}
        pps={40}
        selected={true}
        animate={false}
        floating={false}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
      />,
    );
    const chip = container.querySelector('.clipblk')!;
    expect(chip.className.split(' ')).toContain('selected');
  });

  it('選取且寬片（>=28px）：12px 命中區跨在邊界正中央（6px 內+6px 外），不是貼齊邊界內縮（review round 1 Important 1）', () => {
    const p = demoProject();
    const { container } = render(
      <ClipBlock
        p={p}
        clip={{ ...p.tracks.video[0], duration: 2 }} // 2s*40pps=80px，遠大於 28px
        leftPx={0}
        pps={40}
        selected={true}
        animate={false}
        floating={false}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
      />,
    );
    const [left, right] = Array.from(container.querySelectorAll<HTMLElement>('.handle'));
    // -6px：12px 寬的把手中心對齊邊界，一半（6px）留在 chip 內、一半溢出 chip 外——
    // 若仍是「從 left:0 往內長 12px」（review 前的舊算式），這裡會是 0px，
    // 28px 窄片的可移動帶就只剩 ~4px（Important 1 抓到的問題）。
    expect(left!.style.left).toBe('-6px');
    expect(right!.style.right).toBe('-6px');
  });

  it('選取且寬片：移動帶（chip 內側未被把手蓋住的區間）維持 [6, w-6]，跟未選取時同尺寸', () => {
    const p = demoProject();
    const w = 80; // 2s*40pps
    const { container } = render(
      <ClipBlock
        p={p}
        clip={{ ...p.tracks.video[0], duration: 2 }}
        leftPx={0}
        pps={40}
        selected={true}
        animate={false}
        floating={false}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
      />,
    );
    const [left, right] = Array.from(container.querySelectorAll<HTMLElement>('.handle'));
    // 把手內緣＝chip-relative 座標：left 把手內緣＝leftOffset+12(寬)＝-6+12=6；
    // right 把手內緣＝w-(rightOffset+12)＝80-(-6+12)=74＝w-6。
    const leftInnerEdge = parseFloat(left!.style.left) + 12;
    const rightInnerEdge = w - (parseFloat(right!.style.right) + 12);
    expect(leftInnerEdge).toBe(6);
    expect(rightInnerEdge).toBe(w - 6);
  });

  it('選取且窄片（<28px）：兩把手向外溢出，互不重疊', () => {
    const p = demoProject();
    // duration 0.5s * pps 40 = 20px < 28px
    const { container } = render(
      <ClipBlock
        p={p}
        clip={{ ...p.tracks.video[0], duration: 0.5 }}
        leftPx={0}
        pps={40}
        selected={true}
        animate={false}
        floating={false}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
      />,
    );
    const [left, right] = Array.from(container.querySelectorAll<HTMLElement>('.handle'));
    // 外溢＝負偏移（不再是貼齊的 0px）
    const leftPx = parseFloat(left!.style.left);
    const rightPx = parseFloat(right!.style.right);
    expect(leftPx).toBeLessThan(0);
    expect(rightPx).toBeLessThan(0);
  });

  it('未選取窄片：即使寬度 <28px 也不外溢（外溢只在選取時發生）', () => {
    const p = demoProject();
    const { container } = render(
      <ClipBlock
        p={p}
        clip={{ ...p.tracks.video[0], duration: 0.5 }}
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
    const [left, right] = Array.from(container.querySelectorAll<HTMLElement>('.handle'));
    expect(left!.style.left).toBe('0px');
    expect(right!.style.right).toBe('0px');
  });

  it('final-review Minor 4 回歸釘：內容窄但佔位撐大總寬——窄片外推吃內容寬，不吃含佔位的總寬', () => {
    const p = demoProject();
    // 內容 duration 0.5s*40pps=20px（<28px 門檻，本身該外推），但頭端佔位 1s*40pps=40px
    // 把總寬 w 撐到 60px（>28px 門檻）。修法前：外推判斷吃含佔位的 w=60px，判定「不窄」，
    // overflowOffset 只有 -6（SELECTED_HANDLE_W/2），把手命中區比預期窄。
    // 修法後：判斷吃 contentW = w - placeholderHeadPx - placeholderTailPx = 20px，
    // 仍 <28px，照樣觸發外推。
    const { container } = render(
      <ClipBlock
        p={p}
        clip={{ ...p.tracks.video[0], duration: 0.5 }}
        leftPx={0}
        pps={40}
        selected={true}
        animate={false}
        floating={false}
        placeholderHead={1}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
      />,
    );
    const [left, right] = Array.from(container.querySelectorAll<HTMLElement>('.handle'));
    // left handle 的 style.left = overflowOffset + placeholderHeadPx（40px，這裡的
    // placeholderHead=1s*40pps）——外推觸發與否要看 overflowOffset 本身，不能直接拿
    // leftPx 跟純 -6 比（那會被 +40 的頭端佔位偏移蓋過）。right handle 沒有頭端佔位，
    // style.right 就是 overflowOffset 本身，直接比對即可。
    const leftPx = parseFloat(left!.style.left);
    const rightPx = parseFloat(right!.style.right);
    const overflowOffsetFromLeft = leftPx - 40; // 扣掉 placeholderHeadPx
    // 外推觸發：偏移比純 -6（SELECTED_HANDLE_W/2）更負（外溢量 > 0）。
    expect(overflowOffsetFromLeft).toBeLessThan(-6);
    expect(rightPx).toBeLessThan(-6);
  });

  /**
   * review round 1 Critical 1：主軌片段是頭尾相接的（無間隙），窄片選取後外溢的
   * out 把手會伸進「下一個 DOM 序在後的 sibling」的地盤。沒有 z-index 抬升時，
   * 那個後到的 sibling（實色底、不透明）會蓋在外溢把手上面，偷走 pointer 事件——
   * 使用者點得到的其實是下一個片段的移動熱區，抓不到被蓋住的 out 把手。
   *
   * 這個 UI 是單選模型（selectedId，見 stores/selection.ts），所以修法是把「選取的
   * 那一個」抬升到相鄰 chip 之上即可，不必處理多選同時抬升的情境。
   *
   * jsdom 沒有真的 layout/paint，`elementsFromPoint` 也未實作，量不到「滑鼠點下去
   * 命中的是哪個元素」；能斷言、且直接對應到「為什麼會蓋住」這個因果的是：兩個
   * chip 在同一個 DOM 父層（同一個 stacking context）裡，選取的那個 computed
   * z-index 嚴格大於未選取那個——足以讓瀏覽器的疊層演算法把它排到後面那個 sibling
   * 之上，不受 DOM 順序影響。
   */
  it('相鄰窄片：選取的那個 z-index 抬升到未選取 sibling 之上（Critical 1）', () => {
    const p = demoProject();
    // 兩段窄 clip（各 20px < 28px 門檻），並排渲染在同一個容器（同一個 stacking
    // context），模擬主軌頭尾相接、後一個 sibling 會在 DOM 順序上蓋在前一個之上。
    const clipA = { ...p.tracks.video[0], id: 'nA', duration: 0.5 };
    const clipB = { ...p.tracks.video[0], id: 'nB', duration: 0.5 };
    const { container } = render(
      <div>
        <ClipBlock
          p={p}
          clip={clipA}
          leftPx={0}
          pps={40}
          selected={true}
          animate={false}
          floating={false}
          onTrimStart={noop}
          onMoveStart={noop}
          onSelect={noop}
        />
        <ClipBlock
          p={p}
          clip={clipB}
          leftPx={20}
          pps={40}
          selected={false}
          animate={false}
          floating={false}
          onTrimStart={noop}
          onMoveStart={noop}
          onSelect={noop}
        />
      </div>,
    );
    const chips = Array.from(container.querySelectorAll<HTMLElement>('.clipblk'));
    expect(chips).toHaveLength(2);
    const [selectedChip, unselectedChip] = chips;
    const selectedZ = Number(selectedChip!.style.zIndex);
    const unselectedZ =
      unselectedChip!.style.zIndex === '' ? 0 : Number(unselectedChip!.style.zIndex);
    expect(selectedChip!.className).toContain('selected');
    expect(selectedZ).toBeGreaterThan(unselectedZ);
    // 低於 floating（拖曳中）的 20——正在拖的那個永遠最上面，不被選取態蓋過。
    expect(selectedZ).toBeLessThan(20);
  });
});

/**
 * Plan 11 Task 3（裁決 5）：主軌 out 把手拖到來源長度上限（`probe.duration`）時，
 * 「拉不動」從沉默變可見——把手變 danger 態。判定本身（`isAtSourceMax`）已由
 * `dragMath.test.ts` 覆蓋，這裡只驗證 ClipBlock 有沒有把 `outAtMax` prop 正確
 * 轉成 DOM：只有 out 把手變 danger，in 把手不受影響（來源上限只約束右緣）。
 */
describe('ClipBlock 把手：來源上限 danger 態（Plan 11 Task 3 裁決 5）', () => {
  it('outAtMax=false（預設）：兩把手都沒有 danger class', () => {
    const p = demoProject();
    const { container } = render(
      <ClipBlock
        p={p}
        clip={p.tracks.video[0]}
        leftPx={0}
        pps={40}
        selected={true}
        animate={false}
        floating={false}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
      />,
    );
    const [left, right] = Array.from(container.querySelectorAll<HTMLElement>('.handle'));
    expect(left!.className).not.toContain('danger');
    expect(right!.className).not.toContain('danger');
  });

  it('outAtMax=true：只有 out 把手帶 danger class，in 把手不受影響', () => {
    const p = demoProject();
    const { container } = render(
      <ClipBlock
        p={p}
        clip={p.tracks.video[0]}
        leftPx={0}
        pps={40}
        selected={true}
        animate={false}
        floating={false}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
        outAtMax={true}
      />,
    );
    const [left, right] = Array.from(container.querySelectorAll<HTMLElement>('.handle'));
    expect(left!.className).not.toContain('danger');
    expect(right!.className).toContain('danger');
  });
});

/**
 * Plan 14 Task 4：黑墊（leadPad）視覺——取代舊的 `inAtMin` prop／danger 態
 * （Plan 12 Task 3 裁決 4 的「danger+min 硬停」語意已廢止）。`clip.leadPad`
 * 直接從傳入的 clip 讀（不是獨立 prop，見 ClipBlock.tsx 該欄位的定義處註解），
 * 把手改用 `accent` class，不是 `danger`（黑墊不是錯誤狀態）。
 */
describe('ClipBlock 黑墊視覺（Plan 14 Task 4）', () => {
  it('無 leadPad（省略欄位）：不畫黑帶，in 把手沒有 accent class——渲染輸出與改動前逐位元組相同', () => {
    const p = demoProject();
    const { container } = render(
      <ClipBlock
        p={p}
        clip={p.tracks.video[0]}
        leftPx={0}
        pps={40}
        selected={true}
        animate={false}
        floating={false}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
      />,
    );
    const [left, right] = Array.from(container.querySelectorAll<HTMLElement>('.handle'));
    expect(left!.className).not.toContain('accent');
    expect(left!.className).not.toContain('danger');
    expect(right!.className).not.toContain('danger');
    expect(container.querySelector('[data-testid="clip-leadpad"]')).toBeNull();
  });

  it('leadPad=0（顯式 0）：同無 leadPad，不畫黑帶', () => {
    const p = demoProject();
    const { container } = render(
      <ClipBlock
        p={p}
        clip={{ ...p.tracks.video[0], leadPad: 0 }}
        leftPx={0}
        pps={40}
        selected={true}
        animate={false}
        floating={false}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
      />,
    );
    expect(container.querySelector('[data-testid="clip-leadpad"]')).toBeNull();
  });

  it('leadPad>0：畫黑帶，寬度＝leadPad×pps；in 把手帶 accent class（不是 danger）', () => {
    const p = demoProject();
    const clip = { ...p.tracks.video[0], leadPad: 1.5 }; // 1.5s @ 40pps = 60px
    const { container } = render(
      <ClipBlock
        p={p}
        clip={clip}
        leftPx={0}
        pps={40}
        selected={true}
        animate={false}
        floating={false}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
      />,
    );
    const band = container.querySelector<HTMLElement>('[data-testid="clip-leadpad"]');
    expect(band).not.toBeNull();
    expect(band!.style.width).toBe('60px');
    expect(band!.style.left).toBe('0px');
    const [left, right] = Array.from(container.querySelectorAll<HTMLElement>('.handle'));
    expect(left!.className).toContain('accent');
    expect(left!.className).not.toContain('danger');
    expect(right!.className).not.toContain('accent');
  });

  it('leadPad>0 時 filmstrip 內容區右移同寬（裁切框左緣 = padPx，tile 相對框內 >= 0）', () => {
    const p = demoProject();
    const clip = { ...p.tracks.video[0], leadPad: 1.5 }; // 60px
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
    // 右移量現在由「內容區裁切框」承載（tile 的 left 改為相對框內座標）——
    // 語意不變：filmstrip 畫面整體從 padPx 起畫。
    const clipBox = container.querySelector<HTMLElement>('[data-testid="filmstrip-content-clip"]')!;
    expect(clipBox).not.toBeNull();
    expect(clipBox.style.left).toBe('60px');
    const tiles = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="filmstrip-tile"]'),
    );
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) {
      expect(Number.parseFloat(t.style.left)).toBeGreaterThanOrEqual(0);
    }
  });

  it('outAtMax 與 leadPad>0 同時成立：out 把手仍是 danger，in 把手仍是 accent（互不干擾）', () => {
    const p = demoProject();
    const clip = { ...p.tracks.video[0], leadPad: 1.5 };
    const { container } = render(
      <ClipBlock
        p={p}
        clip={clip}
        leftPx={0}
        pps={40}
        selected={true}
        animate={false}
        floating={false}
        onTrimStart={noop}
        onMoveStart={noop}
        onSelect={noop}
        outAtMax={true}
      />,
    );
    const [left, right] = Array.from(container.querySelectorAll<HTMLElement>('.handle'));
    expect(left!.className).toContain('accent');
    expect(left!.className).not.toContain('danger');
    expect(right!.className).toContain('danger');
    expect(right!.className).not.toContain('accent');
  });
});

/**
 * Plan 15 Task 1：trim 拖曳佔位黑墊——統一拖曳模型的視覺積木。`placeholderHead`／
 * `placeholderTail` 是 Timeline.tsx（Task 2，本任務不接線）拖曳期才會傳非零值的
 * 純視覺 prop；這裡只驗證 ClipBlock 有沒有把它們正確轉成 DOM：缺席時渲染輸出
 * 逐位元組不變（回歸釘），有值時佔位區寬度/位置正確、與 leadPad 黑帶共存時排列
 * 順序正確（頭端 `[佔位][leadPad][內容]`）、filmstrip 對位吃進佔位寬度。
 */
describe('ClipBlock trim 佔位黑墊（Plan 15 Task 1）', () => {
  it('缺席（不傳 props）：不畫任何佔位區，chip 寬度＝原本 duration 換算的寬（逐位元組不變回歸釘）', () => {
    const p = demoProject();
    const clip = p.tracks.video[0]; // duration=6, pps=40 → w=240
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
    const chip = container.querySelector<HTMLElement>('.clipblk')!;
    expect(chip.style.width).toBe('240px');
    expect(container.querySelector('[data-testid="clip-placeholder-head"]')).toBeNull();
    expect(container.querySelector('[data-testid="clip-placeholder-tail"]')).toBeNull();
  });

  it('placeholderHead=0／placeholderTail=0（顯式 0）：同缺席，不畫佔位區', () => {
    const p = demoProject();
    const clip = p.tracks.video[0];
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
        placeholderHead={0}
        placeholderTail={0}
      />,
    );
    expect(container.querySelector('[data-testid="clip-placeholder-head"]')).toBeNull();
    expect(container.querySelector('[data-testid="clip-placeholder-tail"]')).toBeNull();
  });

  it('placeholderHead>0：頭端畫佔位區，寬度＝placeholderHead×pps，chip 總寬多算進去', () => {
    const p = demoProject();
    const clip = p.tracks.video[0]; // duration=6
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
        placeholderHead={2} // 2s*40pps=80px
      />,
    );
    const chip = container.querySelector<HTMLElement>('.clipblk')!;
    // 240（內容）+ 80（頭端佔位）= 320
    expect(chip.style.width).toBe('320px');
    const head = container.querySelector<HTMLElement>('[data-testid="clip-placeholder-head"]')!;
    expect(head).not.toBeNull();
    expect(head.style.width).toBe('80px');
    expect(head.style.left).toBe('0px');
    expect(container.querySelector('[data-testid="clip-placeholder-tail"]')).toBeNull();
  });

  it('placeholderTail>0：尾端畫佔位區，寬度＝placeholderTail×pps，貼右緣（right:0）', () => {
    const p = demoProject();
    const clip = p.tracks.video[0]; // duration=6
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
        placeholderTail={1.5} // 1.5s*40pps=60px
      />,
    );
    const chip = container.querySelector<HTMLElement>('.clipblk')!;
    // 240 + 60 = 300
    expect(chip.style.width).toBe('300px');
    const tail = container.querySelector<HTMLElement>('[data-testid="clip-placeholder-tail"]')!;
    expect(tail).not.toBeNull();
    expect(tail.style.width).toBe('60px');
    expect(tail.style.right).toBe('0px');
    expect(container.querySelector('[data-testid="clip-placeholder-head"]')).toBeNull();
  });

  it('頭端佔位與真 leadPad 同時存在：排列 [佔位][leadPad][內容]，兩條黑帶各自定位不重疊', () => {
    const p = demoProject();
    const clip = { ...p.tracks.video[0], leadPad: 1 }; // 1s*40pps=40px
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
        placeholderHead={0.5} // 0.5s*40pps=20px
      />,
    );
    const head = container.querySelector<HTMLElement>('[data-testid="clip-placeholder-head"]')!;
    const pad = container.querySelector<HTMLElement>('[data-testid="clip-leadpad"]')!;
    expect(head.style.left).toBe('0px');
    expect(head.style.width).toBe('20px');
    // leadPad 左緣緊接佔位右緣（20px），不是貼齊 chip 左緣（0px）
    expect(pad.style.left).toBe('20px');
    expect(pad.style.width).toBe('40px');
  });

  it('頭端佔位與 leadPad 同時存在時，filmstrip 內容區左緣＝佔位寬＋leadPad 寬', () => {
    const p = demoProject();
    const clip = { ...p.tracks.video[0], leadPad: 1 }; // 40px
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
        placeholderHead={0.5} // 20px
      />,
    );
    // 左緣位置由「內容區裁切框」承載：20（佔位）+ 40（leadPad）= 60。
    const clipBox = container.querySelector<HTMLElement>('[data-testid="filmstrip-content-clip"]')!;
    expect(clipBox).not.toBeNull();
    expect(clipBox.style.left).toBe('60px');
    const tiles = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="filmstrip-tile"]'),
    );
    expect(tiles.length).toBeGreaterThan(0);
  });

  it('placeholderTail>0：filmstrip 裁切框寬＝內容寬（最後一格不會穿過切點透進佔位墊）', () => {
    const p = demoProject();
    const clip = p.tracks.video[0]; // duration=6 → 內容 240px
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
        placeholderTail={1.5} // 60px → chip 總寬 300px
      />,
    );
    // bug 釘（trim-out 拖曳中畫面比手多出最多 frameW÷pps 秒）：修法是把裁切邊界
    // 從 chip 層（含佔位、300px）釘回內容右緣——裁切框寬必須是內容寬 240px 且
    // overflow:hidden，最後一格（固定寬 frameW、可能超出內容右緣）才會被精準裁掉。
    const clipBox = container.querySelector<HTMLElement>('[data-testid="filmstrip-content-clip"]')!;
    expect(clipBox).not.toBeNull();
    expect(clipBox.style.width).toBe('240px');
    expect(clipBox.style.overflow).toBe('hidden');
  });

  it('頭尾佔位同時存在：各自獨立畫出，chip 寬度把兩者都算進去', () => {
    const p = demoProject();
    const clip = p.tracks.video[0]; // duration=6 → 240px
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
        placeholderHead={1} // 40px
        placeholderTail={0.5} // 20px
      />,
    );
    const chip = container.querySelector<HTMLElement>('.clipblk')!;
    // 240 + 40 + 20 = 300
    expect(chip.style.width).toBe('300px');
    expect(
      container.querySelector<HTMLElement>('[data-testid="clip-placeholder-head"]')!.style.width,
    ).toBe('40px');
    expect(
      container.querySelector<HTMLElement>('[data-testid="clip-placeholder-tail"]')!.style.width,
    ).toBe('20px');
  });
});
