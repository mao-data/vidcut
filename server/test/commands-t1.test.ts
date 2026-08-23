import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { totalDuration } from '@vidcut/shared';
import { ProjectStore } from '../src/store.js';
import { applyCommand } from '../src/commands.js';
import { tmpDir } from './tmp.js';

/** 三段各 4 秒（來源各 20 秒）→ 時間軸 0-4 / 4-8 / 8-12。 */
async function seeded() {
  const dir = await tmpDir('vidcut-t1-');
  const store = await ProjectStore.load(join(dir, 'project.json'));
  store.mutate('ai', 'seed', (d) => {
    d.media = [
      {
        id: 'm1',
        path: 'a.mp4',
        probe: { duration: 20, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
      },
      {
        id: 'mute',
        path: 'b.mp4',
        probe: { duration: 20, width: 540, height: 960, fps: 30, hasAudio: false, rotation: 0 },
      },
    ];
    d.tracks.video = [
      { id: 'c1', mediaId: 'm1', in: 0, duration: 4, volume: 1, label: 'A' },
      { id: 'c2', mediaId: 'm1', in: 5, duration: 4, volume: 1, label: 'B' },
      { id: 'c3', mediaId: 'mute', in: 0, duration: 4, volume: 1, label: 'C' },
    ];
  });
  return store;
}

describe('splitAt', () => {
  it('splits the clip containing the playhead into two', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'splitAt', time: 5.5 }).ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v).toHaveLength(4);
    // c2 (時間軸 4-8, in=5) 在 offset 1.5 被切開
    expect(v[1]).toMatchObject({ id: 'c2', in: 5, duration: 1.5 });
    expect(v[2]).toMatchObject({ mediaId: 'm1', in: 6.5, duration: 2.5 });
    expect(totalDuration(store.doc)).toBeCloseTo(12); // 總長不變
  });

  it('rejects split too close to an edge or out of range', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'splitAt', time: 4.02 }).ok).toBe(false);
    expect(applyCommand(store, 'human', { name: 'splitAt', time: 99 }).ok).toBe(false);
    expect(applyCommand(store, 'human', { name: 'splitAt', time: -1 }).ok).toBe(false);
    expect(store.doc.tracks.video).toHaveLength(3);
  });
});

describe('deleteBefore / deleteAfter', () => {
  it('deleteBefore drops earlier clips and trims the straddling one', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'deleteBefore', time: 5 }).ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v).toHaveLength(2);
    // c1 全丟；c2 前 1 秒被切（in 5→6, 4→3s）
    expect(v[0]).toMatchObject({ id: 'c2', in: 6, duration: 3 });
    expect(v[1]!.id).toBe('c3');
    expect(totalDuration(store.doc)).toBeCloseTo(7);
  });

  it('deleteAfter drops later clips and trims the straddling one', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'deleteAfter', time: 6 }).ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ id: 'c1', duration: 4 });
    expect(v[1]).toMatchObject({ id: 'c2', in: 5, duration: 2 });
    expect(totalDuration(store.doc)).toBeCloseTo(6);
  });

  it('refuses to delete everything', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'deleteBefore', time: 0 }).ok).toBe(false);
    expect(applyCommand(store, 'human', { name: 'deleteAfter', time: 0 }).ok).toBe(false);
    expect(applyCommand(store, 'human', { name: 'deleteBefore', time: 12 }).ok).toBe(false);
    expect(store.doc.tracks.video).toHaveLength(3);
  });
});

describe('freezeFrame', () => {
  it('splits and inserts a frozen clip in the middle', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'freezeFrame', time: 2, duration: 1.5 }).ok).toBe(
      true,
    );
    const v = store.doc.tracks.video;
    // c1 被切成兩段 + 中間插一段定格 = 原本 3 段變 5 段
    expect(v).toHaveLength(5);
    expect(v[0]).toMatchObject({ id: 'c1', duration: 2 });
    expect(v[1]).toMatchObject({ frozen: true, in: 2, duration: 1.5, volume: 0 });
    expect(v[2]).toMatchObject({ in: 2, duration: 2 }); // c1 的後半
    expect(v[3]!.id).toBe('c2');
    expect(totalDuration(store.doc)).toBeCloseTo(13.5); // 12 + 1.5
  });

  it('inserts before the clip when the playhead sits on its start', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'freezeFrame', time: 4 }).ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v).toHaveLength(4);
    expect(v[1]).toMatchObject({ frozen: true, in: 5, duration: 3 }); // 預設 3 秒
    expect(v[2]!.id).toBe('c2');
  });

  it('rejects a too-short freeze', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'freezeFrame', time: 2, duration: 0.01 }).ok).toBe(
      false,
    );
  });
});

describe('extractAudio', () => {
  it('creates an absolute-time audio item and mutes the clip', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'extractAudio', clipId: 'c2' }).ok).toBe(true);
    const a = store.doc.tracks.audio;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ mediaId: 'm1', start: 4, in: 5, duration: 4, volume: 1 });
    expect(store.doc.tracks.video[1]!.volume).toBe(0);
  });

  it('rejects clips whose source has no audio', async () => {
    const store = await seeded();
    const r = applyCommand(store, 'human', { name: 'extractAudio', clipId: 'c3' });
    expect(r).toMatchObject({ ok: false });
    expect(store.doc.tracks.audio).toHaveLength(0);
  });
});

describe('audio item editing', () => {
  it('updates volume/fades and validates bounds', async () => {
    const store = await seeded();
    applyCommand(store, 'human', { name: 'extractAudio', clipId: 'c1' });
    const id = store.doc.tracks.audio[0]!.id;

    expect(
      applyCommand(store, 'human', {
        name: 'updateAudio',
        id,
        patch: { volume: 0.4, fadeIn: 0.5, fadeOut: 1 },
      }).ok,
    ).toBe(true);
    expect(store.doc.tracks.audio[0]).toMatchObject({ volume: 0.4, fadeIn: 0.5, fadeOut: 1 });

    // fade 超過長度、in+duration 超出來源、音量越界 → 全部拒絕
    expect(
      applyCommand(store, 'human', { name: 'updateAudio', id, patch: { fadeIn: 99 } }).ok,
    ).toBe(false);
    expect(
      applyCommand(store, 'human', { name: 'updateAudio', id, patch: { in: 19, duration: 5 } }).ok,
    ).toBe(false);
    expect(applyCommand(store, 'human', { name: 'updateAudio', id, patch: { volume: 3 } }).ok).toBe(
      false,
    );
  });

  it('removes an audio item', async () => {
    const store = await seeded();
    applyCommand(store, 'human', { name: 'extractAudio', clipId: 'c1' });
    const id = store.doc.tracks.audio[0]!.id;
    expect(applyCommand(store, 'human', { name: 'removeAudio', id }).ok).toBe(true);
    expect(store.doc.tracks.audio).toHaveLength(0);
    expect(applyCommand(store, 'human', { name: 'removeAudio', id: 'nope' }).ok).toBe(false);
  });
});

describe('setCanvasFit', () => {
  it('switches between contain and blur', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'setCanvasFit', fit: 'blur' }).ok).toBe(true);
    expect(store.doc.canvas.fit).toBe('blur');
    applyCommand(store, 'human', { name: 'setCanvasFit', fit: 'contain' });
    expect(store.doc.canvas.fit).toBe('contain');
  });
});

// ---- Plan 14 Task 1：leadPad 前把手黑墊 ----------------------------------------
//
// 單一 clip、時間軸 0-6（duration 6），leadPad 2（黑墊 0-2，內容時間軸座標 2-6，
// 對應來源 in=3 → in+contentDur=3+4=7 ≤ srcDur=20）。
async function seededWithPad() {
  const dir = await tmpDir('vidcut-leadpad-');
  const store = await ProjectStore.load(join(dir, 'project.json'));
  store.mutate('ai', 'seed', (d) => {
    d.media = [
      {
        id: 'm1',
        path: 'a.mp4',
        probe: { duration: 20, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
      },
    ];
    d.tracks.video = [
      { id: 'p1', mediaId: 'm1', in: 3, duration: 6, leadPad: 2, volume: 1, label: 'Padded' },
    ];
  });
  return store;
}

describe('updateClip：leadPad 邊界（Plan 14 Task 1）', () => {
  it('合法的黑墊調整通過', async () => {
    const store = await seededWithPad();
    const r = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'p1',
      patch: { leadPad: 1 },
    });
    expect(r.ok).toBe(true);
    expect(store.doc.tracks.video[0]).toMatchObject({ leadPad: 1, duration: 6, in: 3 });
  });

  it('負的 leadPad 被拒絕', async () => {
    const store = await seededWithPad();
    const r = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'p1',
      patch: { leadPad: -1 },
    });
    expect(r.ok).toBe(false);
  });

  it('黑墊撐到內容長度 < MIN_CLIP_DURATION 被拒絕（duration 不變，leadPad 太大）', async () => {
    const store = await seededWithPad();
    // duration=6, leadPad=5.95 → 內容長度 0.05 < 0.1
    const r = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'p1',
      patch: { leadPad: 5.95 },
    });
    expect(r.ok).toBe(false);
    expect(store.doc.tracks.video[0]!.leadPad).toBe(2); // 未變
  });

  // 等號側邊界（Plan 14 Task 1 review round 1 minor）：`nextContentDur < MIN_CLIP_DURATION`
  // 用嚴格 `<`，內容長度「恰好貼齊 0.1」應該通過，差一格（下一個可表示浮點數）就該拒絕。
  // ⚠️ 0.1 這種十進位小數在 IEEE754 底下沒有精確表示：`duration=6` 時，任何 `leadPad`
  // 都無法讓 `6 - leadPad` 位元組級等於 `0.1` 這個字面值（`6-5.9` 實際是
  // 0.09999999999999964，`6-5.899999999999999` 是 0.10000000000000142，中間沒有任何
  // 可表示的浮點數落在兩者之間）——所以這裡測的是「兩個相鄰浮點數剛好跨過 0.1 這條線」，
  // 這是浮點數底下能做到最貼近「恰好等於」的邊界測試，比手打一個湊出來的十進位常數更
  // 貼近程式碼實際比較的那個值。
  it('內容長度貼齊 MIN_CLIP_DURATION（相鄰浮點數跨界）：剛好夠的通過，差一格的拒絕', async () => {
    const store = await seededWithPad(); // duration=6
    // leadPad=5.899999999999999 → 內容長度 0.10000000000000142（> 0.1，應通過）
    const rOk = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'p1',
      patch: { leadPad: 5.899999999999999 },
    });
    expect(rOk.ok).toBe(true);
    expect(store.doc.tracks.video[0]!.leadPad).toBe(5.899999999999999);

    // leadPad=5.9（只差一個可表示的浮點數）→ 內容長度 0.09999999999999964（< 0.1，應拒絕）
    const rReject = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'p1',
      patch: { leadPad: 5.9 },
    });
    expect(rReject.ok).toBe(false);
    expect(store.doc.tracks.video[0]!.leadPad).toBe(5.899999999999999); // 未變
  });

  it('用「內容」長度（不是時間軸長度）算來源邊界：黑墊夠大時原本會超界的 duration 反而合法', async () => {
    const store = await seededWithPad();
    // in=3, srcDur=20 → 內容長度上限 17。duration=25、leadPad=10 → 內容長度 15 ≤ 17，合法。
    // 若沿用舊式子 in+duration<=srcDur（3+25=28>20）會被誤拒——這正是本任務要修的分支。
    const r = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'p1',
      patch: { duration: 25, leadPad: 10 },
    });
    expect(r.ok).toBe(true);
    expect(store.doc.tracks.video[0]).toMatchObject({ duration: 25, leadPad: 10 });
  });

  it('內容長度超出來源長度仍被拒絕', async () => {
    const store = await seededWithPad();
    // in=3, srcDur=20 → 內容長度上限 17。duration=20, leadPad=1 → 內容長度 19 > 17。
    const r = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'p1',
      patch: { duration: 20, leadPad: 1 },
    });
    expect(r.ok).toBe(false);
  });

  it('無 leadPad 的既有專案：updateClip 行為不變（回歸釘）', async () => {
    const store = await seeded(); // c1: in=0, duration=4, 無 leadPad
    const r1 = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'c1',
      patch: { duration: 6 },
    });
    expect(r1.ok).toBe(true);
    expect(store.doc.tracks.video[0]!.leadPad).toBeUndefined();
    // 超出來源長度仍照舊被拒（沒有 leadPad 時 nextContentDur === nextDur）
    const r2 = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'c1',
      patch: { in: 18, duration: 5 },
    });
    expect(r2.ok).toBe(false);
  });

  // 終審 Info-1：顯式送 leadPad:0（例如 UI 的 trim-out、或吸附回 0 的 trim-in）不該
  // 在 project.json 落盤成顯式 `"leadPad": 0`——收斂到 addClip/setTimeline/splitAt/
  // deleteBefore 共用的省略式慣例：>0 才寫鍵，否則整個鍵消失。
  it('顯式送 leadPad:0：清除既有黑墊，落盤後鍵完全消失（不是留下 leadPad:0）', async () => {
    const store = await seededWithPad(); // p1 現有 leadPad=2
    const r = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'p1',
      patch: { leadPad: 0 },
    });
    expect(r.ok).toBe(true);
    const c = store.doc.tracks.video[0]!;
    expect(c.leadPad).toBeUndefined();
    expect(Object.hasOwn(c, 'leadPad')).toBe(false);
  });

  it('本來沒有 leadPad 的 clip 送 leadPad:0：仍然不落盤這個鍵（no-op 之於形狀）', async () => {
    const store = await seeded(); // c1 無 leadPad
    const r = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'c1',
      patch: { leadPad: 0 },
    });
    expect(r.ok).toBe(true);
    const c = store.doc.tracks.video[0]!;
    expect(Object.hasOwn(c, 'leadPad')).toBe(false);
  });

  it('送正的 leadPad 仍正常落盤（回歸：省略式改動不影響 >0 的既有路徑）', async () => {
    const store = await seeded(); // c1 無 leadPad
    const r = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'c1',
      patch: { leadPad: 1.5 },
    });
    expect(r.ok).toBe(true);
    expect(store.doc.tracks.video[0]!.leadPad).toBe(1.5);
  });

  it('省略式落盤不影響 undo/redo 可逆性：送 0 清除黑墊可 undo 回舊值、redo 回清除後狀態', async () => {
    const store = await seededWithPad(); // p1 現有 leadPad=2
    const r = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'p1',
      patch: { leadPad: 0 },
    });
    expect(r.ok).toBe(true);
    expect(Object.hasOwn(store.doc.tracks.video[0]!, 'leadPad')).toBe(false);

    expect(store.undo('human')).not.toBeNull();
    expect(store.doc.tracks.video[0]!.leadPad).toBe(2); // 還原成刪鍵之前的值

    expect(store.redo('human')).not.toBeNull();
    expect(Object.hasOwn(store.doc.tracks.video[0]!, 'leadPad')).toBe(false); // 鍵再次消失
  });
});

describe('addClip：leadPad（Plan 14 Task 1）', () => {
  async function storeWithMedia() {
    const dir = await tmpDir('vidcut-leadpad-add-');
    const store = await ProjectStore.load(join(dir, 'project.json'));
    store.mutate('ai', 'seed', (d) => {
      d.media = [
        {
          id: 'm1',
          path: 'a.mp4',
          probe: { duration: 20, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
    });
    return store;
  }

  it('帶 leadPad 且合法：內容長度守邊界', async () => {
    const store = await storeWithMedia();
    const r = applyCommand(store, 'human', {
      name: 'addClip',
      mediaId: 'm1',
      in: 0,
      duration: 6,
      leadPad: 2,
    });
    expect(r.ok).toBe(true);
    expect(store.doc.tracks.video[0]).toMatchObject({ duration: 6, leadPad: 2 });
  });

  it('leadPad 撐到內容過短被拒絕', async () => {
    const store = await storeWithMedia();
    const r = applyCommand(store, 'human', {
      name: 'addClip',
      mediaId: 'm1',
      in: 0,
      duration: 6,
      leadPad: 5.95,
    });
    expect(r.ok).toBe(false);
    expect(store.doc.tracks.video).toHaveLength(0);
  });

  it('負的 leadPad 被拒絕', async () => {
    const store = await storeWithMedia();
    const r = applyCommand(store, 'human', {
      name: 'addClip',
      mediaId: 'm1',
      in: 0,
      duration: 6,
      leadPad: -1,
    });
    expect(r.ok).toBe(false);
  });

  it('不帶 leadPad：既有行為不變（回歸釘），文件裡沒有這個鍵', async () => {
    const store = await storeWithMedia();
    const r = applyCommand(store, 'human', { name: 'addClip', mediaId: 'm1', in: 0, duration: 5 });
    expect(r.ok).toBe(true);
    expect(store.doc.tracks.video[0]!.leadPad).toBeUndefined();
    expect(Object.hasOwn(store.doc.tracks.video[0]!, 'leadPad')).toBe(false);
  });

  // gauntlet fix：舊守門 `cmd.duration <= 0` 已刪（冗餘，被下面這條內容長下限完全
  // 涵蓋）。這裡專門釘「in 合法、無 leadPad、duration 是正數但過短」——不靠 duration=0
  // 這種同時也會撞上其他條件的邊界值，判別性地確認內容長下限本身在擋，而不是某個
  // 剛好同時成立的別的守門。
  it('無 leadPad、duration=0.05（正數但 < MIN_CLIP_DURATION）：被內容長下限拒絕', async () => {
    const store = await storeWithMedia();
    const r = applyCommand(store, 'human', {
      name: 'addClip',
      mediaId: 'm1',
      in: 3,
      duration: 0.05,
    });
    expect(r.ok).toBe(false);
    expect(store.doc.tracks.video).toHaveLength(0);
  });
});

describe('setTimeline：leadPad pass-through 與「沒帶＝0」語意（Plan 14 Task 1）', () => {
  async function storeWithMedia() {
    const dir = await tmpDir('vidcut-leadpad-settl-');
    const store = await ProjectStore.load(join(dir, 'project.json'));
    store.mutate('ai', 'seed', (d) => {
      d.media = [
        {
          id: 'm1',
          path: 'a.mp4',
          probe: { duration: 20, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
      d.tracks.video = [{ id: 'old', mediaId: 'm1', in: 0, duration: 4, leadPad: 3, volume: 1 }];
    });
    return store;
  }

  it('帶 leadPad 的 spec 通過驗證並落盤', async () => {
    const store = await storeWithMedia();
    const r = applyCommand(store, 'human', {
      name: 'setTimeline',
      clips: [{ id: 'old', mediaId: 'm1', in: 0, duration: 6, leadPad: 2 }],
    });
    expect(r.ok).toBe(true);
    expect(store.doc.tracks.video[0]).toMatchObject({ duration: 6, leadPad: 2 });
  });

  it('整組替換：spec 沒帶 leadPad 就是 0，不沿用舊值（同 id 也一樣）', async () => {
    const store = await storeWithMedia(); // old 目前 leadPad=3
    const r = applyCommand(store, 'human', {
      name: 'setTimeline',
      clips: [{ id: 'old', mediaId: 'm1', in: 0, duration: 4 }], // 沒帶 leadPad
    });
    expect(r.ok).toBe(true);
    expect(store.doc.tracks.video[0]!.leadPad).toBeUndefined(); // 不是 3
  });

  it('leadPad 撐到內容過短被拒絕，整批不落盤', async () => {
    const store = await storeWithMedia();
    const r = applyCommand(store, 'human', {
      name: 'setTimeline',
      clips: [{ id: 'old', mediaId: 'm1', in: 0, duration: 6, leadPad: 5.95 }],
    });
    expect(r.ok).toBe(false);
    expect(store.doc.tracks.video[0]!.leadPad).toBe(3); // 未變
  });

  it('負的 leadPad 被拒絕', async () => {
    const store = await storeWithMedia();
    const r = applyCommand(store, 'human', {
      name: 'setTimeline',
      clips: [{ id: 'old', mediaId: 'm1', in: 0, duration: 4, leadPad: -1 }],
    });
    expect(r.ok).toBe(false);
  });
});

describe('splitAt：黑墊（Plan 14 Task 1）', () => {
  it('分割點落在黑墊內被拒絕，措辭指明 black lead', async () => {
    const store = await seededWithPad(); // p1: 時間軸 0-6，黑墊 0-2
    const r = applyCommand(store, 'human', { name: 'splitAt', time: 1 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/inside the black lead/);
    expect(store.doc.tracks.video).toHaveLength(1);
  });

  it('分割點恰好在黑墊邊界之後（offset = leadPad + MIN 起）合法：左半保留黑墊，右半清 0', async () => {
    const store = await seededWithPad(); // p1: in=3, duration=6, leadPad=2
    const r = applyCommand(store, 'human', { name: 'splitAt', time: 3 }); // offset=3
    expect(r.ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ id: 'p1', in: 3, leadPad: 2, duration: 3 });
    // 右半：offset - leadPad = 3-2 = 1 → in = 3+1 = 4；duration = 6-3 = 3；leadPad 清 0
    expect(v[1]).toMatchObject({ mediaId: 'm1', in: 4, duration: 3 });
    expect(v[1]!.leadPad).toBeUndefined();
  });

  // 等號側邊界（Plan 14 Task 2 brief 指名的 minor）：`left < pad + MIN_CLIP_DURATION` 用
  // 嚴格 `<`，offset 恰好 = leadPad + MIN（2 + 0.1 = 2.1）應該通過，差一點點（2.1 之下）
  // 才落在「黑墊內」被拒絕。
  it('分割點 offset 恰好 = leadPad + MIN（2.1）通過；差一點點（2.09…）落在黑墊內被拒絕', async () => {
    const store = await seededWithPad(); // p1: in=3, duration=6, leadPad=2
    const rOk = applyCommand(store, 'human', { name: 'splitAt', time: 2.1 }); // offset=2.1
    expect(rOk.ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ id: 'p1', in: 3, leadPad: 2, duration: 2.1 });
    // 右半：offset - leadPad = 2.1-2 = 0.1 → in = 3+0.1 = 3.1；duration = 6-2.1 = 3.9
    expect(v[1]).toMatchObject({ mediaId: 'm1', in: 3.1, duration: 3.9 });
    expect(v[1]!.leadPad).toBeUndefined();
  });

  it('分割點 offset 差一點點未達邊界（2.09999）仍落在黑墊內被拒絕', async () => {
    const store = await seededWithPad();
    const r = applyCommand(store, 'human', { name: 'splitAt', time: 2.09999 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/inside the black lead/);
    expect(store.doc.tracks.video).toHaveLength(1);
  });

  it('分割點在內容內部（不靠黑墊邊界）：正常分割，右半沒有黑墊', async () => {
    const store = await seededWithPad();
    const r = applyCommand(store, 'human', { name: 'splitAt', time: 5 }); // offset=5
    expect(r.ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v[0]).toMatchObject({ in: 3, leadPad: 2, duration: 5 });
    expect(v[1]).toMatchObject({ in: 6, duration: 1 }); // offset-leadPad=3 → in=3+3=6
    expect(v[1]!.leadPad).toBeUndefined();
  });

  it('無 leadPad 的既有專案：splitAt 行為不變（回歸釘）', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'splitAt', time: 5.5 }).ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v[1]).toMatchObject({ id: 'c2', in: 5, duration: 1.5 });
    expect(v[2]).toMatchObject({ mediaId: 'm1', in: 6.5, duration: 2.5 });
    expect(v[1]!.leadPad).toBeUndefined();
    expect(v[2]!.leadPad).toBeUndefined();
  });
});

describe('deleteBefore：黑墊切點（Plan 14 Task 1）', () => {
  it('切點落在黑墊內：只削黑墊，內容不動', async () => {
    const store = await seededWithPad(); // p1: 時間軸 0-6，黑墊 0-2，in=3
    const r = applyCommand(store, 'human', { name: 'deleteBefore', time: 1 }); // cut=1 < pad=2
    expect(r.ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v).toHaveLength(1);
    // leadPad: 2-1=1；duration: 6-1=5；in 不變（內容完全不動）
    expect(v[0]).toMatchObject({ id: 'p1', in: 3, leadPad: 1, duration: 5 });
  });

  it('切點恰好落在黑墊/內容交界（cut === pad）：走內容分支，leadPad 清 0', async () => {
    const store = await seededWithPad(); // pad=2
    const r = applyCommand(store, 'human', { name: 'deleteBefore', time: 2 }); // cut=2 === pad
    expect(r.ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v[0]!.leadPad).toBeUndefined();
    expect(v[0]).toMatchObject({ in: 3, duration: 4 }); // clipSourceTime(2)=3+0=3
  });

  it('切點落在內容內：黑墊整段被切掉，來源起點用 clipSourceTime 映射', async () => {
    const store = await seededWithPad(); // in=3, leadPad=2, duration=6
    const r = applyCommand(store, 'human', { name: 'deleteBefore', time: 4 }); // cut=4
    expect(r.ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v[0]!.leadPad).toBeUndefined();
    // clipSourceTime(4) = 3 + (4-2) = 5；duration = 6-4 = 2
    expect(v[0]).toMatchObject({ in: 5, duration: 2 });
  });

  it('切在內容內、殘餘內容 < MIN：整支刪除', async () => {
    const store = await seededWithPad(); // duration=6
    const r = applyCommand(store, 'human', { name: 'deleteBefore', time: 5.95 }); // rest=0.05<MIN
    expect(r.ok).toBe(false); // 唯一片段被砍光 → would delete everything
  });

  it('無 leadPad 的既有專案：deleteBefore 行為不變（回歸釘）', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'deleteBefore', time: 5 }).ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v[0]).toMatchObject({ id: 'c2', in: 6, duration: 3 });
    expect(v[0]!.leadPad).toBeUndefined();
    expect(v[1]!.id).toBe('c3');
  });
});

describe('deleteAfter：黑墊切點（Plan 14 Task 1）', () => {
  it('切點落在黑墊內：左半純黑墊，整支刪除', async () => {
    const store = await seededWithPad(); // 黑墊 0-2
    const r = applyCommand(store, 'human', { name: 'deleteAfter', time: 1 }); // rest=1<=pad=2
    expect(r.ok).toBe(false); // 唯一片段被砍光
  });

  it('切點恰好等於 leadPad（rest === pad）：仍是純黑墊，整支刪除', async () => {
    const store = await seededWithPad();
    const r = applyCommand(store, 'human', { name: 'deleteAfter', time: 2 }); // rest=2===pad
    expect(r.ok).toBe(false);
  });

  it('切點落在內容內：duration 截斷，leadPad 保留', async () => {
    const store = await seededWithPad(); // leadPad=2, duration=6
    const r = applyCommand(store, 'human', { name: 'deleteAfter', time: 4 }); // rest=4, contentRest=2
    expect(r.ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ id: 'p1', in: 3, leadPad: 2, duration: 4 });
  });

  it('切在內容內、殘餘內容 < MIN：整支刪除', async () => {
    const store = await seededWithPad(); // leadPad=2
    // rest=2.05 → contentRest=0.05 < MIN
    const r = applyCommand(store, 'human', { name: 'deleteAfter', time: 2.05 });
    expect(r.ok).toBe(false);
  });

  it('無 leadPad 的既有專案：deleteAfter 行為不變（回歸釘）', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'deleteAfter', time: 6 }).ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v[0]).toMatchObject({ id: 'c1', duration: 4 });
    expect(v[1]).toMatchObject({ id: 'c2', in: 5, duration: 2 });
    expect(v[0]!.leadPad).toBeUndefined();
  });
});

describe('freezeFrame：黑墊（Plan 14 Task 1）', () => {
  it('time 落在黑墊內被拒絕', async () => {
    const store = await seededWithPad(); // 黑墊 0-2
    const r = applyCommand(store, 'human', { name: 'freezeFrame', time: 1, duration: 1 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/inside the black lead/);
    expect(store.doc.tracks.video).toHaveLength(1);
  });

  it('time 落在內容內：正常插入定格，來源時間用 clipSourceTime 映射', async () => {
    const store = await seededWithPad(); // in=3, leadPad=2
    const r = applyCommand(store, 'human', { name: 'freezeFrame', time: 4, duration: 1 }); // offset=4
    expect(r.ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v).toHaveLength(3);
    // clipSourceTime(4) = 3 + (4-2) = 5
    expect(v[1]).toMatchObject({ frozen: true, in: 5, duration: 1 });
    expect(v[0]).toMatchObject({ id: 'p1', leadPad: 2, duration: 4 }); // 前半保留黑墊
    expect(v[2]!.leadPad).toBeUndefined(); // 後半清 0
  });

  it('無 leadPad 的既有專案：freezeFrame 行為不變（回歸釘）', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'freezeFrame', time: 2, duration: 1.5 }).ok).toBe(
      true,
    );
    const v = store.doc.tracks.video;
    expect(v[1]).toMatchObject({ frozen: true, in: 2, duration: 1.5, volume: 0 });
    expect(v[2]).toMatchObject({ in: 2, duration: 2 });
    expect(v[2]!.leadPad).toBeUndefined();
  });

  // 終審 Important-1：中段分支曾經沒守左半內容長下限——time 落在 [pad, pad+MIN) 時
  // `atSource !== null`（守門放行），但左半內容長 < MIN_CLIP_DURATION（甚至 0），
  // 產生一支之後任何 updateClip 都會被擋下的死 clip。三個等號邊界都要釘住。
  it('time 恰好在黑墊邊界（offset === pad）：內容長 0，不能落在中段分支，插在片段前面且不切原片段', async () => {
    const store = await seededWithPad(); // p1: in=3, duration=6, leadPad=2
    const r = applyCommand(store, 'human', { name: 'freezeFrame', time: 2, duration: 1 });
    expect(r.ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ frozen: true, in: 3, duration: 1 }); // atSource=clipSourceTime(2)=3
    // 原片段完整保留（沒有被切成內容長 0 的死 clip）
    expect(v[1]).toMatchObject({ id: 'p1', in: 3, leadPad: 2, duration: 6 });
  });

  it('time 落在 (pad, pad+MIN) 區間（offset=2.05）：內容長 0.05 < MIN，仍插在片段前面而非中段切割', async () => {
    const store = await seededWithPad(); // p1: in=3, duration=6, leadPad=2
    const r = applyCommand(store, 'human', { name: 'freezeFrame', time: 2.05, duration: 1 });
    expect(r.ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ frozen: true, duration: 1 });
    // 原片段完整保留，沒有被切出一支內容長 0.05s（< MIN_CLIP_DURATION）的死 clip
    expect(v[1]).toMatchObject({ id: 'p1', in: 3, leadPad: 2, duration: 6 });
  });

  it('time 恰好 = pad + MIN（offset=2.1）：內容長剛好等於 MIN，通過並正常中段切割', async () => {
    const store = await seededWithPad(); // p1: in=3, duration=6, leadPad=2
    const r = applyCommand(store, 'human', { name: 'freezeFrame', time: 2.1, duration: 1 });
    expect(r.ok).toBe(true);
    const v = store.doc.tracks.video;
    // 中段分支：原片段被切成兩段 + 定格插在中間 = 3 段
    expect(v).toHaveLength(3);
    expect(v[0]).toMatchObject({ id: 'p1', in: 3, leadPad: 2, duration: 2.1 }); // 左半內容長=0.1=MIN
    expect(v[1]).toMatchObject({ frozen: true, duration: 1 });
    expect(v[2]!.leadPad).toBeUndefined(); // 右半清 0
  });

  it('回歸：offset=4（原本就綠的深在內容內 case）仍走中段分支、行為不變', async () => {
    const store = await seededWithPad(); // in=3, leadPad=2
    const r = applyCommand(store, 'human', { name: 'freezeFrame', time: 4, duration: 1 });
    expect(r.ok).toBe(true);
    const v = store.doc.tracks.video;
    expect(v).toHaveLength(3);
    expect(v[0]).toMatchObject({ id: 'p1', leadPad: 2, duration: 4 });
    expect(v[1]).toMatchObject({ frozen: true, in: 5, duration: 1 });
    expect(v[2]!.leadPad).toBeUndefined();
  });
});

describe('extractAudio：黑墊映射（Plan 14 Task 1）', () => {
  it('start 往後移 leadPad、duration 用內容長度', async () => {
    const store = await seededWithPad(); // p1: 時間軸 0-6，in=3，leadPad=2，duration=6
    const r = applyCommand(store, 'human', { name: 'extractAudio', clipId: 'p1' });
    expect(r.ok).toBe(true);
    const a = store.doc.tracks.audio;
    expect(a).toHaveLength(1);
    // clipStart=0, pad=2 → start=2；in=3（clip.in 原樣）；duration=6-2=4（內容長度）
    expect(a[0]).toMatchObject({ mediaId: 'm1', start: 2, in: 3, duration: 4 });
    expect(store.doc.tracks.video[0]!.volume).toBe(0);
  });

  it('無 leadPad 的既有專案：extractAudio 行為不變（回歸釘）', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'extractAudio', clipId: 'c2' }).ok).toBe(true);
    const a = store.doc.tracks.audio;
    expect(a[0]).toMatchObject({ mediaId: 'm1', start: 4, in: 5, duration: 4 });
  });
});
