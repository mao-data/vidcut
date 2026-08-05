import { describe, it, expect, vi } from 'vitest';
import { basename, join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { ProjectStore } from '../src/store.js';
import { createApp } from '../src/app.js';
import { runFfmpeg } from '../src/ffmpeg.js';
import { existsSync } from 'node:fs';
import { makeAudio } from './fixtures.js';
import { tmpDir } from './tmp.js';

async function startTestServer() {
  const dir = await tmpDir('vidcut-imp-proj-');
  const store = await ProjectStore.load(join(dir, 'project.json'));
  const src = await tmpDir('vidcut-imp-src-');
  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x568:rate=30:duration=2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    join(src, 'a.mp4'),
  ]);
  const server: Server = createServer(createApp(store, dir));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { dir, store, src, server, base: `http://127.0.0.1:${port}` };
}

interface ImportRes {
  ok: Array<{ name: string; mediaId: string }>;
  failed: Array<{ name: string; error: string }>;
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/import', () => {
  it('匯入後素材進 doc.media 且原檔不被複製', async () => {
    const { store, src, server, base } = await startTestServer();
    const res = await post(base, { dir: src, names: ['a.mp4'] });
    expect(res.status).toBe(200);
    const j = (await res.json()) as ImportRes;
    expect(j.failed).toEqual([]);
    expect(j.ok).toHaveLength(1);
    const m = store.doc.media.find((x) => x.id === j.ok[0]!.mediaId)!;
    expect(m.path).toBe(join(src, 'a.mp4'));
    expect(store.doc.tracks.video).toHaveLength(0); // 預設不排上時間軸
    server.close();
  }, 60_000);

  it('addToTimeline 會把整支接到主軌尾端', async () => {
    const { store, src, server, base } = await startTestServer();
    const res = await post(base, { dir: src, names: ['a.mp4'], addToTimeline: true });
    expect(res.status).toBe(200);
    expect(store.doc.tracks.video).toHaveLength(1);
    const clip = store.doc.tracks.video[0]!;
    expect(clip.in).toBe(0);
    expect(clip.duration).toBeCloseTo(2, 0);
    server.close();
  }, 60_000);

  it('壞檔進 failed，其餘繼續', async () => {
    const { src, server, base } = await startTestServer();
    const res = await post(base, { dir: src, names: ['a.mp4', 'missing.mp4'] });
    expect(res.status).toBe(200);
    const j = (await res.json()) as ImportRes;
    expect(j.ok).toHaveLength(1);
    expect(j.failed).toHaveLength(1);
    expect(j.failed[0]!.name).toBe('missing.mp4');
    server.close();
  }, 60_000);

  it('沒帶 dir 或 names 回 400', async () => {
    const { src, server, base } = await startTestServer();
    expect((await post(base, { names: ['a.mp4'] })).status).toBe(400);
    expect((await post(base, { dir: src })).status).toBe(400);
    server.close();
  }, 60_000);

  // 敵意輸入：names 是使用者可控字串，不能讓它逃出素材夾。
  it('names 帶路徑成分時只取 basename，不會逃出素材夾', async () => {
    const { src, store, server, base } = await startTestServer();
    const outside = await tmpDir('vidcut-secret-');
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x568:rate=30:duration=1',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      join(outside, 'secret.mp4'),
    ]);

    const res = await post(base, {
      dir: src,
      names: [`../${basename(outside)}/secret.mp4`],
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as ImportRes;
    // basename 後變成 'secret.mp4'，在素材夾內不存在 → 進 failed，且沒有任何素材被登記
    expect(j.ok).toEqual([]);
    expect(j.failed).toHaveLength(1);
    expect(store.doc.media).toHaveLength(0);
    server.close();
  }, 60_000);

  // 誘餌檔案：在素材夾內放一支「basename 後同名」的真影片，讓 basename 有沒有生效
  // 產生可觀察的差異——否則「絕對路徑目標本來就不存在」會讓這條測試無論 basename
  // 在不在都通過（實測驗證過，見 task-6-report.md 的 mutant 1 章節）。
  // - basename 生效 → join(src, 'hosts.mp4') 命中素材夾內的誘餌檔 → 進 ok[]。
  // - basename 被拿掉（mutant）→ join(src, '/etc/hosts.mp4') = `${src}/etc/hosts.mp4`
  //   → 不存在 → 進 failed[]。
  it('names 帶絕對路徑時同樣被 basename 擋下（誘餌檔驗證 basename 真的生效）', async () => {
    const { src, store, server, base } = await startTestServer();
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x568:rate=30:duration=1',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      join(src, 'hosts.mp4'),
    ]);
    const res = await post(base, { dir: src, names: ['/etc/hosts.mp4'] });
    expect(res.status).toBe(200);
    const j = (await res.json()) as ImportRes;
    expect(j.ok).toHaveLength(1);
    const m = store.doc.media.find((x) => x.id === j.ok[0]!.mediaId)!;
    expect(m.path).toBe(join(src, 'hosts.mp4'));
    // 安全不變式：任何情況下都不得匯入素材夾以外的檔案。
    for (const media of store.doc.media) {
      expect(media.path.startsWith(src)).toBe(true);
    }
    server.close();
  }, 60_000);

  // 不變式：ffmpeg 一支動輒數秒到數分鐘，/api/import 必須逐支序列處理 names[]，
  // 不能併行（brief 的 Global Constraints 明講：並行只會互搶 CPU）。
  // 其餘 6 條測試都用真 ffmpeg 驗證行為；這條測試觀測的是「route 的編排邏輯」——
  // 呼叫 ingestMedia 的順序與併發度——受測單元不是 ffmpeg 本身，ingestMedia→ffmpeg
  // 子行程是外部邊界，所以只有這一條用 vi.doMock 把 ingestMedia 換成一個會記錄
  // 「同一時間有幾支在跑」的假實作。用 vi.doMock（非 vi.mock）+ 動態 import + 手動
  // resetModules，讓 mock 只作用在這條測試的模組圖裡，不污染其餘 6 條真 ffmpeg 測試。
  it('/api/import 逐支序列處理 names[]，不會併行呼叫 ingestMedia', async () => {
    vi.resetModules();
    const state = { inFlight: 0, maxInFlight: 0, callOrder: [] as string[] };
    vi.doMock('../src/ingest.js', () => ({
      ingestMedia: async (_store: unknown, _projectDir: string, path: string) => {
        state.inFlight++;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        state.callOrder.push(path);
        // 人工延遲：若外面是 Promise.all 併行呼叫，三支呼叫會在延遲期間重疊，
        // maxInFlight 就會 > 1；若是 for...await 序列呼叫，每支跑完（含延遲）
        // 才會呼叫下一支，maxInFlight 恆為 1。
        await new Promise((r) => setTimeout(r, 20));
        state.inFlight--;
        return `fake-${state.callOrder.length}`;
      },
    }));

    const { createApp: mockedCreateApp } = await import('../src/app.js');
    const { ProjectStore: MockedProjectStore } = await import('../src/store.js');

    const dir = await tmpDir('vidcut-imp-mockproj-');
    const store = await MockedProjectStore.load(join(dir, 'project.json'));
    const server: Server = createServer(mockedCreateApp(store, dir));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;

    try {
      const res = await post(base, {
        dir: '/fake-src',
        names: ['x.mp4', 'y.mp4', 'z.mp4'],
      });
      expect(res.status).toBe(200);
      const j = (await res.json()) as ImportRes;
      expect(j.failed).toEqual([]);
      expect(j.ok).toHaveLength(3);

      expect(state.maxInFlight).toBe(1); // 序列處理：同一時間只有一支在跑
      expect(state.callOrder).toEqual([
        join('/fake-src', 'x.mp4'),
        join('/fake-src', 'y.mp4'),
        join('/fake-src', 'z.mp4'),
      ]);
    } finally {
      server.close();
      vi.doUnmock('../src/ingest.js');
      vi.resetModules(); // 還原：避免這個 mock 洩漏到其他測試
    }
  });
});

// 純音訊素材是「合併 main 之後才成立」的能力：本分支單獨時 probe 對無視訊串流
// 一律丟錯（純音訊 100% 進 failed[]），main 單獨時沒有 /api/source /api/import。
// 這兩條測的是合併產物，任一 parent 上都會紅。
describe('純音訊素材（合併 main 後）', () => {
  it('素材夾裡的 .mp3 列得到、匯入得了，且只產 peaks 不產 proxy/filmstrip', async () => {
    const { dir, store, src, server, base } = await startTestServer();
    try {
      await makeAudio(src, 'bgm.mp3', { duration: 2 });

      const listed = (await (
        await fetch(`${base}/api/source?dir=${encodeURIComponent(src)}`)
      ).json()) as {
        files: Array<{ name: string; imported: boolean }>;
      };
      expect(listed.files.map((f) => f.name)).toContain('bgm.mp3');

      const res = await post(base, { dir: src, names: ['bgm.mp3'] });
      expect(res.status).toBe(200);
      const j = (await res.json()) as ImportRes;
      expect(j.failed).toEqual([]);
      expect(j.ok).toHaveLength(1);

      const media = store.doc.media.find((m) => m.id === j.ok[0]!.mediaId)!;
      expect(media.path).toBe(join(src, 'bgm.mp3')); // 零複製：原檔留在素材夾
      expect(media.probe.hasVideo).toBe(false);
      expect(media.probe.hasAudio).toBe(true);
      expect(media.proxyPath).toBeUndefined();
      expect(media.filmstripPath).toBeUndefined();
      expect(media.peaksPath).toBeDefined();
      expect(existsSync(join(dir, media.peaksPath!))).toBe(true);
    } finally {
      server.close();
    }
  }, 60_000);

  it('addToTimeline 不會把純音訊放上視訊軌（素材仍完成匯入）', async () => {
    const { store, src, server, base } = await startTestServer();
    try {
      await makeAudio(src, 'bgm.mp3', { duration: 2 });

      const res = await post(base, { dir: src, names: ['bgm.mp3'], addToTimeline: true });
      const j = (await res.json()) as ImportRes;

      expect(store.doc.tracks.video).toHaveLength(0); // 視訊軌沒被污染
      // 已知限制：ingest 成功但 addClip 被拒 → 整支記進 failed[]，素材其實已登記
      expect(j.failed).toHaveLength(1);
      expect(j.failed[0]!.error).toMatch(/audio-only/);
      expect(store.doc.media.some((m) => m.probe.hasVideo === false)).toBe(true);
    } finally {
      server.close();
    }
  }, 60_000);
});
