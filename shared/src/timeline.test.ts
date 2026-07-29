import { describe, it, expect } from 'vitest';
import { createEmptyProject, type Project } from './types.js';
import { totalDuration, clipStartTimes, locate, overlayWindow } from './timeline.js';

function proj(): Project {
  const p = createEmptyProject('p', 'test');
  p.media = [
    {
      id: 'm1',
      path: 'a.mp4',
      probe: { duration: 20, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
    },
    {
      id: 'm2',
      path: 'b.mp4',
      probe: { duration: 30, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
    },
  ];
  p.tracks.video = [
    { id: 'c1', mediaId: 'm1', in: 5, duration: 6, volume: 1 },
    { id: 'c2', mediaId: 'm2', in: 10, duration: 4, volume: 1 },
  ];
  return p;
}

describe('timeline math', () => {
  it('totalDuration sums clip durations', () => {
    expect(totalDuration(proj())).toBe(10);
    expect(totalDuration(createEmptyProject('x', 'x'))).toBe(0);
  });

  it('clipStartTimes are cumulative', () => {
    expect(clipStartTimes(proj())).toEqual([0, 6]);
  });

  it('locate maps timeline time to clip + offset', () => {
    const p = proj();
    expect(locate(p, 0)).toMatchObject({ clipIndex: 0, offsetInClip: 0 });
    expect(locate(p, 5.5)).toMatchObject({ clipIndex: 0, offsetInClip: 5.5 });
    expect(locate(p, 6)).toMatchObject({ clipIndex: 1, offsetInClip: 0 }); // 邊界歸右側
    expect(locate(p, 9.9)?.clip.id).toBe('c2');
    expect(locate(p, 10)).toMatchObject({ clipIndex: 1, offsetInClip: 4 }); // 片尾特例
    expect(locate(p, 10.01)).toBeNull();
    expect(locate(p, -0.1)).toBeNull();
  });

  it('overlayWindow resolves anchors and null duration', () => {
    const p = proj();
    expect(
      overlayWindow(p, {
        id: 'o1',
        imagePath: 'x.png',
        start: 1,
        duration: 3,
        position: { x: 0, y: 0, scale: 1 },
      }),
    ).toEqual({ start: 1, end: 4 });
    expect(
      overlayWindow(p, {
        id: 'o2',
        imagePath: 'x.png',
        start: 2,
        duration: null,
        position: { x: 0, y: 0, scale: 1 },
      }),
    ).toEqual({ start: 2, end: 10 });
    expect(
      overlayWindow(p, {
        id: 'o3',
        imagePath: 'x.png',
        anchor: { clipId: 'c2', offset: 0.5 },
        duration: 2,
        position: { x: 0, y: 0, scale: 1 },
      }),
    ).toEqual({ start: 6.5, end: 8.5 });
    expect(
      overlayWindow(p, {
        id: 'o4',
        imagePath: 'x.png',
        anchor: { clipId: 'nope', offset: 0 },
        duration: 2,
        position: { x: 0, y: 0, scale: 1 },
      }),
    ).toBeNull();
  });
});
