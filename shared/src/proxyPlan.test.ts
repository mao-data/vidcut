import { describe, it, expect } from 'vitest';
import { proxyPlan } from './proxyPlan.js';

// 基準：全條件成立的 web-compatible H.264 直式素材（skip 判準的正中心）。
const baseline = {
  codec: 'h264',
  pixFmt: 'yuv420p',
  container: 'mp4',
  width: 1080,
  height: 1920,
  fps: 30,
  keyframeIntervalSec: 2,
};

describe('proxyPlan', () => {
  it('全條件成立 → skip', () => {
    expect(proxyPlan(baseline)).toBe('skip');
  });

  it('codec ≠ h264（例：hevc）→ transcode', () => {
    expect(proxyPlan({ ...baseline, codec: 'hevc' })).toBe('transcode');
  });

  it('pixFmt=yuv420p10le（10-bit）→ transcode', () => {
    expect(proxyPlan({ ...baseline, pixFmt: 'yuv420p10le' })).toBe('transcode');
  });

  it('1440×2560（直式但 max(w,h)=2560>1920）→ transcode', () => {
    expect(proxyPlan({ ...baseline, width: 1440, height: 2560 })).toBe('transcode');
  });

  it('1080×1920（直式邊界 max=1920）→ skip', () => {
    expect(proxyPlan({ ...baseline, width: 1080, height: 1920 })).toBe('skip');
  });

  it('fps=59.94 → skip（≤60）', () => {
    expect(proxyPlan({ ...baseline, fps: 59.94 })).toBe('skip');
  });

  it('fps=120 → transcode', () => {
    expect(proxyPlan({ ...baseline, fps: 120 })).toBe('transcode');
  });

  it('container=matroska、其餘全綠 → remux', () => {
    expect(proxyPlan({ ...baseline, container: 'matroska' })).toBe('remux');
  });

  it('keyframeIntervalSec=undefined（量測失敗/欄位缺席）→ transcode（保守）', () => {
    expect(proxyPlan({ ...baseline, keyframeIntervalSec: undefined })).toBe('transcode');
  });

  it('keyframeIntervalSec=3.0 邊界 → skip', () => {
    expect(proxyPlan({ ...baseline, keyframeIntervalSec: 3.0 })).toBe('skip');
  });

  it('keyframeIntervalSec=3.1 → transcode', () => {
    expect(proxyPlan({ ...baseline, keyframeIntervalSec: 3.1 })).toBe('transcode');
  });

  it('codec/pixFmt/container 全缺席 → transcode（保守）', () => {
    expect(
      proxyPlan({
        width: 1080,
        height: 1920,
        fps: 30,
        keyframeIntervalSec: 2,
      }),
    ).toBe('transcode');
  });

  it('僅 container 缺席、其餘全綠 → transcode（保守；不可誤判成 remux）', () => {
    expect(proxyPlan({ ...baseline, container: undefined })).toBe('transcode');
  });
});
