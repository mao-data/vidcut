import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRenderArgs, render, renderProgressBus, withProbedChannels } from '../src/render.js';
import { buildDemoProject } from '../src/demo.js';
import { ProjectStore } from '../src/store.js';
import { probe, runFfmpeg } from '../src/ffmpeg.js';
import { ingestMedia } from '../src/ingest.js';
import { createEmptyProject, type Project } from '@vidcut/shared';

function demoLikeProject(): Project {
  const p = createEmptyProject('p', 't');
  p.media = [
    {
      id: 'm1',
      path: 'a.mp4',
      probe: { duration: 10, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
    },
    {
      id: 'm2',
      path: 'b.mp4',
      probe: { duration: 10, width: 540, height: 960, fps: 30, hasAudio: false, rotation: 0 },
    },
  ];
  p.tracks.video = [
    { id: 'c1', mediaId: 'm1', in: 1, duration: 3, volume: 1 },
    { id: 'c2', mediaId: 'm2', in: 0, duration: 2, volume: 1 },
  ];
  p.tracks.overlays = [
    {
      id: 'o1',
      imagePath: 'title.png',
      start: 0,
      duration: null,
      position: { x: 0.5, y: 0.06, scale: 1 },
    },
  ];
  return p;
}

describe('buildRenderArgs', () => {
  it('builds inputs per clip + overlay, concat + overlay filtergraph, 1080x1920', () => {
    const p = demoLikeProject();
    const plan = buildRenderArgs(p, '/proj', '/proj/out.mp4', { hasDrawtext: false });
    const fc = plan.args[plan.args.indexOf('-filter_complex') + 1]!;
    // 2 clip inputs (-ss/-t/-i ×2) + 1 overlay input
    expect(plan.args.filter((a) => a === '-i')).toHaveLength(3);
    expect(fc).toContain('concat=n=2:v=1:a=0[vcat]');
    expect(fc).toContain('concat=n=2:v=0:a=1[aclips]');
    expect(fc).toContain('[aclips]anull[aout]'); // 無獨立音訊項時直接接出
    expect(fc).toContain('scale=1080:1920');
    // 無聲片段補 anullsrc
    expect(fc).toContain('anullsrc');
    // overlay 濾鏡帶 enable 與位置
    expect(fc).toMatch(/overlay=x=\(W\*0\.5\)-\(w\/2\):y=\(H\*0\.06\)/);
    expect(plan.totalDuration).toBe(5);
    expect(plan.captionsBurned).toBe(false);
  });

  it('burns captions via drawtext when available', () => {
    const p = demoLikeProject();
    p.tracks.captions = [
      {
        id: 'cap1',
        text: 'hi',
        start: 0,
        duration: 2,
        style: { fontFamily: 's', fontSize: 48, fill: '#fff', y: 0.8 },
      },
    ];
    const withText = buildRenderArgs(p, '/x', '/x/o.mp4', { hasDrawtext: true });
    expect(withText.captionsBurned).toBe(true);
    const fc = withText.args[withText.args.indexOf('-filter_complex') + 1]!;
    expect(fc).toContain('drawtext=text=');
  });

  it('composites PNG caption cards via overlay when drawtext unavailable', () => {
    const p = demoLikeProject();
    p.tracks.captions = [
      {
        id: 'cap1',
        text: 'hi',
        start: 1,
        duration: 2,
        style: { fontFamily: 's', fontSize: 48, fill: '#fff', y: 0.78 },
      },
    ];
    // 無字卡 → 不燒
    expect(buildRenderArgs(p, '/x', '/x/o.mp4', { hasDrawtext: false }).captionsBurned).toBe(false);
    // 有字卡 → 以 overlay 合成
    const withCards = buildRenderArgs(p, '/x', '/x/o.mp4', {
      hasDrawtext: false,
      captionCards: [
        {
          cap: p.tracks.captions[0]!,
          relPath: 'derived/captions/cap1.png',
          start: 1,
          end: 3,
        },
      ],
    });
    expect(withCards.captionsBurned).toBe(true);
    // clip inputs(2) + overlay input(1) + caption card input(1) = 4
    expect(withCards.args.filter((a) => a === '-i')).toHaveLength(4);
    const fc = withCards.args[withCards.args.indexOf('-filter_complex') + 1]!;
    expect(fc).not.toContain('drawtext');
    // 字卡以 overlay 在 y=(H*0.78) 疊上、帶時間 enable
    expect(fc).toMatch(/overlay=x=0:y=\(H\*0\.78\):enable='between\(t\\,1\\,3\)'/);
  });

  // 回歸：獨立音訊項（旁白/BGM/抽出的聲音）的 ffmpeg input 必須用 resolveMediaPath，
  // 不能直接 join(projectDir, media.path)——後者會把外部絕對路徑錯誤拼接成
  // /專案路徑/Users/... 這種不存在的路徑（見 render.ts:222）。純函數斷言，不用跑 ffmpeg。
  it('uses an absolute audio-item media path as-is instead of joining it under projectDir (render.ts:222)', () => {
    const p = demoLikeProject();
    p.media.push({
      id: 'vo',
      path: '/outside/vo.mp3',
      probe: { duration: 30, width: 0, height: 0, fps: 0, hasAudio: true, rotation: 0 },
    });
    p.tracks.audio = [{ id: 'a1', mediaId: 'vo', start: 0, in: 0, duration: 2, volume: 1 }];
    const plan = buildRenderArgs(p, '/proj', '/proj/out.mp4', { hasDrawtext: false });
    expect(plan.args).toContain('/outside/vo.mp3');
    expect(plan.args).not.toContain(join('/proj', '/outside/vo.mp3'));
  });

  // 錯誤訊息品質：只報 audio item 的 id 會讓人得自己翻 project.json 才知道
  // 是哪個素材編號錯了。兩個 id 都要出現。
  it('音訊素材找不到時，錯誤訊息同時含 audio item id 與 mediaId', () => {
    const p = demoLikeProject();
    p.tracks.audio = [{ id: 'bgm1', mediaId: 'GHOST_ID', start: 0, in: 0, duration: 1, volume: 1 }];
    expect(() => buildRenderArgs(p, '/proj', '/proj/out.mp4', { hasDrawtext: false })).toThrow(
      /bgm1.*GHOST_ID|GHOST_ID.*bgm1/,
    );
  });
});

describe('render (integration)', () => {
  it('renders the demo project to a valid 1080x1920 mp4 with audio', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-render-'));
    await buildDemoProject(dir);
    const store = await ProjectStore.load(join(dir, 'project.json'));
    const vBefore = store.version;
    const progressSeen: number[] = [];
    const onProgress = (p: number) => progressSeen.push(p);
    renderProgressBus.on('progress', onProgress);
    const res = await render(store, dir, 'test');
    renderProgressBus.off('progress', onProgress);
    const info = await probe(join(dir, res.outPath));

    // 進度走旁路：不進版本化歷史（spec 2026-08-03 B2），事件照發
    expect(store.history().some((h) => h.label === 'render progress')).toBe(false);
    expect(store.version - vBefore).toBe(2); // 僅 render start + done
    expect(progressSeen.length).toBeGreaterThan(0);
    expect(Math.max(...progressSeen)).toBeGreaterThan(0.5);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.hasAudio).toBe(true);
    // demo 5 clips × 3s = 15s
    expect(info.duration).toBeGreaterThan(14);
    expect(info.duration).toBeLessThan(16);
    expect(store.doc.render.status).toBe('done');
    expect(store.doc.render.lastOutput).toBe(res.outPath);
    // demo 有 2 條字幕；本機無 drawtext → 應走 PNG 字卡並回報已燒
    expect(res.captionsBurned).toBe(true);
  }, 180_000);

  it('輸出吃專案外絕對路徑的素材', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vidcut-ext-render-'));
    const src = join(outside, 'ext.mp4');
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
      src,
    ]);
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-ext-proj-'));
    const store = await ProjectStore.load(join(dir, 'project.json'));
    const mediaId = await ingestMedia(store, dir, src);
    store.mutate('ai', 'seed', (d) => {
      d.tracks.video = [{ id: 'c1', mediaId, in: 0, duration: 1, volume: 1 }];
    });

    const res = await render(store, dir, 'ext-test', { width: 180, height: 320 });
    expect(existsSync(join(dir, res.outPath))).toBe(true);
  }, 60_000);

  // 回歸：定格幀（frozen frame）擷取的來源同樣要用 resolveMediaPath，不能直接
  // join(projectDir, media.path)（見 render.ts:431）。若換回 join，外部絕對路徑會被
  // 拼成 <projectDir>/<外部路徑> 這種不存在的檔案，ffmpeg 擷取單幀會直接失敗
  // （ffmpeg render exited 254）。整合測試，真 ffmpeg。
  it('frozen clip 用專案外絕對路徑素材時仍能定格擷取成功（render.ts:431）', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vidcut-ext-frozen-'));
    const src = join(outside, 'ext-frozen.mp4');
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
      src,
    ]);
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-ext-frozen-proj-'));
    const store = await ProjectStore.load(join(dir, 'project.json'));
    const mediaId = await ingestMedia(store, dir, src);
    store.mutate('ai', 'seed', (d) => {
      d.tracks.video = [{ id: 'c1', mediaId, in: 0, duration: 1, volume: 0, frozen: true }];
    });

    const res = await render(store, dir, 'ext-frozen-test', { width: 180, height: 320 });
    expect(existsSync(join(dir, res.outPath))).toBe(true);
  }, 60_000);

  it('素材原檔不見時，輸出丟出含路徑的明確錯誤', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vidcut-gone-'));
    const src = join(outside, 'gone.mp4');
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
      src,
    ]);
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-gone-proj-'));
    const store = await ProjectStore.load(join(dir, 'project.json'));
    const mediaId = await ingestMedia(store, dir, src);
    store.mutate('ai', 'seed', (d) => {
      d.tracks.video = [{ id: 'c1', mediaId, in: 0, duration: 1, volume: 1 }];
    });

    await rm(src); // 原檔被移走／刪除

    await expect(render(store, dir, 'test', { width: 180, height: 320 })).rejects.toThrow(
      /gone\.mp4/,
    );
    // 上面單用 /gone\.mp4/ 比對其實殺不死「沒做預檢」的實作：真的啟動 ffmpeg 之後，
    // ffmpeg 自己的 stderr 也會含缺檔的完整路徑（「Error opening input file .../gone.mp4」），
    // 所以光比對檔名不能證明「在啟動 ffmpeg 前」就攔下來。這裡額外鎖定 Step 7 加的
    // 訊息前綴，把「有沒有真的做預檢」跟「ffmpeg 原始報錯裡剛好也有檔名」區分開來。
    await expect(render(store, dir, 'test2', { width: 180, height: 320 })).rejects.toThrow(
      /^render: 找不到素材原檔：/,
    );
  }, 60_000);

  // 位置回歸：缺檔預檢必須在任何 ffmpeg 啟動之前，包含定格幀擷取（render.ts 約
  // 420-439 行，緊接在預檢區塊之後）。上面「素材原檔不見時」那條測試的 clip 不是
  // frozen，測不到「預檢被搬到定格幀擷取之後」這種退化——那種退化下，非 frozen clip
  // 一樣會在預檢就被擋下，因為預檢本身邏輯沒壞，壞的只是「位置」，而定格幀擷取只
  // 處理 frozen clip。所以要專門用一個 frozen clip 的原檔缺失來鎖住「預檢先於定格幀
  // 擷取」這個順序不變式（Task 7 審查發現：搬到定格幀擷取之後，6/6 全綠，render.test.ts
  // 全文沒有 frozen 字樣，沒人守）。
  it('frozen clip 的素材原檔不見時，預檢仍趕在定格幀擷取（任何 ffmpeg）之前擋下', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vidcut-gone-frozen-'));
    const src = join(outside, 'gone-frozen.mp4');
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
      src,
    ]);
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-gone-frozen-proj-'));
    const store = await ProjectStore.load(join(dir, 'project.json'));
    const mediaId = await ingestMedia(store, dir, src);
    store.mutate('ai', 'seed', (d) => {
      d.tracks.video = [{ id: 'c1', mediaId, in: 0, duration: 1, volume: 1, frozen: true }];
    });

    await rm(src); // 原檔被移走／刪除

    await expect(render(store, dir, 'test', { width: 180, height: 320 })).rejects.toThrow(
      /^render: 找不到素材原檔：/,
    );
  }, 60_000);
});

// 第 9 個 resolveMediaPath 呼叫點：render() 渲染前補測 audioChannels（讓 mono 升混
// 對舊 project.json 也生效）。這一步的 catch 會吞掉 probe 失敗，所以若路徑接法退回
// join(projectDir, m.path)，外部絕對路徑素材會靜默測不到聲道數 → mono 不升混 → 成品
// 小 3dB，沒有任何錯誤訊息。把它抽成具名函式才守得住。
describe('withProbedChannels（render 前補測 audioChannels）', () => {
  it('外部絕對路徑的 mono 素材也補得到 audioChannels', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vidcut-ext-mono-'));
    const mp3 = join(outside, 'vo.mp3');
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ac', '1', mp3]);
    const projectDir = await mkdtemp(join(tmpdir(), 'vidcut-ext-mono-proj-'));

    const p = demoLikeProject();
    p.media.push({
      id: 'vo',
      path: mp3, // 絕對路徑＝零複製外部引用；probe 刻意不帶 audioChannels
      probe: { duration: 1, width: 0, height: 0, fps: 0, hasAudio: true, rotation: 0 },
    });
    p.tracks.audio = [{ id: 'a1', mediaId: 'vo', start: 0, in: 0, duration: 1, volume: 1 }];

    const media = await withProbedChannels(p, projectDir);
    expect(media.find((m) => m.id === 'vo')!.probe.audioChannels).toBe(1);
  }, 60_000);
});
