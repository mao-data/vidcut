import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { ProjectStore } from '../src/store.js';
import { createApp } from '../src/app.js';
import { runFfmpeg } from '../src/ffmpeg.js';

async function startTestServer() {
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-imp-proj-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
  const src = await mkdtemp(join(tmpdir(), 'vidcut-imp-src-'));
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
  });

  it('addToTimeline 會把整支接到主軌尾端', async () => {
    const { store, src, server, base } = await startTestServer();
    const res = await post(base, { dir: src, names: ['a.mp4'], addToTimeline: true });
    expect(res.status).toBe(200);
    expect(store.doc.tracks.video).toHaveLength(1);
    const clip = store.doc.tracks.video[0]!;
    expect(clip.in).toBe(0);
    expect(clip.duration).toBeCloseTo(2, 0);
    server.close();
  });

  it('壞檔進 failed，其餘繼續', async () => {
    const { src, server, base } = await startTestServer();
    const res = await post(base, { dir: src, names: ['a.mp4', 'missing.mp4'] });
    expect(res.status).toBe(200);
    const j = (await res.json()) as ImportRes;
    expect(j.ok).toHaveLength(1);
    expect(j.failed).toHaveLength(1);
    expect(j.failed[0]!.name).toBe('missing.mp4');
    server.close();
  });

  it('沒帶 dir 或 names 回 400', async () => {
    const { src, server, base } = await startTestServer();
    expect((await post(base, { names: ['a.mp4'] })).status).toBe(400);
    expect((await post(base, { dir: src })).status).toBe(400);
    server.close();
  });

  // 敵意輸入：names 是使用者可控字串，不能讓它逃出素材夾。
  it('names 帶路徑成分時只取 basename，不會逃出素材夾', async () => {
    const { src, store, server, base } = await startTestServer();
    const outside = await mkdtemp(join(tmpdir(), 'vidcut-secret-'));
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
  });

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
  });
});
