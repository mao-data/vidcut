import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSafeStamp,
  buildRenderArgs,
  render,
  renderProgressBus,
  withProbedChannels,
} from '../src/render.js';
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
    const plan = buildRenderArgs(p, '/proj', '/proj/out.mp4', {});
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
      const plan = buildRenderArgs(p, '/proj', '/proj/out.mp4', {});
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

  // 2026-08-05：原生 `drawtext` 分支整條刪掉了（見 buildRenderArgs 的註解）。這條測試
  // 從「有 drawtext 就走它」翻轉成**釘死它不准回來**：那條路沒有 fontfile=、不換行、
  // 描邊寫死 3px，是跟字卡完全不同的光柵器；本機 ffmpeg 沒 freetype 所以踩不到，
  // 換一台有的機器「預覽＝成品」會靜默失效。沒有字卡就是不燒字，不要有第二條路。
  it('沒有字卡就不燒字——不得退回原生 drawtext（那是另一個光柵器）', () => {
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
    const noCards = buildRenderArgs(p, '/x', '/x/o.mp4', {});
    expect(noCards.captionsBurned).toBe(false);
    const fc = noCards.args[noCards.args.indexOf('-filter_complex') + 1]!;
    expect(fc).not.toContain('drawtext');
  });

  it('composites PNG caption cards via overlay', () => {
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
    expect(buildRenderArgs(p, '/x', '/x/o.mp4', {}).captionsBurned).toBe(false);
    // 有字卡 → 以 overlay 合成
    const withCards = buildRenderArgs(p, '/x', '/x/o.mp4', {
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
    const plan = buildRenderArgs(p, '/proj', '/proj/out.mp4', {});
    expect(plan.args).toContain('/outside/vo.mp3');
    expect(plan.args).not.toContain(join('/proj', '/outside/vo.mp3'));
  });

  // 錯誤訊息品質：只報 audio item 的 id 會讓人得自己翻 project.json 才知道
  // 是哪個素材編號錯了。兩個 id 都要出現。
  it('音訊素材找不到時，錯誤訊息同時含 audio item id 與 mediaId', () => {
    const p = demoLikeProject();
    p.tracks.audio = [{ id: 'bgm1', mediaId: 'GHOST_ID', start: 0, in: 0, duration: 1, volume: 1 }];
    expect(() => buildRenderArgs(p, '/proj', '/proj/out.mp4', {})).toThrow(
      /bgm1.*GHOST_ID|GHOST_ID.*bgm1/,
    );
  });

  /**
   * 匯出尺寸必須是偶數——libx264 的 yuv420p 不吃奇數維度，整支匯出會以一句 ffmpeg
   * 錯誤結束（實測 `width: 721` → exit 187）。`even()` 以前**只包了推算出來的那一邊**，
   * 呼叫端明給的值原封不動送進 scale 濾鏡，而註解卻寫著「取偶數」。
   * 三個方向都要釘：明給的那一邊、推算的那一邊、兩邊都給。
   */
  describe('匯出尺寸一律取偶數', () => {
    const scaleOf = (exp: Record<string, unknown>) => {
      const plan = buildRenderArgs(demoLikeProject(), '/proj', '/proj/out.mp4', { export: exp });
      const fc = plan.args[plan.args.indexOf('-filter_complex') + 1]!;
      return /scale=(\d+):(\d+):flags=lanczos/.exec(fc);
    };

    it('明給的奇數寬會進位，推算出來的高也是偶數', () => {
      const m = scaleOf({ width: 721 });
      expect(m, 'width 給了就該有匯出縮放').not.toBeNull();
      expect(Number(m![1]) % 2).toBe(0);
      expect(Number(m![2]) % 2).toBe(0);
      expect(m![1]).toBe('722');
    });

    it('明給的奇數高會進位', () => {
      const m = scaleOf({ height: 721 });
      expect(Number(m![1]) % 2).toBe(0);
      expect(Number(m![2]) % 2).toBe(0);
      expect(m![2]).toBe('722');
    });

    it('兩邊都給奇數時兩邊都進位（不依比例互推）', () => {
      const m = scaleOf({ width: 405, height: 721 });
      expect(m![1]).toBe('406');
      expect(m![2]).toBe('722');
    });

    // 反向保險：畫布原尺寸不該被 even() 碰。1080×1920 本來就是偶數，
    // 重點是「沒給 width/height 時完全不插 scale 濾鏡」這個既有行為不能變。
    it('沒給尺寸時不插匯出縮放濾鏡', () => {
      expect(scaleOf({})).toBeNull();
    });
  });
});

/**
 * `stamp` 直接變成 `output/<stamp>.mp4` 的檔名，而它有**兩個**入口（MCP 的 render 工具、
 * WS 的 `{type:'render'}`），兩邊以前都沒驗。`../../x` 會把成品寫到專案目錄外，
 * 並讓 `render.lastOutput` 指向一個逃出去的相對路徑——之後 extractCover 拿它抽封面
 * 就再也抽不到。擋點放在 render.ts 才涵蓋得到兩條路。
 */
describe('assertSafeStamp', () => {
  it('放行正常的 stamp', () => {
    for (const s of ['render_42', 'wysiwyg', 'a.b-c_d', 'A1']) {
      expect(() => assertSafeStamp(s), s).not.toThrow();
    }
  });

  it('擋下會逃出 output/ 的 stamp', () => {
    for (const s of ['../../escape', 'a/b', '..', '.', '/abs', 'x\\y', '']) {
      expect(() => assertSafeStamp(s), s).toThrow(/stamp/);
    }
  });

  it('擋下過長的 stamp（檔名長度上限）', () => {
    expect(() => assertSafeStamp('a'.repeat(65))).toThrow(/stamp/);
    expect(() => assertSafeStamp('a'.repeat(64))).not.toThrow();
  });

  /**
   * 上面三條只證明這個純函式本身對——**忘了接上去**的話它們照樣全綠。
   * 這條打的是 `render()` 這個真正的入口（WS 那條路沒有 zod，只有這一道擋著），
   * 而且驗它擋在**做任何事之前**：專案是空的，若真的走進去會先撞上
   * 「timeline is empty」而不是 stamp 的錯誤。
   */
  it('render() 自己就會擋下危險的 stamp（不是只靠 MCP 的 schema）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-stamp-'));
    try {
      const store = await ProjectStore.load(join(dir, 'project.json'));
      await expect(render(store, dir, '../../escape')).rejects.toThrow(/stamp/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
    // demo 有 2 條字幕；burn 模式一律走 PNG 字卡（唯一的燒字路徑）→ 回報已燒
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
