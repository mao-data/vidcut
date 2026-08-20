import { describe, it, expect } from 'vitest';
import { filmstripTilesFor, secPerTileFor, quantizeVisibleRange } from './filmstripTiles.js';

describe('secPerTileFor（Plan 9 範圍裁決 #7：舊資產相容）', () => {
  it('filmstripTiles 缺席 → 回退每秒一格', () => {
    expect(secPerTileFor(30, undefined)).toBe(1);
  });

  it('filmstripTiles=0 也視為缺席（防呆）', () => {
    expect(secPerTileFor(30, 0)).toBe(1);
  });

  it('filmstripTiles 有值 → duration/tiles', () => {
    expect(secPerTileFor(300, 100)).toBe(3);
  });
});

describe('filmstripTilesFor：zoom-out 取樣（每 N 格取一張）', () => {
  it('pps 低時，多個相鄰格的中心時間落在同一個 sprite tileIndex 內', () => {
    // clip: in=0, duration=20s。secPerTile=1（每秒一格 sprite，20 張）。
    // pps=2 → clipWidthPx=40px，frameW=10 → 4 個 slot，每格代表 5 秒。
    const tiles = filmstripTilesFor(0, 20, 2, 10, 1, 20, 0);
    expect(tiles).toHaveLength(4);
    // slot i 中心時間 = (i+0.5)*(10/2) = (i+0.5)*5
    expect(tiles.map((t) => t.tileIndex)).toEqual([
      Math.round(2.5 / 1),
      Math.round(7.5 / 1),
      Math.round(12.5 / 1),
      Math.round(17.5 / 1),
    ]);
    expect(tiles.map((t) => t.tileIndex)).toEqual([3, 8, 13, 18]);
  });

  it('每格 x 依序遞增 frameW', () => {
    const tiles = filmstripTilesFor(0, 20, 2, 10, 1, 20, 0);
    expect(tiles.map((t) => t.x)).toEqual([0, 10, 20, 30]);
  });
});

describe('filmstripTilesFor：zoom-in 重複（同格連續出現）', () => {
  it('pps 高時，多個相鄰格取到同一個 tileIndex', () => {
    // clip: in=0, duration=3s，secPerTile=1（3 張 sprite tile）。
    // pps=60、frameW=10 → clipWidthPx=180px → 18 slot，每格代表 10/60 = 1/6 秒。
    const tiles = filmstripTilesFor(0, 3, 60, 10, 1, 3, 0);
    expect(tiles).toHaveLength(18);
    // 前 6 格中心時間都落在 [0,1) → tileIndex 0（round 到 0 或 1，視中心時間而定）
    // 明確驗證「同一 tileIndex 連續出現多次」而非每格皆不同。
    const idxs = tiles.map((t) => t.tileIndex);
    const uniqueRuns = idxs.filter((v, i) => i === 0 || v !== idxs[i - 1]);
    expect(uniqueRuns.length).toBeLessThan(idxs.length); // 有重複 run，不是每格都換
  });
});

describe('filmstripTilesFor：w < frameW 單格', () => {
  it('clip 寬度小於一格時只回傳一格，裁右緣', () => {
    // clip duration=0.5s, pps=10 → clipWidthPx=5px < frameW=45
    const tiles = filmstripTilesFor(2, 0.5, 10, 45, 1, 30, 0);
    expect(tiles).toHaveLength(1);
    expect(tiles[0].x).toBe(0);
    expect(tiles[0].w).toBe(45);
  });

  it('單格的 tileIndex 用 clip 中點時間換算（永遠有可辨識縮圖）', () => {
    // in=10, duration=0.5 → 中點時間=10.25s, secPerTile=1 → round(10.25)=10
    const tiles = filmstripTilesFor(10, 0.5, 10, 45, 1, 30, 0);
    expect(tiles[0].tileIndex).toBe(10);
  });
});

describe('filmstripTilesFor：sprite 邊緣 clamp', () => {
  it('tileIndex 不小於 0（clip.in 為負值等異常輸入的防呆）', () => {
    const tiles = filmstripTilesFor(-5, 2, 10, 10, 1, 10, 0);
    expect(tiles.every((t) => t.tileIndex >= 0)).toBe(true);
  });

  it('tileIndex 不超過 tiles-1（clip 尾端超出 sprite 實際格數時 clamp 在最後一張）', () => {
    // in=0, duration=10, secPerTile=1, tiles=3（sprite 只有 3 張，但 clip 覆蓋 10 秒）
    const tiles = filmstripTilesFor(0, 10, 5, 10, 1, 3, 0);
    expect(tiles.every((t) => t.tileIndex <= 2)).toBe(true);
    // 且最後幾格應該 clamp 在 2（不會超界）
    expect(tiles[tiles.length - 1].tileIndex).toBe(2);
  });
});

describe('filmstripTilesFor：windowing（可視範圍相交）', () => {
  it('視窗外的格不生成', () => {
    // clip: in=0, duration=100s, pps=10, frameW=10 → clipWidthPx=1000px, 100 slots
    // clipLeftPx=0, visibleRange=[200,300] → 只應該回傳與 [200,300] 相交的 slot
    const tiles = filmstripTilesFor(0, 100, 10, 10, 1, 100, 0, { start: 200, end: 300 });
    // slot i 覆蓋 [i*10, i*10+10)；與 [200,300] 相交的是 slot 20..30
    expect(tiles.every((t) => t.x >= 190 && t.x <= 300)).toBe(true);
    expect(tiles.length).toBeLessThan(100); // 遠少於全部 100 格
    expect(tiles.length).toBeGreaterThan(0);
  });

  it('clip 完全在視窗外 → 回傳空陣列', () => {
    // clip 佔 [0,100)px（相對內容座標，clipLeftPx=500 → 絕對 [500,600)）
    const tiles = filmstripTilesFor(0, 10, 10, 10, 1, 10, 500, { start: 0, end: 100 });
    expect(tiles).toEqual([]);
  });

  it('clipLeftPx 平移後，windowing 仍正確對齊絕對座標', () => {
    // clip 起點在內容座標 1000px 處，clip 內部 slot 0 的絕對位置是 [1000,1010)
    const tiles = filmstripTilesFor(0, 100, 10, 10, 1, 100, 1000, {
      start: 1000,
      end: 1020,
    });
    // 應該只取到 clip 內 slot 0、slot 1（也可能含 slot 2 因為 ceil），x 是「相對 clip」座標
    expect(tiles.every((t) => t.x <= 20)).toBe(true);
    expect(tiles.some((t) => t.x === 0)).toBe(true);
  });

  it('未提供 visibleRange 時渲染全部格（呼叫端可選擇不裁窗）', () => {
    const tiles = filmstripTilesFor(0, 20, 2, 10, 1, 20, 0);
    expect(tiles).toHaveLength(4);
  });
});

describe('quantizeVisibleRange（scroll 節流用：避免逐幀 thrash memoized ClipBlock）', () => {
  it('把範圍向外擴到最近的 step 網格', () => {
    expect(quantizeVisibleRange({ start: 300, end: 700 }, 256)).toEqual({ start: 256, end: 768 });
  });

  it('已經對齊網格的範圍維持不變', () => {
    expect(quantizeVisibleRange({ start: 256, end: 512 }, 256)).toEqual({
      start: 256,
      end: 512,
    });
  });

  it('小幅捲動（同一 step 內）量化後範圍不變 → 不會觸發下游 re-render', () => {
    const a = quantizeVisibleRange({ start: 300, end: 700 }, 256);
    const b = quantizeVisibleRange({ start: 310, end: 705 }, 256);
    expect(a).toEqual(b);
  });
});
