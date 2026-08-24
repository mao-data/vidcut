import { describe, it, expect } from 'vitest';
import {
  trimIn,
  trimInPad,
  trimOut,
  trimPlaceholder,
  reorderByDrag,
  layoutByOrder,
  clampStart,
  trimSpanIn,
  trimSpanOut,
  trimAudioIn,
  isAtSourceMax,
  MIN_CLIP_DURATION,
} from './dragMath.js';

describe('trimIn', () => {
  const clip = { in: 5, duration: 6 }; // 右界 = 11

  it('moving in right shrinks duration, keeps right edge', () => {
    expect(trimIn(clip, 2)).toEqual({ in: 7, duration: 4 });
  });

  it('moving in left grows duration', () => {
    expect(trimIn(clip, -3)).toEqual({ in: 2, duration: 9 });
  });

  it('clamps in to >= 0', () => {
    expect(trimIn(clip, -10)).toEqual({ in: 0, duration: 11 });
  });

  it('clamps so duration never below MIN', () => {
    const r = trimIn(clip, 100);
    expect(r.duration).toBeCloseTo(MIN_CLIP_DURATION);
    expect(r.in).toBeCloseTo(11 - MIN_CLIP_DURATION);
  });
});

describe('trimOut', () => {
  const clip = { in: 5, duration: 6 };

  it('extends duration up to media length', () => {
    expect(trimOut(clip, 2, 20)).toEqual({ duration: 8 });
  });

  it('clamps duration to media boundary (in+duration <= mediaDuration)', () => {
    expect(trimOut(clip, 100, 20)).toEqual({ duration: 15 }); // 5+15=20
  });

  it('clamps to MIN', () => {
    expect(trimOut(clip, -100, 20).duration).toBeCloseTo(MIN_CLIP_DURATION);
  });
});

describe('isAtSourceMax（Plan 11 Task 3 裁決 5：out 把手拖到來源盡頭的視覺判定）', () => {
  it('true when in+duration reaches mediaDuration exactly', () => {
    expect(isAtSourceMax({ in: 5, duration: 15 }, 20)).toBe(true);
  });

  it('true when clamped past the boundary（trimOut 的輸出餵回來，浮點可能微超）', () => {
    const clamped = trimOut({ in: 5, duration: 6 }, 100, 20); // duration: 15，恰好頂到 20
    expect(isAtSourceMax({ in: 5, duration: clamped.duration }, 20)).toBe(true);
  });

  it('false when there is still room before the source end', () => {
    expect(isAtSourceMax({ in: 5, duration: 6 }, 20)).toBe(false); // 5+6=11 < 20
  });

  it('false when mediaDuration is unknown (Infinity，無 probe 資料時的既有 fallback)', () => {
    expect(isAtSourceMax({ in: 5, duration: 6 }, Infinity)).toBe(false);
  });
});

describe('trimInPad（Plan 14 Task 4：主軌 trim-in 黑墊版，取代主軌拖曳分支的 trimIn）', () => {
  const clip = { in: 5, duration: 6 }; // 右界 R = 5 + (6-0) = 11，無 leadPad（pad=0）

  it('無 leadPad、拖曳仍落在來源座標內：行為與 trimIn 逐位元組相同（leadPad 恆 0）', () => {
    expect(trimInPad(clip, 2)).toEqual({ in: 7, leadPad: 0, duration: 4 });
    expect(trimInPad(clip, -3)).toEqual({ in: 2, leadPad: 0, duration: 9 });
  });

  it("恰好拖到 in=0（x'=0）：落地 leadPad=0，不進黑墊分支", () => {
    expect(trimInPad(clip, -5)).toEqual({ in: 0, leadPad: 0, duration: 11 });
  });

  it('拖過 in=0：長出 leadPad，duration 同步增長（右界 R=11 不變）', () => {
    // x = in - pad = 5；deltaSec = -7 → x' = -2 → in=0, leadPad=2, duration = 11+2 = 13
    expect(trimInPad(clip, -7)).toEqual({ in: 0, leadPad: 2, duration: 13 });
  });

  it('往回縮：先吃掉黑墊，leadPad 減少、in 仍為 0，直到黑墊吃完才開始縮 in', () => {
    const padded = trimInPad(clip, -7); // in=0 leadPad=2 duration=13
    // 從這個狀態再位移 +1（縮回 1s）：x = 0-2 = -2，+1 → x'=-1 → in=0, leadPad=1
    const shrunk = trimInPad(padded, 1);
    expect(shrunk).toEqual({ in: 0, leadPad: 1, duration: 12 });
  });

  it('往回縮跨越黑墊：黑墊吃完後繼續縮就開始吃內容（in 從 0 開始增加）', () => {
    const padded = trimInPad(clip, -7); // in=0 leadPad=2 duration=13
    // +3：x = -2 +3 = 1 >=0 → in=1, leadPad=0, duration = R-1 = 10
    const back = trimInPad(padded, 3);
    expect(back).toEqual({ in: 1, leadPad: 0, duration: 10 });
  });

  it('跨界往返：拖出黑墊再完全縮回原點，得到與起點等價的結果（leadPad=0, in=起點, duration=起點 duration）', () => {
    const out = trimInPad(clip, -7); // in=0 leadPad=2 duration=13
    const back = trimInPad(out, 7); // 抵銷：x' = -2+7 = 5 = 原始 x
    expect(back).toEqual({ in: 5, leadPad: 0, duration: 6 });
  });

  it("clamp：內容下限（x' <= R - MIN_CLIP_DURATION），無下界（可持續探入黑墊）", () => {
    // 拖到底：deltaSec 極大正值，x' 被夾在 R - MIN
    const r = trimInPad(clip, 100);
    expect(r.leadPad).toBe(0);
    expect(r.duration).toBeCloseTo(MIN_CLIP_DURATION);
    expect(r.in).toBeCloseTo(11 - MIN_CLIP_DURATION);
  });

  it('leadPad 無上限：deltaSec 極大負值時 leadPad 持續增長，不 clamp', () => {
    const r = trimInPad(clip, -1000);
    expect(r.in).toBe(0);
    expect(r.leadPad).toBeCloseTo(995); // x' = 5 - 1000 = -995 → leadPad=995
    expect(r.duration).toBeCloseTo(11 + 995);
  });

  it('浮點：帶入既有 leadPad 的 clip，式子讀 clip.leadPad 而非恆假設 0', () => {
    const paddedClip = { in: 0, duration: 13, leadPad: 2 }; // x = 0-2 = -2，R = 0+(13-2) = 11
    const r = trimInPad(paddedClip, -0.3);
    expect(r.in).toBe(0);
    expect(r.leadPad).toBeCloseTo(2.3);
    expect(r.duration).toBeCloseTo(13.3);
  });

  it('leadPad 缺席（undefined）等同 0（既有 clip 型別是 optional 欄位）', () => {
    const bare = { in: 5, duration: 6 }; // 型別上沒有 leadPad 欄位
    expect(trimInPad(bare, -7)).toEqual({ in: 0, leadPad: 2, duration: 13 });
  });
});

describe('trimPlaceholder（Plan 15 Task 1：統一拖曳模型核心式子——修剪方向佔位量）', () => {
  it('修剪方向（next < orig）：佔位量＝縮掉的秒數', () => {
    expect(trimPlaceholder(10, 6)).toBe(4);
  });

  it('擴張方向（next > orig）：佔位恆為 0（現況 ripple 行為不變）', () => {
    expect(trimPlaceholder(10, 15)).toBe(0);
  });

  it('相等（next === orig）：佔位為 0（無淨修剪）', () => {
    expect(trimPlaceholder(10, 10)).toBe(0);
  });

  it('浮點：微幅修剪與微幅擴張都不因浮點誤差翻面', () => {
    expect(trimPlaceholder(10, 9.9999)).toBeCloseTo(0.0001);
    expect(trimPlaceholder(10, 10.0001)).toBe(0);
  });

  it('origDuration 為 0（理論邊界，不應發生但式子仍需良態）：只可能是擴張或相等，恆為 0', () => {
    expect(trimPlaceholder(0, 5)).toBe(0);
    expect(trimPlaceholder(0, 0)).toBe(0);
  });
});

describe('reorderByDrag', () => {
  const layout = [
    { id: 'a', left: 0, width: 100 },
    { id: 'b', left: 100, width: 100 },
    { id: 'c', left: 200, width: 100 },
  ];

  it('drops before b when pointer left of b center', () => {
    // dragging 'c', pointer at 120 (< b center 150) → c goes before b
    expect(reorderByDrag(['a', 'b', 'c'], 'c', 120, layout)).toEqual(['a', 'c', 'b']);
  });

  it('drops at end when pointer past everything', () => {
    expect(reorderByDrag(['a', 'b', 'c'], 'a', 999, layout)).toEqual(['b', 'c', 'a']);
  });

  it('drops at start when pointer before first center', () => {
    expect(reorderByDrag(['a', 'b', 'c'], 'c', 10, layout)).toEqual(['c', 'a', 'b']);
  });
});

describe('layoutByOrder', () => {
  const clips = [
    { id: 'a', duration: 2 },
    { id: 'b', duration: 3 },
    { id: 'c', duration: 1 },
  ];

  it('lays out in array order when no reorder is pending', () => {
    const m = layoutByOrder(clips, null, 10);
    expect([...m]).toEqual([
      ['a', 0],
      ['b', 20],
      ['c', 50],
    ]);
  });

  it('shifts the others aside for the pending order (this is the 讓位 animation target)', () => {
    // 把 c 拖到最前面：c 佔 0，a 被推到 10，b 被推到 30
    const m = layoutByOrder(clips, ['c', 'a', 'b'], 10);
    expect(m.get('c')).toBe(0);
    expect(m.get('a')).toBe(10);
    expect(m.get('b')).toBe(30);
  });

  it('ignores ids that no longer exist', () => {
    const m = layoutByOrder(clips, ['zz', 'a', 'b', 'c'], 10);
    expect(m.get('a')).toBe(0);
    expect(m.size).toBe(3);
  });
});

describe('clampStart', () => {
  it('moves by delta and clamps at 0', () => {
    expect(clampStart(7)).toBe(7);
    expect(clampStart(3)).toBe(3);
    expect(clampStart(-4)).toBe(0);
  });
});

describe('trimSpanIn (caption 左緣：右緣不動)', () => {
  const cap = { start: 4, duration: 3 }; // 右緣 = 7

  it('moving right shrinks duration, keeps right edge', () => {
    expect(trimSpanIn(cap, 1)).toEqual({ start: 5, duration: 2 });
  });

  it('moving left grows duration', () => {
    expect(trimSpanIn(cap, -2)).toEqual({ start: 2, duration: 5 });
  });

  it('clamps start at 0', () => {
    expect(trimSpanIn(cap, -10)).toEqual({ start: 0, duration: 7 });
  });

  it('never below MIN duration', () => {
    const r = trimSpanIn(cap, 100);
    expect(r.duration).toBeCloseTo(MIN_CLIP_DURATION);
    expect(r.start).toBeCloseTo(7 - MIN_CLIP_DURATION);
  });
});

describe('trimSpanOut (右緣：只改 duration)', () => {
  it('grows and shrinks with optional max', () => {
    expect(trimSpanOut({ duration: 3 }, 2)).toEqual({ duration: 5 });
    expect(trimSpanOut({ duration: 3 }, 2, 4)).toEqual({ duration: 4 });
    expect(trimSpanOut({ duration: 3 }, -100).duration).toBeCloseTo(MIN_CLIP_DURATION);
  });
});

describe('trimAudioIn (音訊左緣：start/in/duration 連動，右緣不動)', () => {
  const a = { start: 5, in: 2, duration: 4 }; // 時間軸右緣 9、來源右緣 6

  it('moving right advances start+in together', () => {
    expect(trimAudioIn(a, 1)).toEqual({ start: 6, in: 3, duration: 3 });
  });

  it('moving left is limited by in >= 0', () => {
    // delta -3 但 in 只剩 2 → 實際只能 -2
    expect(trimAudioIn(a, -3)).toEqual({ start: 3, in: 0, duration: 6 });
  });

  it('moving left is limited by start >= 0 too', () => {
    const b = { start: 1, in: 5, duration: 2 };
    expect(trimAudioIn(b, -3)).toEqual({ start: 0, in: 4, duration: 3 });
  });

  it('never below MIN duration', () => {
    const r = trimAudioIn(a, 100);
    expect(r.duration).toBeCloseTo(MIN_CLIP_DURATION);
    expect(r.start).toBeCloseTo(9 - MIN_CLIP_DURATION);
    expect(r.in).toBeCloseTo(6 - MIN_CLIP_DURATION);
  });
});

// filmstripBgOffset（單一 background-image 紋理位移）已隨 Plan 9 Task 3 退役——
// ClipBlock 改成時間對齊的逐格 div 渲染（見 filmstripTiles.ts 與其測試）。
// 這裡不是「測試被刪」，是「被測數學本身不存在了」：新模型的等價覆蓋在
// filmstripTiles.test.ts（secPerTileFor 的舊資產回退、zoom-in/out 取樣、
// windowing、sprite 邊緣 clamp）。
