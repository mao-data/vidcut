import { describe, it, expect } from 'vitest';
import { overlapSegments } from './overlap.js';

describe('overlapSegments', () => {
  it('兩個不重疊的項目回傳空陣列', () => {
    const r = overlapSegments([
      { id: 'a', start: 0, end: 2 },
      { id: 'b', start: 3, end: 5 },
    ]);
    expect(r).toEqual([]);
  });

  it('兩個部分重疊的項目，各自回傳對齊的重疊子區間', () => {
    const r = overlapSegments([
      { id: 'a', start: 0, end: 3 },
      { id: 'b', start: 2, end: 5 },
    ]);
    expect(r).toContainEqual({ id: 'a', start: 2, end: 3 });
    expect(r).toContainEqual({ id: 'b', start: 2, end: 3 });
    expect(r).toHaveLength(2);
  });

  it('邊界恰好相接（a.end === b.start）不算重疊', () => {
    const r = overlapSegments([
      { id: 'a', start: 0, end: 2 },
      { id: 'b', start: 2, end: 4 },
    ]);
    expect(r).toEqual([]);
  });

  it('一個項目完全包住另一個：外層的重疊子區間恰等於內層的整個窗口', () => {
    const r = overlapSegments([
      { id: 'outer', start: 0, end: 10 },
      { id: 'inner', start: 3, end: 5 },
    ]);
    expect(r).toContainEqual({ id: 'outer', start: 3, end: 5 });
    expect(r).toContainEqual({ id: 'inner', start: 3, end: 5 });
  });

  it('三個項目、中間那個同時與左右重疊 → 分別回報兩段獨立子區間', () => {
    // left [0,3), mid [2,6), right [5,8)
    // mid 與 left 重疊 [2,3)，與 right 重疊 [5,6) —— 兩段分開、不該被誤合併
    // （它們之間 [3,5) 沒有重疊，合併只該發生在真正相鄰/重疊的子區間之間）。
    const r = overlapSegments([
      { id: 'left', start: 0, end: 3 },
      { id: 'mid', start: 2, end: 6 },
      { id: 'right', start: 5, end: 8 },
    ]);
    const mid = r.filter((s) => s.id === 'mid');
    expect(mid).toContainEqual({ id: 'mid', start: 2, end: 3 });
    expect(mid).toContainEqual({ id: 'mid', start: 5, end: 6 });
    expect(mid).toHaveLength(2);
    expect(r).toContainEqual({ id: 'left', start: 2, end: 3 });
    expect(r).toContainEqual({ id: 'right', start: 5, end: 6 });
  });

  it('一個項目同時被兩個重疊區間覆蓋且兩段本身相連 → 合併成一段', () => {
    // a: [0,10)；b: [1,4)；c: [3,7) —— a 與 b 的重疊 [1,4)、a 與 c 的重疊 [3,7)
    // 對 a 來說這兩段相接/重疊，應合併成 [1,7)。
    const r = overlapSegments([
      { id: 'a', start: 0, end: 10 },
      { id: 'b', start: 1, end: 4 },
      { id: 'c', start: 3, end: 7 },
    ]);
    const a = r.filter((s) => s.id === 'a');
    expect(a).toEqual([{ id: 'a', start: 1, end: 7 }]);
  });

  it('duration=null 的 overlay（win.end 已材料化成專案總長）當成一般數值處理', () => {
    // overlayWindow() 在呼叫端已經把 duration:null 解析成 totalDuration(p)，
    // 這個純函數只吃解析後的 {start, end} 數值窗，不需要認識 null——
    // 這裡用一個「到片尾」的窗口驗證它跟一般數值窗行為一致。
    const projectEnd = 20;
    const r = overlapSegments([
      { id: 'toEnd', start: 5, end: projectEnd },
      { id: 'other', start: 15, end: 18 },
    ]);
    expect(r).toContainEqual({ id: 'toEnd', start: 15, end: 18 });
    expect(r).toContainEqual({ id: 'other', start: 15, end: 18 });
  });

  it('單一項目或空陣列回傳空陣列', () => {
    expect(overlapSegments([])).toEqual([]);
    expect(overlapSegments([{ id: 'a', start: 0, end: 5 }])).toEqual([]);
  });
});
