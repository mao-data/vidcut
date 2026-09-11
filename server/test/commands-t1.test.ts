import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { totalDuration, DEFAULT_CAPTION_STYLE } from '@vidcut/shared';
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

// ---- 多比例畫布：setCanvas ------------------------------------------------------
describe('setCanvas', () => {
  it('switches to a preset size', async () => {
    const store = await seeded();
    expect(store.doc.canvas).toMatchObject({ width: 1080, height: 1920 }); // 預設是 portrait
    const r = applyCommand(store, 'human', { name: 'setCanvas', width: 1920, height: 1080 });
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ changed: true });
    expect(store.doc.canvas).toMatchObject({ width: 1920, height: 1080 });
    expect(store.doc.canvas.fps).toBe(30); // 只動寬高,fps 不受影響
  });

  it('rejects a size that is not in the preset table, leaving the doc untouched', async () => {
    const store = await seeded();
    const before = store.version;
    const r = applyCommand(store, 'human', { name: 'setCanvas', width: 1000, height: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('1080×1920'); // 錯誤訊息要列出可用的 preset
    expect(store.doc.canvas).toMatchObject({ width: 1080, height: 1920 });
    expect(store.version).toBe(before);
  });

  it('is a no-op (no new version) when the size already matches', async () => {
    const store = await seeded();
    const before = store.version;
    const r = applyCommand(store, 'human', { name: 'setCanvas', width: 1080, height: 1920 });
    expect(r.ok).toBe(true);
    // 重點在「版本沒前進」：換畫布寬會讓每張字卡的 key 全變,重設成現值不該觸發全量重烤。
    expect(r).toMatchObject({ changed: false, version: before });
    expect(store.version).toBe(before);
  });

  it('undo restores the previous canvas size', async () => {
    const store = await seeded();
    expect(applyCommand(store, 'human', { name: 'setCanvas', width: 1080, height: 1080 }).ok).toBe(
      true,
    );
    expect(store.doc.canvas).toMatchObject({ width: 1080, height: 1080 });
    // 這條同時釘住 store.ts 的 isUndoable() 確實涵蓋 `canvas` 路徑
    //（setCanvas 沒有為了 undo 動過 store.ts,靠的就是那條既有規則）。
    expect(applyCommand(store, 'human', { name: 'undo' }).ok).toBe(true);
    expect(store.doc.canvas).toMatchObject({ width: 1080, height: 1920 });
  });

  // 字卡預算安全網。
  //
  // **這條線在四檔 preset 之間真的打得到**(不是只能測 cardRequestError 那層):
  // 50 個全形字 + fontSize 176,在 1080 寬估 50 行 × lineH 211 ≈ 11.4 Mpx(過),
  // 換到 1920 寬時貪婪換行的行數上界只降到 31 行,但寬度多了 78% → ≈ 12.6 Mpx(超過
  // 12 Mpx 上限)。成因是估算式的兩個上界在這一段換了主導者:1080 寬時「每字一行」的
  // 字元數上界比較緊、行數鎖死在 50,寬度變大時它不會再降,於是總像素被寬度拉上去。
  //
  // ⚠️ 這是**刻意構造的極端內容**(字級 176、一句 50 字),不是正常字幕會長的樣子——
  // 預設 fontSize 64 的字幕離上限差將近一個數量級。安全網存在是為了「拒絕得乾淨」,
  // 不是常見路徑,見 commands.ts 該 case 的註解。
  const HUGE_CAPTION_FONT_SIZE = 176;
  it('rejects the switch when an existing caption would blow the card budget at the new width', async () => {
    const store = await seeded();
    store.mutate('ai', 'seed captions', (d) => {
      d.tracks.captions = [
        {
          id: 'cap-huge',
          text: '字'.repeat(50),
          start: 0,
          duration: 2,
          style: { ...DEFAULT_CAPTION_STYLE, fontSize: HUGE_CAPTION_FONT_SIZE },
        },
        { id: 'cap-ok', text: '短句', start: 2, duration: 2, style: DEFAULT_CAPTION_STYLE },
      ];
    });
    const before = store.version;
    const r = applyCommand(store, 'human', { name: 'setCanvas', width: 1920, height: 1080 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('cap-huge'); // 要點名是哪一句
      expect(r.error).toContain('字字字'); // 帶上文字節錄
    }
    // 全有或全無:連 canvas 都不能動,否則會留下「畫布換了但這句永遠烤不出卡」的半殘狀態
    expect(store.doc.canvas).toMatchObject({ width: 1080, height: 1920 });
    expect(store.version).toBe(before);
  });

  it('rejects the switch when an existing text overlay would blow the card budget', async () => {
    const store = await seeded();
    store.mutate('ai', 'seed overlays', (d) => {
      d.tracks.overlays = [
        {
          id: 'ov-huge',
          imagePath: 'cards/whatever.png',
          start: 0,
          duration: 2,
          position: { x: 0.5, y: 0.3, scale: 1 },
          text: {
            text: '字'.repeat(50),
            fontFamily: 'PingFang TC',
            fontSize: HUGE_CAPTION_FONT_SIZE,
            fill: '#ffffff',
            stroke: '#000000',
          },
        },
      ];
    });
    const before = store.version;
    const r = applyCommand(store, 'human', { name: 'setCanvas', width: 1920, height: 1080 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ov-huge');
    expect(store.doc.canvas).toMatchObject({ width: 1080, height: 1920 });
    expect(store.version).toBe(before);
  });

  it('ignores pre-baked PNG overlays (no text = nothing to re-bake)', async () => {
    const store = await seeded();
    store.mutate('ai', 'seed overlays', (d) => {
      d.tracks.overlays = [
        {
          id: 'ov-png',
          imagePath: 'assets/logo.png',
          start: 0,
          duration: 2,
          position: { x: 0.5, y: 0.3, scale: 1 },
        },
      ];
    });
    expect(applyCommand(store, 'human', { name: 'setCanvas', width: 1920, height: 1080 }).ok).toBe(
      true,
    );
  });
});

// ---- Plan 14 Task 1：leadPad 前把手黑墊 ----------------------------------------
//
// 單一 clip、時間軸 0-6（duration 6），leadPad 2（黑墊 0-2，內容時間軸座標 2-6，
// 對應來源 in=3 → in+contentDur=3+4=7 ≤ srcDur=20）。

describe('leadPad 已移除（2026-09-11）：命令層不再接受、也不再落盤這個欄位', () => {
  it('updateClip 的 patch 帶 leadPad：執行期忽略，不落盤', async () => {
    const store = await seeded();
    const r = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'c1',
      // leadPad 已從 Command 型別移除（Task 8）；執行期也必須被忽略
      patch: { leadPad: 1 } as never,
    });
    expect(r.ok).toBe(true);
    expect(store.doc.tracks.video[0]).not.toHaveProperty('leadPad');
    expect(store.doc.tracks.video[0]).toMatchObject({ in: 0, duration: 4 });
  });

  it('updateClip：in+duration 超過來源長度被拒（不再有「內容長度」的減法）', async () => {
    const store = await seeded();
    const r = applyCommand(store, 'human', {
      name: 'updateClip',
      clipId: 'c1',
      patch: { in: 0, duration: 21 },
    });
    expect(r.ok).toBe(false);
    expect(String((r as { error: string }).error)).toMatch(/exceeds source/);
  });
});
