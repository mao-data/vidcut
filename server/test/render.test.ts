import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRenderArgs, render } from '../src/render.js';
import { buildDemoProject } from '../src/demo.js';
import { ProjectStore } from '../src/store.js';
import { probe } from '../src/ffmpeg.js';
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
    { id: 'o1', imagePath: 'title.png', start: 0, duration: null, position: { x: 0.5, y: 0.06, scale: 1 } },
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
    expect(fc).toContain('concat=n=2:v=0:a=1[aout]');
    expect(fc).toContain('scale=1080:1920');
    // 無聲片段補 anullsrc
    expect(fc).toContain('anullsrc');
    // overlay 濾鏡帶 enable 與位置
    expect(fc).toMatch(/overlay=x=\(W\*0\.5\)-\(w\/2\):y=\(H\*0\.06\)/);
    expect(plan.totalDuration).toBe(5);
    expect(plan.captionsBurned).toBe(false);
  });

  it('burns captions only when drawtext available', () => {
    const p = demoLikeProject();
    p.tracks.captions = [
      { id: 'cap1', text: 'hi', start: 0, duration: 2, style: { fontFamily: 's', fontSize: 48, fill: '#fff', y: 0.8 } },
    ];
    expect(buildRenderArgs(p, '/x', '/x/o.mp4', { hasDrawtext: false }).captionsBurned).toBe(false);
    const withText = buildRenderArgs(p, '/x', '/x/o.mp4', { hasDrawtext: true });
    expect(withText.captionsBurned).toBe(true);
    const fc = withText.args[withText.args.indexOf('-filter_complex') + 1]!;
    expect(fc).toContain('drawtext=text=');
  });
});

describe('render (integration)', () => {
  it(
    'renders the demo project to a valid 1080x1920 mp4 with audio',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'vidcut-render-'));
      await buildDemoProject(dir);
      const store = await ProjectStore.load(join(dir, 'project.json'));
      const res = await render(store, dir, 'test');
      const info = await probe(join(dir, res.outPath));
      expect(info.width).toBe(1080);
      expect(info.height).toBe(1920);
      expect(info.hasAudio).toBe(true);
      // demo 5 clips × 3s = 15s
      expect(info.duration).toBeGreaterThan(14);
      expect(info.duration).toBeLessThan(16);
      expect(store.doc.render.status).toBe('done');
      expect(store.doc.render.lastOutput).toBe(res.outPath);
    },
    180_000,
  );
});
