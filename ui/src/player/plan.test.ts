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
    // src 不在 plan 裡（<audio> 元素由 doc.tracks.audio 常駐渲染，見 ActiveAudio 註解）；
    // 元素 src 由 Player.test.tsx 的 "mounts one <audio> per audio item" 驗
    expect(mid.audio).toMatchObject([{ id: 'a1', sourceTime: 2, ducking: true }]);
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

describe('planAt 黑尾（Plan 13 裁決 1、4）', () => {
  it('無黑尾專案：主軌區間行為逐位元組不變、done 仍在 totalDuration', () => {
    const p = proj(); // totalDuration = 10；audio/caption 都在 10 以內
    expect(planAt(p, 3)).toEqual({
      active: planAt(p, 3).active,
      next: planAt(p, 3).next,
      overlays: planAt(p, 3).overlays,
      captions: planAt(p, 3).captions,
      audio: planAt(p, 3).audio,
      ducked: planAt(p, 3).ducked,
      done: planAt(p, 3).done,
      blackTail: false,
    });
    expect(planAt(p, 3).blackTail).toBe(false);
    expect(planAt(p, 9.99).blackTail).toBe(false);
    expect(planAt(p, 10).done).toBe(true);
    expect(planAt(p, 10).blackTail).toBe(false); // 已 done，不是黑尾（黑尾是 done 之前的一段）
  });

  it('audio 超出主軌總長：黑尾區間 active 為 null、blackTail 為 true、done 未到', () => {
    const p = proj(); // totalDuration = 10
    p.tracks.audio = [
      { id: 'a1', mediaId: 'm2', start: 8, in: 0, duration: 5, volume: 1 }, // 8+5=13
    ];
    const plan = planAt(p, 11); // 在 [10, 13) 黑尾區間
    expect(plan.active).toBeNull();
    expect(plan.next).toBeNull();
    expect(plan.blackTail).toBe(true);
    expect(plan.done).toBe(false);
  });

  it('done 改在 outputDuration 觸發（而非主軌 totalDuration）', () => {
    const p = proj();
    p.tracks.audio = [{ id: 'a1', mediaId: 'm2', start: 8, in: 0, duration: 5, volume: 1 }]; // 13
    expect(planAt(p, 10).done).toBe(false); // 主軌已結束但輸出還沒結束
    expect(planAt(p, 12.99).done).toBe(false);
    expect(planAt(p, 13).done).toBe(true);
    expect(planAt(p, 13).blackTail).toBe(false); // done 之後不算黑尾
  });

  it('黑尾區間音訊仍活躍：activeAudioAt 自然涵蓋主軌之後的時刻', () => {
    const p = proj();
    p.tracks.audio = [{ id: 'a1', mediaId: 'm2', start: 8, in: 0, duration: 5, volume: 1 }]; // 8..13
    const plan = planAt(p, 11); // 黑尾區間裡，audio 仍在窗內（8<=11<13）
    expect(plan.audio).toMatchObject([{ id: 'a1' }]);
    expect(plan.audio[0]!.sourceTime).toBeCloseTo(3); // in 0 + rel(11-8)
  });

  it('黑尾區間字幕/overlay 照常顯示（與成品一致，裁決 4）', () => {
    const p = proj();
    p.tracks.audio = [{ id: 'a1', mediaId: 'm2', start: 8, in: 0, duration: 5, volume: 1 }]; // 13
    p.tracks.captions = [
      {
        id: 'capTail',
        text: 'tail',
        start: 10.5,
        duration: 2,
        style: { fontFamily: 'sans-serif', fontSize: 48, fill: '#fff', y: 0.8 },
      },
    ];
    const plan = planAt(p, 11);
    expect(plan.captions).toMatchObject([{ id: 'capTail' }]);
  });

  it('空專案（total=0）：done 與 blackTail 都是 false', () => {
    const p = createEmptyProject('x', 'x');
    const plan = planAt(p, 0);
    expect(plan.done).toBe(false);
    expect(plan.blackTail).toBe(false);
    expect(plan.active).toBeNull();
  });
});

describe('planAt trimPreview override（Plan 12 Task 2/裁決 3）', () => {
  it('active clip matches override clipId：sourceTime 用 override in，不用 doc 的 in', () => {
    // c1: in=2, doc in 不變；trim-in 拖曳中把 in 預覽成 5，offset（t=3 相對 clipStart=0）仍是 3
    const plan = planAt(proj(), 3, { clipId: 'c1', in: 5 });
    expect(plan.active).toMatchObject({ clipId: 'c1', sourceTime: 8 }); // 5 + offset 3
  });

  it('trimPreview 為 null 時映射與現行逐位元組相同（pin 既有行為）', () => {
    const withNull = planAt(proj(), 3, null);
    const withoutArg = planAt(proj(), 3);
    expect(withNull).toEqual(withoutArg);
    expect(withNull.active).toMatchObject({ clipId: 'c1', sourceTime: 5 }); // in 2 + offset 3
  });

  it('override 的 clipId 不是目前 active clip：不受影響（非目標 clip 不套用）', () => {
    // t=7 時 active 是 c2（clipStart=6），override 卻指名 c1 —— 不該套用到 c2 身上
    const plan = planAt(proj(), 7, { clipId: 'c1', in: 99 });
    expect(plan.active).toMatchObject({ clipId: 'c2', sourceTime: 1 }); // c2 in 0 + offset 1，未受 c1 override 干擾
  });

  it('two successive trimPreview overrides at the same playhead time 產生不同的 source time', () => {
    // 控制器 pre-flight 點名的陷阱：seek 時間不變，只有 override in 變，映射也要跟著變。
    const first = planAt(proj(), 3, { clipId: 'c1', in: 4 });
    const second = planAt(proj(), 3, { clipId: 'c1', in: 6 });
    expect(first.active!.sourceTime).not.toBe(second.active!.sourceTime);
    expect(first.active!.sourceTime).toBe(7); // 4 + offset 3
    expect(second.active!.sourceTime).toBe(9); // 6 + offset 3
  });
});
