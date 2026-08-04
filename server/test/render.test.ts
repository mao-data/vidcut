import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRenderArgs, render, renderProgressBus } from '../src/render.js';
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

  /**
   * position.scale 必須真的進 filtergraph。曾經整條 overlay 濾鏡鏈上沒有任何 scale
   * （預覽端吃 CSS transform、渲染端完全忽略），Inspector 那個使用者改得動的 scale 欄位
   * 因此是「預覽變、成品不變」——verify:wysiwyg 量到 scale=0.5 時預覽/成品寬比 0.4505、
   * 最大差 244px。
   */
  describe('overlay position.scale', () => {
    const withScale = (s: number) => {
      const p = demoLikeProject();
      p.tracks.overlays[0]!.position = { x: 0.5, y: 0.06, scale: s };
      const plan = buildRenderArgs(p, '/proj', '/proj/out.mp4', { hasDrawtext: false });
      return plan.args[plan.args.indexOf('-filter_complex') + 1]!;
    };

    it('scales the overlay input before compositing it', () => {
      const fc = withScale(0.5);
      // 縮放必須發生在 overlay 之前：overlay 的 w/h 讀的是「當下這一路的尺寸」，
      // 置中式子 (W*x)-(w/2) 才會用縮放後的寬置中。
      expect(fc).toContain('[2:v]scale=iw*0.5:ih*0.5[ovs0]');
      expect(fc).toContain('[ovs0]overlay=x=(W*0.5)-(w/2):y=(H*0.06)');
      // 縮放後的標籤才是 overlay 的輸入；不得再直接吃原始 input
      expect(fc).not.toContain('[2:v]overlay=');
      expect(fc.indexOf('scale=iw*0.5')).toBeLessThan(fc.indexOf('[ovs0]overlay='));
    });

    it('keeps the anchor semantics (x=centre, y=top) when scaled', () => {
      // 不對稱錨點是這個專案出過事故的地方：加了 scale 之後 y 仍然是「上緣」，
      // 不得偷偷變成中心（那會讓 1920*y 的圖整片位移半個高度）。
      const fc = withScale(0.25);
      expect(fc).toMatch(/\[ovs0\]overlay=x=\(W\*0\.5\)-\(w\/2\):y=\(H\*0\.06\)/);
      expect(fc).not.toContain('(h/2)');
    });

    it('emits no scale filter at scale = 1 (identity stays byte-identical)', () => {
      const fc = withScale(1);
      expect(fc).not.toContain('scale=iw*');
      expect(fc).toContain('[2:v]overlay=x=(W*0.5)-(w/2):y=(H*0.06)');
    });

    it('drops the overlay entirely at scale <= 0 instead of compositing it full size', () => {
      // ffmpeg 的 `scale=0` 意思是「沿用原尺寸」，而預覽端 CSS scale(0) 是「看不見」——
      // 照原樣疊上去就是又一次「預覽沒有、成品有」的靜默落差。
      for (const s of [0, -1, Number.NaN]) {
        const fc = withScale(s);
        expect(fc).not.toContain('overlay=x=(W*0.5)-(w/2)');
        expect(fc).not.toContain('scale=iw*');
      }
    });
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
});
