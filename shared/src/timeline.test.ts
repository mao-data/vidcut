import { describe, it, expect } from 'vitest';
import { createEmptyProject, type Project } from './types.js';
import {
  totalDuration,
  clipStartTimes,
  locate,
  overlayWindow,
  outputDuration,
  clipSourceTime,
  clipContentDuration,
} from './timeline.js';

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

// Plan 13 Task 1（裁決 1、4）：輸出長度 = 全軌最遠內容，主軌之後黑尾。
describe('outputDuration（Plan 13 裁決 1）', () => {
  it('純主軌（無其他軌超出）：outputDuration === totalDuration', () => {
    const p = proj(); // totalDuration = 10
    expect(outputDuration(p)).toBe(10);
  });

  it('audio 超出主軌總長：outputDuration 跟到 audio 的 start+duration', () => {
    const p = proj();
    p.tracks.audio = [
      { id: 'a1', mediaId: 'm2', start: 8, in: 0, duration: 5, volume: 1 }, // 8+5=13 > 10
    ];
    expect(outputDuration(p)).toBe(13);
  });

  it('caption 超出主軌總長：outputDuration 跟到 caption 的 start+duration', () => {
    const p = proj();
    p.tracks.captions = [
      {
        id: 'cap1',
        text: 'hi',
        start: 9,
        duration: 6, // 9+6=15 > 10
        style: { fontFamily: 'sans-serif', fontSize: 48, fill: '#fff', y: 0.8 },
      },
    ];
    expect(outputDuration(p)).toBe(15);
  });

  it('具體時長 overlay 超出主軌總長：outputDuration 跟到 overlay 的 win.end', () => {
    const p = proj();
    p.tracks.overlays = [
      {
        id: 'o1',
        imagePath: 'x.png',
        start: 9,
        duration: 4, // end = 13 > 10
        position: { x: 0, y: 0, scale: 1 },
      },
    ];
    expect(outputDuration(p)).toBe(13);
  });

  it('to-end overlay（duration:null）不參與計算——會循環，且它本該跟隨輸出而非決定輸出', () => {
    const p = proj();
    p.tracks.audio = [
      { id: 'a1', mediaId: 'm2', start: 8, in: 0, duration: 5, volume: 1 }, // 13
    ];
    p.tracks.overlays = [
      {
        id: 'o1',
        imagePath: 'x.png',
        start: 0,
        duration: null,
        position: { x: 0, y: 0, scale: 1 },
      },
    ];
    // 若 to-end overlay 誤參與計算會是無窮循環／NaN；正確答案只看 audio 超出
    expect(outputDuration(p)).toBe(13);
  });

  it('to-end overlay 的視窗結尾跟隨 outputDuration（黑尾也被蓋住）', () => {
    const p = proj();
    p.tracks.audio = [{ id: 'a1', mediaId: 'm2', start: 8, in: 0, duration: 5, volume: 1 }]; // 13
    const o: Project['tracks']['overlays'][number] = {
      id: 'o1',
      imagePath: 'x.png',
      start: 0,
      duration: null,
      position: { x: 0, y: 0, scale: 1 },
    };
    p.tracks.overlays = [o];
    expect(overlayWindow(p, o)).toEqual({ start: 0, end: 13 });
  });

  it('多軌同時超出：取最大值', () => {
    const p = proj();
    p.tracks.audio = [{ id: 'a1', mediaId: 'm2', start: 8, in: 0, duration: 5, volume: 1 }]; // 13
    p.tracks.captions = [
      {
        id: 'cap1',
        text: 'hi',
        start: 20,
        duration: 1, // 21 > 13
        style: { fontFamily: 'sans-serif', fontSize: 48, fill: '#fff', y: 0.8 },
      },
    ];
    expect(outputDuration(p)).toBe(21);
  });

  it('空專案：outputDuration 為 0', () => {
    expect(outputDuration(createEmptyProject('x', 'x'))).toBe(0);
  });
});

// Plan 14 Task 1：leadPad 前把手黑墊——clipSourceTime / clipContentDuration 是唯一真相來源。
describe('clipSourceTime / clipContentDuration（Plan 14 leadPad）', () => {
  it('無 leadPad：等同舊式子 in + offset（回歸釘）', () => {
    const clip = { in: 5, duration: 6 };
    expect(clipSourceTime(clip, 0)).toBe(5);
    expect(clipSourceTime(clip, 3)).toBe(8);
    expect(clipContentDuration(clip)).toBe(6);
  });

  it('leadPad=0（顯式）行為與缺席相同', () => {
    const clip = { in: 5, duration: 6, leadPad: 0 };
    expect(clipSourceTime(clip, 0)).toBe(5);
    expect(clipSourceTime(clip, 3)).toBe(8);
    expect(clipContentDuration(clip)).toBe(6);
  });

  it('offset 落在黑墊內回 null（該畫黑，沒有來源畫面）', () => {
    const clip = { in: 5, leadPad: 2 };
    expect(clipSourceTime(clip, 0)).toBeNull();
    expect(clipSourceTime(clip, 1.9)).toBeNull();
  });

  it('offset 落在黑墊之後：來源時間 = in + (offset - leadPad)', () => {
    const clip = { in: 5, leadPad: 2 };
    expect(clipSourceTime(clip, 2)).toBe(5); // 黑墊剛結束，緊接著來源 in
    expect(clipSourceTime(clip, 5)).toBe(8);
  });

  it('clipContentDuration = duration - leadPad', () => {
    expect(clipContentDuration({ duration: 10, leadPad: 3 })).toBe(7);
    expect(clipContentDuration({ duration: 10, leadPad: 0 })).toBe(10);
  });
});
