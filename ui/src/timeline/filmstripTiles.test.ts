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
  it('視窗外的格不生成，且邊界 slot 精確（floor 語意，非 ceil）', () => {
    // clip: in=0, duration=100s, pps=10, frameW=10 → clipWidthPx=1000px, 100 slots
    // clipLeftPx=0, visibleRange=[200,300] → firstSlot=floor(200/10)=20,
    // lastSlot=floor(300/10)=30（300 恰好是 slot 30 的左緣，floor/ceil 在這個
    // 邊界值上剛好一致，故這條斷言本身不能證偽 ceil；下一條非邊界值的測試才能）。
    const tiles = filmstripTilesFor(0, 100, 10, 10, 1, 100, 0, { start: 200, end: 300 });
    expect(tiles.map((t) => t.x)).toEqual(
      Array.from({ length: 30 - 20 + 1 }, (_, i) => (20 + i) * 10),
    );
    expect(tiles).toHaveLength(11); // slot 20..30 含頭尾
  });

  it('relEnd 落在 slot 中段（非邊界）→ 不多算超出視窗的下一格（Important 3 迴歸）', () => {
    // frameW=10, relEnd=305（slot 30 覆蓋 [300,310) 含 305；slot 31 覆蓋 [310,320)
    // 完全在 305 之後，不該出現）。floor(305/10)=30 正確；ceil(305/10)=31 是舊 bug
    // 會多渲染一格。
    const tiles = filmstripTilesFor(0, 100, 10, 10, 1, 100, 0, { start: 0, end: 305 });
    const lastX = Math.max(...tiles.map((t) => t.x));
    expect(lastX).toBe(300); // slot 30 的 x；不是 310（slot 31，ceil 的產物）
    expect(tiles.some((t) => t.x === 310)).toBe(false);
  });

  it('clip 完全在視窗外 → 回傳空陣列', () => {
    // clip 佔 [0,100)px（相對內容座標，clipLeftPx=500 → 絕對 [500,600)）
    const tiles = filmstripTilesFor(0, 10, 10, 10, 1, 10, 500, { start: 0, end: 100 });
    expect(tiles).toEqual([]);
  });

  it('clipLeftPx 平移後，windowing 仍正確對齊絕對座標（精確 slot 範圍）', () => {
    // clip 起點在內容座標 1000px 處。visibleRange=[1000,1020] → 相對 clip 座標
    // relStart=0, relEnd=20 → firstSlot=floor(0/10)=0, lastSlot=floor(20/10)=2
    // （20 恰好是 slot 2 的左緣，floor/ceil 在此邊界一致——slot 0,1,2 三格皆合法）。
    const tiles = filmstripTilesFor(0, 100, 10, 10, 1, 100, 1000, {
      start: 1000,
      end: 1020,
    });
    expect(tiles.map((t) => t.x)).toEqual([0, 10, 20]);
  });

  it('未提供 visibleRange 時渲染全部格（呼叫端可選擇不裁窗）', () => {
    const tiles = filmstripTilesFor(0, 20, 2, 10, 1, 20, 0);
    expect(tiles).toHaveLength(4);
  });
});

describe('quantizeVisibleRange（scroll 節流用的量化數學——純函數本身只保證數值穩定，不保證物件參考）', () => {
  it('把範圍向外擴到最近的 step 網格', () => {
    expect(quantizeVisibleRange({ start: 300, end: 700 }, 256)).toEqual({ start: 256, end: 768 });
  });

  it('已經對齊網格的範圍維持不變', () => {
    expect(quantizeVisibleRange({ start: 256, end: 512 }, 256)).toEqual({
      start: 256,
      end: 512,
    });
  });

  it('小幅捲動（同一 step 內）量化後數值相等', () => {
    const a = quantizeVisibleRange({ start: 300, end: 700 }, 256);
    const b = quantizeVisibleRange({ start: 310, end: 705 }, 256);
    expect(a).toEqual(b); // 值相等（toEqual），不是同一個物件
  });

  it('⚠️ 即使數值相等，quantizeVisibleRange 本身每次呼叫仍回傳新物件（review round 1 Critical 2）', () => {
    // 這條測試存在的理由：上一條「小幅捲動」測試用 toEqual（值相等）看起來像在
    // 保證「不會觸發下游 re-render」，但 React 的 setState bail-out 比的是
    // Object.is（參考相等），toEqual 綠燈跟「擋掉 re-render」完全是兩件事——
    // 光看這個檔案的測試，量化函數本身從未、也不該去擋參考相等；真正的
    // bail-out 必須發生在呼叫端的 setState 那一層（見 Timeline.tsx 的
    // `setVisibleRange((prev) => ... ? prev : next)`），quantizeVisibleRange
    // 只負責把數值收斂到同一個網格，讓那一層有機會判斷「數值沒變」。
    // 「memo 化元件不會逐幀重渲染」這個屬性由 Timeline 層級的
    // render-count spy 測試守著（見 Timeline.filmstripWindow.test.tsx）。
    const a = quantizeVisibleRange({ start: 300, end: 700 }, 256);
    const b = quantizeVisibleRange({ start: 310, end: 705 }, 256);
    expect(a).not.toBe(b);
  });
});
