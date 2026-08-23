import { describe, it, expect } from 'vitest';
import { filmstripPlan } from './filmstrip.js';

describe('filmstripPlan', () => {
  it('短片（16:9 300s）：格數與今天行為一致 = ceil(duration)', () => {
    const r = filmstripPlan({ durationSec: 300, width: 1920, height: 1080 });
    expect(r.tiles).toBe(300);
    expect(r.fps).toBeCloseTo(1, 6); // 1 幀/秒，與舊行為一致
  });

  it('長片（16:9 1080p 1685s，真實 bug repro）：格數被夾到 JPEG 上限內', () => {
    // tileW = even(round(80 * 1920/1080)) = even(round(142.22)) = even(142) = 142
    const r = filmstripPlan({ durationSec: 1685, width: 1920, height: 1080 });
    expect(r.tiles).toBe(457); // floor(65000/142) = 457
    expect(r.tiles * 142).toBeLessThanOrEqual(65000);
    expect(r.fps).toBeCloseTo(457 / 1685, 6); // ≈0.271
  });

  it('9:16 直式（1080×1920，tileW=46）：maxTiles=1413', () => {
    // tileW = even(round(80 * 1080/1920)) = even(round(45)) = 46（45 進位到偶數）
    const r = filmstripPlan({ durationSec: 10000, width: 1080, height: 1920 });
    expect(r.tiles).toBe(1413); // floor(65000/46) = 1413
  });

  it('超寬（2560×1072）：長片一樣被夾住', () => {
    // tileW = even(round(80*2560/1072)) = even(round(191.04)) = even(191) = 192
    const r = filmstripPlan({ durationSec: 5000, width: 2560, height: 1072 });
    const maxTiles = Math.floor(65000 / 192);
    expect(r.tiles).toBe(maxTiles);
    expect(r.tiles * 192).toBeLessThanOrEqual(65000);
  });

  it('極短片（0.4s）：至少 1 格', () => {
    const r = filmstripPlan({ durationSec: 0.4, width: 1920, height: 1080 });
    expect(r.tiles).toBe(1);
    expect(r.fps).toBeCloseTo(1 / 0.4, 6);
  });

  it('邊界：ceil(duration) 恰好等於 maxTiles 時不裁切、fps≈1（整秒邊界誤差在浮點範圍內）', () => {
    // tileW=142 → maxTiles=457；duration=457（整數秒）使 ceil(duration)===457===maxTiles，
    // 剛好卡在「還沒超過天花板」那一格，此時 tiles===durationSec，fps 精確等於 1。
    const r = filmstripPlan({ durationSec: 457, width: 1920, height: 1080 });
    expect(r.tiles).toBe(457);
    expect(r.fps).toBeCloseTo(1, 6);
  });

  it('邊界：ceil(duration) 剛超過 maxTiles 一格時才開始降頻', () => {
    // duration=457.5 → ceil=458 > maxTiles=457 → 夾到 457，fps 略低於 1
    const r = filmstripPlan({ durationSec: 457.5, width: 1920, height: 1080 });
    expect(r.tiles).toBe(457);
    expect(r.fps).toBeLessThan(1);
  });

  it('tiles 恆為正整數、fps 恆為正數', () => {
    for (const durationSec of [0.1, 1, 59.9, 300, 1685, 10000]) {
      const r = filmstripPlan({ durationSec, width: 1920, height: 1080 });
      expect(Number.isInteger(r.tiles)).toBe(true);
      expect(r.tiles).toBeGreaterThanOrEqual(1);
      expect(r.fps).toBeGreaterThan(0);
    }
  });
});
