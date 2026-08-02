import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyProject, type Project } from '@vidcut/shared';
import { buildRenderArgs, extractCover, frozenFramePath, render } from '../src/render.js';
import { ProjectStore } from '../src/store.js';
import { probe } from '../src/ffmpeg.js';
import { makeVideo } from './fixtures.js';

function base(): Project {
  const p = createEmptyProject('p', 't');
  p.media = [
    {
      id: 'm1',
      path: 'a.mp4',
      probe: { duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: true, rotation: 0 },
    },
  ];
  p.tracks.video = [{ id: 'c1', mediaId: 'm1', in: 1, duration: 3, volume: 1 }];
  return p;
}

function fcOf(plan: { args: string[] }): string {
  return plan.args[plan.args.indexOf('-filter_complex') + 1]!;
}

describe('canvas fit: blur', () => {
  it('contain (default) pads with black bars', () => {
    const fc = fcOf(buildRenderArgs(base(), '/x', '/x/o.mp4', { hasDrawtext: false }));
    expect(fc).toContain('pad=1080:1920');
    expect(fc).not.toContain('boxblur');
  });

  it('blur fills with a scaled-up blurred copy behind the contained frame', () => {
    const p = base();
    p.canvas.fit = 'blur';
    const fc = fcOf(buildRenderArgs(p, '/x', '/x/o.mp4', { hasDrawtext: false }));
    expect(fc).toContain('split=2[bg0][fg0]');
    // 背景放大裁滿 + 模糊
    expect(fc).toMatch(
      /\[bg0\]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=/,
    );
    // 前景維持原比例，疊在中央
    expect(fc).toContain('force_original_aspect_ratio=decrease[fgs0]');
    expect(fc).toContain('[bgb0][fgs0]overlay=(W-w)/2:(H-h)/2');
    expect(fc).not.toContain('pad=1080:1920');
  });
});

describe('frozen clips', () => {
  it('uses a looped still image input and a silent audio branch', () => {
    const p = base();
    p.tracks.video.push({
      id: 'fz',
      mediaId: 'm1',
      in: 2,
      duration: 1.5,
      volume: 0,
      frozen: true,
    });
    const plan = buildRenderArgs(p, '/proj', '/proj/o.mp4', { hasDrawtext: false });
    // 定格片段吃 -loop 1 -t D -i <frozen path>
    expect(plan.args).toContain('-loop');
    expect(plan.args).toContain(join('/proj', frozenFramePath('fz')));
    // 定格段即使來源有聲也走 anullsrc
    expect(fcOf(plan)).toContain('anullsrc=channel_layout=stereo:sample_rate=44100:d=1.5');
    expect(plan.totalDuration).toBeCloseTo(4.5);
  });
});

describe('audio track mixing', () => {
  it('trims, fades, delays and mixes independent audio items', () => {
    const p = base();
    p.media.push({
      id: 'bgm',
      path: 'bgm.mp3',
      probe: { duration: 60, width: 0, height: 0, fps: 0, hasAudio: true, rotation: 0 },
    });
    p.tracks.audio = [
      {
        id: 'a1',
        mediaId: 'bgm',
        start: 0.5,
        in: 10,
        duration: 2,
        volume: 0.6,
        fadeIn: 0.3,
        fadeOut: 0.4,
      },
    ];
    const plan = buildRenderArgs(p, '/x', '/x/o.mp4', { hasDrawtext: false });
    const fc = fcOf(plan);
    // 1 clip input + 1 audio input
    expect(plan.args.filter((a) => a === '-i')).toHaveLength(2);
    expect(fc).toContain('atrim=start=10:duration=2');
    expect(fc).toContain('volume=0.6');
    expect(fc).toContain('afade=t=in:st=0:d=0.3');
    expect(fc).toContain('afade=t=out:st=1.6:d=0.4');
    expect(fc).toContain('adelay=500|500');
    expect(fc).toContain('amix=inputs=2:normalize=0');
    // 截到成片長度
    expect(fc).toContain('atrim=duration=3');
  });

  it('ducks the clip audio while a ducking item plays', () => {
    const p = base();
    p.media.push({
      id: 'vo',
      path: 'vo.mp3',
      probe: { duration: 30, width: 0, height: 0, fps: 0, hasAudio: true, rotation: 0 },
    });
    p.tracks.audio = [
      { id: 'a1', mediaId: 'vo', start: 1, in: 0, duration: 1.5, volume: 1, ducking: true },
    ];
    const fc = fcOf(buildRenderArgs(p, '/x', '/x/o.mp4', { hasDrawtext: false }));
    expect(fc).toMatch(
      /\[aclips\]volume=volume='if\(between\(t\\,1\\,2\.5\)\\,0\.25\\,1\)':eval=frame\[aduck0\]/,
    );
  });

  it('omits the amix stage when there are no audio items', () => {
    const fc = fcOf(buildRenderArgs(base(), '/x', '/x/o.mp4', { hasDrawtext: false }));
    expect(fc).not.toContain('amix');
    expect(fc).toContain('[aclips]anull[aout]');
  });
});

describe('render integration: blur + frozen + audio', () => {
  it('renders a project with all three features to a valid mp4', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-rt1-'));
    // 橫向素材（測 blur 填充）+ 一支當 BGM 的有聲素材
    await makeVideo(dir, 'wide.mp4', { duration: 6, withAudio: true });
    await makeVideo(dir, 'bgm.mp4', { duration: 6, withAudio: true, freq: 220 });
    const store = await ProjectStore.load(join(dir, 'project.json'));
    store.mutate('ai', 'seed', (d) => {
      d.canvas.fit = 'blur';
      d.media = [
        {
          id: 'mv',
          path: 'wide.mp4',
          probe: { duration: 6, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
        {
          id: 'mb',
          path: 'bgm.mp4',
          probe: { duration: 6, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
      d.tracks.video = [
        { id: 'c1', mediaId: 'mv', in: 0, duration: 2, volume: 1 },
        { id: 'fz', mediaId: 'mv', in: 3, duration: 1, volume: 0, frozen: true },
      ];
      d.tracks.audio = [
        {
          id: 'a1',
          mediaId: 'mb',
          start: 0,
          in: 0,
          duration: 3,
          volume: 0.5,
          fadeIn: 0.3,
          fadeOut: 0.3,
          ducking: true,
        },
      ];
    });
    const res = await render(store, dir, 't1');
    const info = await probe(join(dir, res.outPath));
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.hasAudio).toBe(true);
    expect(info.duration).toBeGreaterThan(2.5);
    expect(info.duration).toBeLessThan(3.6);
  }, 180_000);
});

describe('export options', () => {
  it('scales to the export resolution after compositing at canvas size', () => {
    const plan = buildRenderArgs(base(), '/x', '/x/o.mp4', {
      hasDrawtext: false,
      export: { width: 720, height: 1280, fps: 60, crf: 18 },
    });
    const fc = fcOf(plan);
    // 合成仍在 1080×1920，最後才縮到 720×1280
    expect(fc).toContain('scale=1080:1920');
    expect(fc).toContain('scale=720:1280:flags=lanczos');
    expect(fc).toContain('fps=60');
    expect(plan.args).toContain('-crf');
    expect(plan.args[plan.args.indexOf('-crf') + 1]).toBe('18');
  });

  it('uses bitrate mode and hevc when asked', () => {
    const plan = buildRenderArgs(base(), '/x', '/x/o.mp4', {
      hasDrawtext: false,
      export: { videoBitrate: '10M', codec: 'hevc' },
    });
    expect(plan.args).toContain('-b:v');
    expect(plan.args[plan.args.indexOf('-b:v') + 1]).toBe('10M');
    expect(plan.args).not.toContain('-crf');
    expect(plan.args).toContain('libx265');
    expect(plan.args).toContain('hvc1');
  });

  it('renders at a smaller resolution end-to-end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-exp-'));
    await makeVideo(dir, 'a.mp4', { duration: 3, withAudio: true });
    const store = await ProjectStore.load(join(dir, 'project.json'));
    store.mutate('ai', 'seed', (d) => {
      d.media = [
        {
          id: 'm1',
          path: 'a.mp4',
          probe: { duration: 3, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
      d.tracks.video = [{ id: 'c1', mediaId: 'm1', in: 0, duration: 2, volume: 1 }];
    });
    const res = await render(store, dir, 'small', { width: 540, height: 960, crf: 26 });
    const info = await probe(join(dir, res.outPath));
    expect(info.width).toBe(540);
    expect(info.height).toBe(960);
  }, 120_000);

  it('keeps the canvas aspect ratio when only one output dimension is given', async () => {
    // RenderOptions.width 的契約是「等比縮放整個合成結果」。只給一邊卻沿用畫布的
    // 另一邊，會默默產出變形的成品——UI 的預設檔都成對給值，但 MCP 的 render
    // 工具把兩個參數獨立開放給 AI，所以這條路徑是真的會被走到的。
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-aspect-'));
    await makeVideo(dir, 'a.mp4', { duration: 2, withAudio: true });
    const store = await ProjectStore.load(join(dir, 'project.json'));
    store.mutate('ai', 'seed', (d) => {
      d.canvas = { width: 1080, height: 1920, fps: 30 };
      d.media = [
        {
          id: 'm1',
          path: 'a.mp4',
          probe: { duration: 2, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
      d.tracks.video = [{ id: 'c1', mediaId: 'm1', in: 0, duration: 1.5, volume: 1 }];
    });

    const byWidth = await render(store, dir, 'w-only', { width: 360, crf: 30 });
    const w = await probe(join(dir, byWidth.outPath));
    expect([w.width, w.height]).toEqual([360, 640]); // 1080×1920 → 9:16 維持

    const byHeight = await render(store, dir, 'h-only', { height: 640, crf: 30 });
    const h = await probe(join(dir, byHeight.outPath));
    expect([h.width, h.height]).toEqual([360, 640]);
  }, 180_000);
});

describe('cover', () => {
  it('extracts a cover from the rendered output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-cov-'));
    await makeVideo(dir, 'a.mp4', { duration: 3, withAudio: true });
    const store = await ProjectStore.load(join(dir, 'project.json'));
    store.mutate('ai', 'seed', (d) => {
      d.media = [
        {
          id: 'm1',
          path: 'a.mp4',
          probe: { duration: 3, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
      d.tracks.video = [{ id: 'c1', mediaId: 'm1', in: 0, duration: 2, volume: 1 }];
    });
    // 尚無成品 → 從來源抽
    const rel1 = await extractCover(store, dir, 1);
    expect(rel1).toBe(join('output', 'cover.jpg'));
    expect(store.doc.render.coverPath).toBe(rel1);
    const img1 = await probe(join(dir, rel1));
    expect(img1.width).toBeGreaterThan(0);

    // 有成品後 → 從成片抽（即 1080×1920 的合成畫面）
    await render(store, dir, 'c');
    await extractCover(store, dir, 1);
    const img2 = await probe(join(dir, rel1));
    expect(img2.width).toBe(1080);
    expect(img2.height).toBe(1920);
  }, 180_000);
});
