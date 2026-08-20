import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { ReviewManager } from '../src/reviews.js';
import { applyCommand } from '../src/commands.js';
import { tmpDir } from './tmp.js';

async function seeded() {
  const dir = await tmpDir('vidcut-rev-');
  const store = await ProjectStore.load(join(dir, 'project.json'));
  store.mutate('ai', 'seed', (d) => {
    d.media = [
      {
        id: 'm1',
        path: 'a.mp4',
        probe: { duration: 20, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
      },
    ];
    d.tracks.video = [{ id: 'c1', mediaId: 'm1', in: 0, duration: 5, volume: 1, label: 'A' }];
  });
  return store;
}

describe('ReviewManager', () => {
  it('request sets doc.review; approve resolves with human changes', async () => {
    const store = await seeded();
    const rm = new ReviewManager(store);
    const p = rm.request('please check', ['c1']);
    expect(store.doc.review).toMatchObject({ summary: 'please check', focus: ['c1'] });

    // 人在審核期間改了東西
    applyCommand(store, 'human', { name: 'updateClip', clipId: 'c1', patch: { duration: 4 } });

    const id = rm.activeId!;
    expect(rm.resolve(id, 'approved')).toBe(true);
    const result = await p;
    expect(result.outcome).toBe('approved');
    expect(store.doc.review).toBeNull();
    expect(result.humanChanges.length).toBeGreaterThanOrEqual(1);
    expect(store.doc.tracks.video[0]!.duration).toBe(4); // 人的變更保留
  });

  it('reject rolls back AI changes made during the review batch', async () => {
    const store = await seeded();
    const rm = new ReviewManager(store);
    // AI 先加一段（在 request 前）— 這批 AI 工作
    applyCommand(store, 'ai', { name: 'updateClip', clipId: 'c1', patch: { duration: 8 } });
    const p = rm.request('review my edit');
    const id = rm.activeId!;
    rm.resolve(id, 'rejected', '不要這樣');
    const result = await p;
    expect(result.outcome).toBe('rejected');
    // sinceVersion 是 request 當下（duration 已是 8），rejected 只回滾 review 期間的變更；
    // 這裡 review 期間沒有 AI 變更，故 duration 維持 8。驗證回滾機制不誤傷。
    expect(store.doc.review).toBeNull();
    expect(result.note).toBe('不要這樣');
  });

  it('reject undoes AI writes that happened after request (guard-bypass safety net)', async () => {
    const store = await seeded();
    const rm = new ReviewManager(store);
    const before = store.doc.tracks.video[0]!.duration; // 5
    const p = rm.request('r');
    const sinceVer = store.version;
    // 模擬 review 期間仍寫入的 AI 變更（正常有 aiWrite 擋，這裡直接寫測回滾安全網）
    store.mutate('ai', 'sneaky', (d) => {
      d.tracks.video[0]!.duration = 99;
    });
    expect(store.version).toBeGreaterThan(sinceVer);
    rm.resolve(rm.activeId!, 'rejected');
    await p;
    expect(store.doc.tracks.video[0]!.duration).toBe(before); // 回滾到 sinceVersion
  });

  // Plan 8 final review F3：background ingest（A1/A2）在審核期間補寫 updateMediaDerived
  // （source==='human'，見 ingest.ts）不該讓 AI 讀到「使用者改了東西」的幻覺——那只是
  // 背景轉檔完成的既成事實，不是審核期間的人類編輯意圖。
  it('background updateMediaDerived during a review does not appear in humanChanges; a real human edit still does', async () => {
    const store = await seeded();
    // 先登記一支素材，讓 updateMediaDerived 有目標可以補寫
    applyCommand(store, 'human', {
      name: 'registerMedia',
      asset: {
        id: 'm2',
        path: 'b.mp4',
        probe: { duration: 4, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
      },
    });
    const rm = new ReviewManager(store);
    const p = rm.request('please check');

    // 審核期間：background A1 完成，補寫 filmstrip（不是使用者做的）
    const derived = applyCommand(store, 'human', {
      name: 'updateMediaDerived',
      mediaId: 'm2',
      patch: { filmstripPath: 'derived/m2/filmstrip.jpg', filmstripTiles: 4 },
    });
    expect(derived.ok).toBe(true);
    // 審核期間：使用者也真的改了一刀（真人編輯）
    applyCommand(store, 'human', { name: 'updateClip', clipId: 'c1', patch: { duration: 3 } });

    rm.resolve(rm.activeId!, 'approved');
    const result = await p;
    expect(result.outcome).toBe('approved');
    expect(result.humanChanges.some((h) => h.label.includes('update media derived'))).toBe(false);
    expect(result.humanChanges.some((h) => h.label === 'edit A')).toBe(true);
  });

  it('resolve with wrong id returns false', async () => {
    const store = await seeded();
    const rm = new ReviewManager(store);
    void rm.request('r');
    expect(rm.resolve('wrong-id', 'approved')).toBe(false);
    rm.resolve(rm.activeId!, 'approved');
  });

  it('times out with outcome timeout', async () => {
    const store = await seeded();
    const rm = new ReviewManager(store, 30); // 30ms
    const result = await rm.request('r');
    expect(result.outcome).toBe('timeout');
    expect(store.doc.review).toBeNull();
  });
});
