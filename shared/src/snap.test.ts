import { describe, it, expect } from 'vitest';
import { snapBBox } from './snap.js';

const CANVAS = { w: 1080, h: 1920 };

describe('snapBBox', () => {
  it('x/y 兩軸各自獨立判定,同一次呼叫可以同時吸附', () => {
    // 水平:bbox 寬 200,中心在 550(離 540 差 10 < 16)→ 吸 x
    // 垂直:y=100 離上緣安全邊距 96 只差 4(< 16,且遠比中心 960、下緣 1824 近)→ 也吸 y
    // 用完整陣列(而非 toContainEqual)斷言,確保 x 導線沒有意外把 y 導線擠掉、反之亦然
    const r = snapBBox({ x: 450, y: 100, w: 200, h: 80 }, CANVAS);
    expect(r.x).toBe(440); // 中心對齊 540
    expect(r.y).toBe(96); // 上緣對齊安全邊距
    expect(r.guides).toEqual([
      { axis: 'x', pos: 540 },
      { axis: 'y', pos: 96 },
    ]);
  });
  it('超出閾值不動、無導線', () => {
    // x 中心 400,離水平中心 540 差 140(> 閾值);y=500,bbox 中心 540、離三個
    // 垂直候選(中心 960、上緣 96、下緣 1824)都遠超閾值——雙軸都不該吸附
    const r = snapBBox({ x: 300, y: 500, w: 200, h: 80 }, CANVAS);
    expect(r.x).toBe(300);
    expect(r.guides).toHaveLength(0);
  });
  it('上緣接近安全邊距(96)→ 吸 y', () => {
    const r = snapBBox({ x: 0, y: 90, w: 100, h: 100 }, CANVAS);
    expect(r.y).toBe(96);
    expect(r.guides).toContainEqual({ axis: 'y', pos: 96 });
  });
  it('下緣接近 95% 線(1824)→ 吸 y(以下緣對齊)', () => {
    const r = snapBBox({ x: 0, y: 1730, w: 100, h: 100 }, CANVAS);
    expect(r.y).toBe(1724);
  });
  it('垂直中心吸附', () => {
    const r = snapBBox({ x: 0, y: 915, w: 100, h: 100 }, CANVAS); // 中心 965,離 960 差 5
    expect(r.y).toBe(910);
    expect(r.guides).toContainEqual({ axis: 'y', pos: 960 });
  });

  it('兩個垂直候選同時落在閾值內,差距明顯 → 只吸最近的那個(上緣,而非中心)', () => {
    // bbox: y=90, h=1716
    // 上緣候選:|90 - 96| = 6(在閾值內)
    // 中心候選:bbox 中心 = 90 + 1716/2 = 948,|948 - 960| = 12(也在閾值內,但比上緣遠)
    // 下緣候選:bbox 下緣 = 90 + 1716 = 1806,|1806 - 1824| = 18(超出閾值,不參與)
    // 6 < 12,差距 6px、非平手 → 應吸上緣(96),絕不能吸中心(960)或兩者都吸
    const r = snapBBox({ x: 0, y: 90, w: 100, h: 1716 }, CANVAS);
    expect(r.y).toBe(96);
    expect(r.guides.filter((g) => g.axis === 'y')).toEqual([{ axis: 'y', pos: 96 }]);
  });

  it('近乎平手(差距僅 1px)→ 仍精準吸最近的那個,不會兩個都吸或選錯', () => {
    // bbox: y=88, h=1762
    // 上緣候選:|88 - 96| = 8(在閾值內)
    // 中心候選:bbox 中心 = 88 + 1762/2 = 969,|969 - 960| = 9(也在閾值內,只比上緣遠 1px)
    // 下緣候選:bbox 下緣 = 88 + 1762 = 1850,|1850 - 1824| = 26(超出閾值,不參與)
    // 8 < 9 → 應吸上緣(96)。這條測試專門守住「比較運算子/候選排序」不被改壞:
    // 若未來有人把 `<` 誤改成 `<=` 或打亂候選順序,1px 的差距會讓這裡先炸
    const r = snapBBox({ x: 0, y: 88, w: 100, h: 1762 }, CANVAS);
    expect(r.y).toBe(96);
    expect(r.guides.filter((g) => g.axis === 'y')).toEqual([{ axis: 'y', pos: 96 }]);
  });

  it('中心與上緣精確平手(差距均為 6px)→ 仍只回一條導線;鎖定目前的平手行為', () => {
    // bbox: y=102, h=1704
    // 上緣候選:|102 - 96| = 6
    // 中心候選:bbox 中心 = 102 + 1704/2 = 954,|954 - 960| = 6 —— 與上緣精確平手
    // 下緣候選:bbox 下緣 = 102 + 1704 = 1806,|1806 - 1824| = 18(超出閾值,不參與)
    // 平手時的勝出者「穩定但武斷」:candidates 陣列順序是 [中心, 上緣, 下緣],
    // reduce 用嚴格 `<` 比較、以第一個元素(中心)當初始累加值——上緣的 6 並不小於
    // 中心的 6,不會覆蓋累加值,所以中心(pos 960)勝出,而非上緣。這不是刻意設計的
    // 優先序語意,只是陣列順序 + 嚴格不等式的自然結果;寫這條測試把它釘住,
    // 好讓未來改動候選順序或比較運算子時,這裡會先失敗提醒。
    const r = snapBBox({ x: 0, y: 102, w: 100, h: 1704 }, CANVAS);
    expect(r.y).toBe(108); // 中心候選的 y = cy - h/2 = 960 - 852 = 108
    expect(r.guides.filter((g) => g.axis === 'y')).toEqual([{ axis: 'y', pos: 960 }]);
  });
});
