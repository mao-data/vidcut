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

  it('overlays/captions filtered by time window', () => {
    expect(planAt(proj(), 1).overlays).toHaveLength(1);
    expect(planAt(proj(), 1).captions).toHaveLength(0);
    expect(planAt(proj(), 6).captions).toMatchObject([{ id: 'cap1', text: 'hi' }]);
  });
});
