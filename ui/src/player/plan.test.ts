import { describe, it, expect } from 'vitest';
import { createEmptyProject, type Project } from '@vidcut/shared';
import { planAt } from './plan.js';

function proj(): Project {
  const p = createEmptyProject('p', 't');
  p.media = [
    {
      id: 'm1',
      path: 'a.mp4',
      proxyPath: 'derived/m1/proxy.mp4',
      probe: { duration: 20, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
    },
    {
      id: 'm2',
      path: 'b.mp4',
      proxyPath: 'derived/m2/proxy.mp4',
      probe: { duration: 20, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
    },
  ];
  p.tracks.video = [
    { id: 'c1', mediaId: 'm1', in: 2, duration: 6, volume: 1 },
    { id: 'c2', mediaId: 'm2', in: 0, duration: 4, volume: 1 },
  ];
  p.tracks.overlays = [
    {
      id: 'o1',
      imagePath: 'ov.png',
      start: 0,
      duration: null,
      position: { x: 0.5, y: 0.1, scale: 1 },
    },
  ];
  p.tracks.audio = [
    {
      id: 'a1',
      mediaId: 'm2',
      start: 2,
      in: 1,
      duration: 5,
      volume: 0.8,
      fadeIn: 2,
      fadeOut: 1,
      ducking: true,
    },
  ];
  p.tracks.captions = [
    {
      id: 'cap1',
      text: 'hi',
      start: 5,
      duration: 3,
      style: { fontFamily: 'sans-serif', fontSize: 48, fill: '#fff', y: 0.8 },
    },
  ];
  return p;
}

describe('planAt', () => {
  it('maps timeline t to active proxy src + source time', () => {
    const plan = planAt(proj(), 3);
    expect(plan.active).toMatchObject({
      clipId: 'c1',
      src: '/media/derived/m1/proxy.mp4',
      sourceTime: 5,
    }); // in 2 + offset 3
    expect(plan.next).toMatchObject({ clipId: 'c2', sourceTime: 0 });
    expect(plan.done).toBe(false);
  });

  it('last clip has no next; end of timeline is done', () => {
    expect(planAt(proj(), 7).next).toBeNull();
    expect(planAt(proj(), 10).done).toBe(true);
  });

  it('audio items: window, source time, fade gain, ducking', () => {
    // 窗外（t=1 < start=2）→ 無活躍音訊、不 duck
    expect(planAt(proj(), 1).audio).toHaveLength(0);
    expect(planAt(proj(), 1).ducked).toBe(false);
    // t=3：rel=1，fadeIn=2 → 增益 0.5 → 0.8*0.5；sourceTime = in 1 + rel 1
    const mid = planAt(proj(), 3);
    expect(mid.audio).toMatchObject([
      { id: 'a1', src: '/media/derived/m2/proxy.mp4', sourceTime: 2, ducking: true },
    ]);
    expect(mid.audio[0]!.volume).toBeCloseTo(0.4);
    expect(mid.ducked).toBe(true);
    // t=6.5：remain=0.5，fadeOut=1 → 增益 0.5
    expect(planAt(proj(), 6.5).audio[0]!.volume).toBeCloseTo(0.4);
    // 窗尾（t=7 = start+duration）→ 結束
    expect(planAt(proj(), 7).audio).toHaveLength(0);
  });

  it('active source carries clip volume', () => {
    const p = proj();
    p.tracks.video[0]!.volume = 0;
    expect(planAt(p, 3).active).toMatchObject({ clipId: 'c1', volume: 0 });
  });

  it('overlays/captions filtered by time window', () => {
    expect(planAt(proj(), 1).overlays).toHaveLength(1);
    expect(planAt(proj(), 1).captions).toHaveLength(0);
    expect(planAt(proj(), 6).captions).toMatchObject([{ id: 'cap1', text: 'hi' }]);
  });
});
