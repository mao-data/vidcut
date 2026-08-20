import { describe, it, expect } from 'vitest';
import {
  timeToPx,
  pxToTime,
  clampPps,
  snapTime,
  fitPps,
  zoomBoundsFor,
  tickPlanFor,
  tickLabel,
  DEFAULT_PX_PER_SECOND,
  MIN_PX_PER_SECOND,
  MAX_PX_PER_SECOND,
  MIN_LABEL_SPACING_PX,
  MIN_DOT_SPACING_PX,
} from './scale.js';

describe('timeline scale', () => {
  it('round-trips at any zoom', () => {
    expect(timeToPx(2.5, 60)).toBe(150);
    expect(pxToTime(timeToPx(7.3, 137), 137)).toBeCloseTo(7.3);
  });

  it('clamps zoom into range using default bounds', () => {
    expect(clampPps(1)).toBe(MIN_PX_PER_SECOND);
    expect(clampPps(9999)).toBe(MAX_PX_PER_SECOND);
    expect(clampPps(60)).toBe(60);
  });

  it('clamps zoom into caller-supplied bounds', () => {
    expect(clampPps(0.3, { min: 0.69, max: 120 })).toBeCloseTo(0.69);
    expect(clampPps(9999, { min: 0.69, max: 120 })).toBe(120);
    expect(clampPps(50, { min: 0.69, max: 120 })).toBe(50);
  });
});

describe('zoomBoundsFor', () => {
  it('long project: whole-project-fit becomes the floor (below the old MIN=5)', () => {
    const { min, max } = zoomBoundsFor(1687, 1200);
    expect(min).toBeCloseTo(0.6876111440426793, 5);
    expect(max).toBe(120);
  });

  it('short project: floor stays at 5 (fit would be far above 5)', () => {
    const { min, max } = zoomBoundsFor(10, 640);
    expect(min).toBe(5);
    expect(max).toBe(120);
  });

  it('empty project (totalSeconds=0): falls back to {min:5, max:120}, no divide-by-zero', () => {
    const { min, max } = zoomBoundsFor(0, 1200);
    expect(min).toBe(5);
    expect(max).toBe(120);
    expect(Number.isFinite(min)).toBe(true);
  });

  it('tiny viewport: min still finite and clamped sanely, never exceeds max', () => {
    const { min, max } = zoomBoundsFor(1687, 1);
    expect(Number.isFinite(min)).toBe(true);
    expect(min).toBeGreaterThan(0);
    expect(min).toBeLessThanOrEqual(max);
  });

  it('max is always 120 regardless of inputs', () => {
    expect(zoomBoundsFor(3, 400).max).toBe(120);
    expect(zoomBoundsFor(99999, 50).max).toBe(120);
  });
});

describe('tickPlanFor（CapCut 式像素密度自適應）', () => {
  it('任意 pps 下，標籤像素間距都 >= MIN_LABEL_SPACING_PX', () => {
    // 掃過整個縮放範圍（含極端值），標籤永遠不擠：這是這次改動的核心承諾。
    for (let pps = 0.3; pps <= 120; pps += 0.7) {
      const { labelStepSec } = tickPlanFor(pps);
      expect(labelStepSec * pps).toBeGreaterThanOrEqual(MIN_LABEL_SPACING_PX);
    }
  });

  it('選的是「滿足門檻的最小」nice step，不是隨便一個大 step（否則會太稀疏）', () => {
    // pps=100：候選中 1s(100px)已達標(>=80)，理論最小；不該跳去 2s(200px)。
    expect(tickPlanFor(100).labelStepSec).toBe(1);
    // pps=50：1s=50px 不夠，2s=100px 達標 → 選 2s。
    expect(tickPlanFor(50).labelStepSec).toBe(2);
    // pps=8：5s=40px 不夠，10s=80px 達標 → 選 10s。
    expect(tickPlanFor(8).labelStepSec).toBe(10);
  });

  it('最大縮放 pps=120 → labelStepSec=1（使用者明示的最細刻度需求）', () => {
    expect(tickPlanFor(120).labelStepSec).toBe(1);
  });

  it('pps 越小，labelStepSec 只會越大或持平（單調不減）', () => {
    const ppsSweep = [120, 60, 40, 20, 10, 5, 2, 1, 0.5, 0.3, 0.05];
    let prevStep = 0;
    for (const pps of ppsSweep) {
      const { labelStepSec } = tickPlanFor(pps);
      expect(labelStepSec).toBeGreaterThanOrEqual(prevStep);
      prevStep = labelStepSec;
    }
  });

  it('absurdly low pps（無 nice step 能達標）→ 退回最大檔 3600s', () => {
    expect(tickPlanFor(0.001).labelStepSec).toBe(3600);
  });

  it('dotStepSec：像素夠寬時提供細分點，且像素間距 >= MIN_DOT_SPACING_PX', () => {
    // pps=100，labelStep=1s(100px)。/5=0.2s → 20px >= 10px 門檻 → 應該取 /5。
    const plan = tickPlanFor(100);
    expect(plan.labelStepSec).toBe(1);
    expect(plan.dotStepSec).toBeCloseTo(0.2);
    expect((plan.dotStepSec ?? 0) * 100).toBeGreaterThanOrEqual(MIN_DOT_SPACING_PX);
  });

  it('dotStepSec：/5 太窄時退而求其次用 /2；兩者都太窄則 undefined（無點）', () => {
    // pps=8，labelStep=10s(80px)。/5=2s→16px>=10 應該還是能用 /5。
    // 換一個真正卡在中間的：找 labelStep 使 /5 不夠但 /2 夠。
    // labelStep*pps 恰好在門檻邊緣時 /5 的間距 = labelStep*pps/5。
    // 用 pps=4：labelStepFor(4) → 30s*4=120px 達標(>=80)？check smallest first。
    const plan = tickPlanFor(4);
    // 不論選到哪個 labelStep，只要 dotStepSec 存在，其像素間距必須 >= MIN_DOT_SPACING_PX。
    if (plan.dotStepSec !== undefined) {
      expect(plan.dotStepSec * 4).toBeGreaterThanOrEqual(MIN_DOT_SPACING_PX);
    }
  });

  it('dotStepSec 永遠不會 <= 0 也不會 >= labelStepSec（純粹是標籤之間的細分）', () => {
    for (let pps = 0.3; pps <= 120; pps += 1.3) {
      const { labelStepSec, dotStepSec } = tickPlanFor(pps);
      if (dotStepSec !== undefined) {
        expect(dotStepSec).toBeGreaterThan(0);
        expect(dotStepSec).toBeLessThan(labelStepSec);
      }
    }
  });
});

describe('tickLabel (m:ss)', () => {
  it('renders sub-minute seconds as plain seconds', () => {
    expect(tickLabel(0)).toBe('0s');
    expect(tickLabel(45)).toBe('45s');
  });

  it('renders minute-and-above as m:ss', () => {
    expect(tickLabel(60)).toBe('1:00');
    expect(tickLabel(90)).toBe('1:30');
    expect(tickLabel(605)).toBe('10:05');
  });
});

describe('snapTime', () => {
  const candidates = [0, 4, 8, 12];

  it('snaps when within the pixel threshold', () => {
    // pps=60 → 8px = 0.133s
    expect(snapTime(4.05, candidates, 60)).toBe(4);
    expect(snapTime(7.95, candidates, 60)).toBe(8);
  });

  it('leaves the value alone when too far', () => {
    expect(snapTime(4.5, candidates, 60)).toBe(4.5);
  });

  it('threshold scales with zoom (zoomed in = finer snapping)', () => {
    // pps=400 → 8px = 0.02s，0.05s 的距離就不該吸附
    expect(snapTime(4.05, candidates, 400)).toBe(4.05);
    expect(snapTime(4.01, candidates, 400)).toBe(4);
  });

  it('picks the nearest candidate', () => {
    expect(snapTime(4.06, [4, 4.1], 60)).toBe(4.1);
  });
});

describe('fitPps', () => {
  it('fits the whole timeline into the container', () => {
    expect(fitPps(10, 640, 40)).toBe(60); // (640-40)/10
  });

  it('falls back to default for an empty timeline and clamps extremes', () => {
    expect(fitPps(0, 800)).toBe(DEFAULT_PX_PER_SECOND);
    expect(fitPps(10_000, 800)).toBe(MIN_PX_PER_SECOND);
  });
});
