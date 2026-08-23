import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { render, renderCoverImage } from '../src/render.js';
import { extractFrame } from '../src/frame.js';
import { ProjectStore } from '../src/store.js';
import { probe, runFfmpeg } from '../src/ffmpeg.js';
import { makeVideo } from './fixtures.js';
import { tmpDir } from './tmp.js';

/**
 * 抽某一時刻的單幀，8x8 downscale 成 raw rgb24 後回傳平均亮度（0–255）。
 * 手法照抄 render-blacktail.test.ts 的同名函式（那支沒有 export，這裡自帶一份）。
 */
async function meanBrightnessAt(
  videoPath: string,
  t: number,
  dir: string,
  tag: string,
): Promise<number> {
  const raw = join(dir, `${tag}.rgb`);
  await runFfmpeg([
    '-ss',
    String(t),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-vf',
    'scale=8:8',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    raw,
  ]);
  const buf = await readFile(raw);
  let sum = 0;
  for (const b of buf) sum += b;
  return sum / buf.length;
}

/**
 * 同上，但給**單張靜圖**（renderCoverImage 的輸出，一張 JPEG，不是有時間軸的影片）用：
 * 不帶 `-ss`——實測對單幀 JPEG 輸入加 `-ss 0` 會讓 ffmpeg 靜默吐出 0 位元組的輸出
 * （成功結束、exit 0，但沒有任何 frame 寫出），不是「seek 到最前面」的無害 no-op。
 */
async function meanBrightnessOfImage(imgPath: string, dir: string, tag: string): Promise<number> {
  const raw = join(dir, `${tag}.rgb`);
  await runFfmpeg([
    '-i',
    imgPath,
    '-frames:v',
    '1',
    '-vf',
    'scale=8:8',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    raw,
  ]);
  const buf = await readFile(raw);
  let sum = 0;
  for (const b of buf) sum += b;
  return sum / buf.length;
}

/** 探測音訊串流本身在 [start, start+dur) 的 RMS（dB，越負越安靜；無聲理論值 -inf，ffmpeg 回 -91 附近的地板值）。 */
async function rmsLevelDb(file: string, start: number, dur: number): Promise<number> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner',
      '-ss',
      String(start),
      '-t',
      String(dur),
      '-i',
      file,
      '-af',
      'astats=metadata=1:reset=1',
      '-f',
      'null',
      '-',
    ]);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg ${code}`)),
    );
  });
  // 取最後一次（reset=1 每個 frame 都印，最後一筆涵蓋整段殘留狀態最完整）Overall RMS level
  const matches = [...stdout.matchAll(/RMS level dB:\s*(-?[\d.]+|-inf)/g)];
  const last = matches.at(-1)?.[1];
  if (!last) throw new Error(`no RMS level dB found in astats output:\n${stdout.slice(-2000)}`);
  return last === '-inf' ? -Infinity : Number(last);
}

describe('render leadPad 黑墊落地（Plan 14 Task 2，真 ffmpeg）', () => {
  it('黑墊段抽幀接近全黑，內容段（pad 位移後）才是真正的來源畫面', async () => {
    const dir = await tmpDir('vidcut-leadpad-render-');
    await makeVideo(dir, 'v.mp4', { duration: 4, withAudio: true });
    const store = await ProjectStore.load(join(dir, 'project.json'));
    store.mutate('ai', 'seed', (d) => {
      d.canvas = { width: 320, height: 568, fps: 30 };
      d.media = [
        {
          id: 'mv',
          path: 'v.mp4',
          probe: { duration: 4, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
      // 時間軸長度 3s、leadPad 1s → 黑墊 [0,1)，內容 [1,3) 對應來源 in=0 起的 2s
      d.tracks.video = [{ id: 'c1', mediaId: 'mv', in: 0, duration: 3, leadPad: 1, volume: 1 }];
    });

    const res = await render(store, dir, 'leadpad-basic');
    const outAbs = join(dir, res.outPath);
    const info = await probe(outAbs);

    // 容器總時長＝時間軸長度（黑墊也計時），不因黑墊而縮短
    expect(info.duration).toBeGreaterThan(2.85);
    expect(info.duration).toBeLessThan(3.15);

    // 黑墊區間（0-1s）抽幀近乎全黑
    const padBrightness = await meanBrightnessAt(outAbs, 0.5, dir, 'leadpad-pad-frame');
    expect(padBrightness).toBeLessThan(10);

    // 內容區間（1-3s）已經是 testsrc2 的畫面，不再是黑——用平均亮度做粗略但穩定的判別
    // （testsrc2 本身不是全黑，均值明顯高於純黑墊）
    const contentBrightness = await meanBrightnessAt(outAbs, 2, dir, 'leadpad-content-frame');
    expect(contentBrightness).toBeGreaterThan(30);
  }, 180_000);

  it('內容段畫面＝pad 位移後的正確來源時刻（跟一支無 leadPad 但等效裁切的對照組逐幀相同）', async () => {
    const dir = await tmpDir('vidcut-leadpad-content-');
    await makeVideo(dir, 'v.mp4', { duration: 4, withAudio: true });
    const store = await ProjectStore.load(join(dir, 'project.json'));
    const seedMedia = (d: Parameters<Parameters<ProjectStore['mutate']>[2]>[0]) => {
      d.canvas = { width: 320, height: 568, fps: 30 };
      d.media = [
        {
          id: 'mv',
          path: 'v.mp4',
          probe: { duration: 4, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
    };
    store.mutate('ai', 'seed', (d) => {
      seedMedia(d);
      // 時間軸 0-3s、leadPad=1 → 內容時間軸座標 [1,3) 對應來源 [0,2)
      d.tracks.video = [{ id: 'c1', mediaId: 'mv', in: 0, duration: 3, leadPad: 1, volume: 1 }];
    });
    const res = await render(store, dir, 'leadpad-content');
    const outAbs = join(dir, res.outPath);

    // 對照組：同一支來源，直接從 in=0 剪 2s（沒有 leadPad），單獨渲染
    const dir2 = await tmpDir('vidcut-leadpad-ref-');
    await runFfmpeg(['-i', join(dir, 'v.mp4'), '-c', 'copy', join(dir2, 'v.mp4')]);
    const store2 = await ProjectStore.load(join(dir2, 'project.json'));
    store2.mutate('ai', 'seed', (d) => {
      seedMedia(d);
      d.media[0]!.path = 'v.mp4';
      d.tracks.video = [{ id: 'c1', mediaId: 'mv', in: 0, duration: 2, volume: 1 }];
    });
    const res2 = await render(store2, dir2, 'leadpad-ref');
    const outAbs2 = join(dir2, res2.outPath);

    // 時間軸時刻 2s（leadPad 版，內容播放 1s 之後）應等於對照組時刻 1s（播放 1s 之後）——
    // 兩者都對應來源 in=0 之後的第 1 秒。8x8 平均亮度做穩定但足夠的等值判別。
    const a = await meanBrightnessAt(outAbs, 2, dir, 'leadpad-content-a');
    const b = await meanBrightnessAt(outAbs2, 1, dir2, 'leadpad-content-b');
    expect(Math.abs(a - b)).toBeLessThan(5);
  }, 180_000);

  it('有聲 clip 的 leadPad：前置靜音，內容段音量恢復正常（adelay 前置靜音）', async () => {
    const dir = await tmpDir('vidcut-leadpad-audio-');
    await makeVideo(dir, 'v.mp4', { duration: 4, withAudio: true, freq: 440 });
    const store = await ProjectStore.load(join(dir, 'project.json'));
    store.mutate('ai', 'seed', (d) => {
      d.canvas = { width: 320, height: 568, fps: 30 };
      d.media = [
        {
          id: 'mv',
          path: 'v.mp4',
          probe: { duration: 4, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
      d.tracks.video = [{ id: 'c1', mediaId: 'mv', in: 0, duration: 3, leadPad: 1, volume: 1 }];
    });

    const res = await render(store, dir, 'leadpad-audio');
    const outAbs = join(dir, res.outPath);

    // 黑墊區間 [0,1) 應接近靜音（地板值附近，容許少量編碼雜訊）
    const padLevel = await rmsLevelDb(outAbs, 0.1, 0.7);
    expect(padLevel).toBeLessThan(-50);

    // 內容區間 [1,3) 應恢復正常音量（440Hz 正弦波，RMS 明顯高於地板）
    const contentLevel = await rmsLevelDb(outAbs, 1.2, 1.5);
    expect(contentLevel).toBeGreaterThan(-30);
  }, 180_000);

  it('frozen clip 帶 leadPad：黑墊之後才開始定格畫面', async () => {
    const dir = await tmpDir('vidcut-leadpad-frozen-');
    await makeVideo(dir, 'v.mp4', { duration: 4, withAudio: true });
    const store = await ProjectStore.load(join(dir, 'project.json'));
    store.mutate('ai', 'seed', (d) => {
      d.canvas = { width: 320, height: 568, fps: 30 };
      d.media = [
        {
          id: 'mv',
          path: 'v.mp4',
          probe: { duration: 4, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
      // frozen：黑墊 [0,1)，定格畫面（來源 in=2 那一幀）[1,3)
      d.tracks.video = [
        { id: 'f1', mediaId: 'mv', in: 2, duration: 3, leadPad: 1, frozen: true, volume: 0 },
      ];
    });

    const res = await render(store, dir, 'leadpad-frozen');
    const outAbs = join(dir, res.outPath);

    const padBrightness = await meanBrightnessAt(outAbs, 0.5, dir, 'leadpad-frozen-pad');
    expect(padBrightness).toBeLessThan(10);

    // 定格段（1-3s）任意兩個時刻的畫面必須完全相同（同一張靜圖）
    const f1 = await meanBrightnessAt(outAbs, 1.3, dir, 'leadpad-frozen-f1');
    const f2 = await meanBrightnessAt(outAbs, 2.7, dir, 'leadpad-frozen-f2');
    expect(Math.abs(f1 - f2)).toBeLessThan(2);
    // 且定格段本身不是黑（確實疊上了畫面，不是黑墊延續）
    expect(f1).toBeGreaterThan(30);
  }, 180_000);

  it('無 leadPad 的專案：render 完全不受影響（回歸釘，與現有黑尾測試同精神）', async () => {
    const dir = await tmpDir('vidcut-leadpad-noop-');
    await makeVideo(dir, 'v.mp4', { duration: 2, withAudio: true });
    const store = await ProjectStore.load(join(dir, 'project.json'));
    store.mutate('ai', 'seed', (d) => {
      d.canvas = { width: 320, height: 568, fps: 30 };
      d.media = [
        {
          id: 'mv',
          path: 'v.mp4',
          probe: { duration: 2, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
      d.tracks.video = [{ id: 'c1', mediaId: 'mv', in: 0, duration: 1, volume: 1 }];
    });
    const res = await render(store, dir, 'leadpad-noop');
    const info = await probe(join(dir, res.outPath));
    expect(info.duration).toBeGreaterThan(0.85);
    expect(info.duration).toBeLessThan(1.15);
  }, 120_000);
});

describe('extractFrame / renderCoverImage：黑墊回黑幀（Plan 14 Task 2）', () => {
  it('extractFrame 在黑墊段回黑幀，在內容段回正確來源畫面', async () => {
    const dir = await tmpDir('vidcut-leadpad-getframe-');
    await makeVideo(dir, 'a.mp4', { duration: 4, withAudio: true });
    const store = await ProjectStore.load(join(dir, 'project.json'));
    store.mutate('ai', 'seed', (d) => {
      d.media = [
        {
          id: 'm1',
          path: 'a.mp4',
          probe: { duration: 4, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
      d.tracks.video = [{ id: 'c1', mediaId: 'm1', in: 0, duration: 3, leadPad: 1, volume: 1 }];
    });

    // 黑墊段（時間軸 0.5s）
    const padRel = await extractFrame(dir, store.doc, 0.5);
    expect(padRel).not.toBeNull();
    const padInfo = await probe(join(dir, padRel!));
    // 黑幀維度採專案畫布尺寸（1080x1920，createEmptyProject / ProjectStore 預設）
    expect(padInfo.width).toBe(1080);
    expect(padInfo.height).toBe(1920);

    // 內容段（時間軸 2s，離黑墊已遠）：正常抽出片段畫面，維度＝畫布尺寸（render.ts 的
    // 縮放發生在 render 合成階段，get_frame 本身只抽 proxy/原檔單幀，不受影響）
    const contentRel = await extractFrame(dir, store.doc, 2);
    expect(contentRel).not.toBeNull();
    const contentInfo = await probe(join(dir, contentRel!));
    expect(contentInfo.width).toBeGreaterThan(0);
  }, 60_000);

  it('renderCoverImage（未渲染過）在黑墊段回黑幀、在內容段抽正確來源畫面', async () => {
    const dir = await tmpDir('vidcut-leadpad-cover-');
    await makeVideo(dir, 'a.mp4', { duration: 4, withAudio: true });
    const store = await ProjectStore.load(join(dir, 'project.json'));
    store.mutate('ai', 'seed', (d) => {
      d.canvas = { width: 320, height: 568, fps: 30 };
      d.media = [
        {
          id: 'm1',
          path: 'a.mp4',
          probe: { duration: 4, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
      d.tracks.video = [{ id: 'c1', mediaId: 'm1', in: 0, duration: 3, leadPad: 1, volume: 1 }];
    });

    const relPad = await renderCoverImage(store.doc, dir, 0.5); // 黑墊段
    const infoPad = await probe(join(dir, relPad));
    expect(infoPad.width).toBe(320);
    expect(infoPad.height).toBe(568);
    const padBrightness = await meanBrightnessOfImage(join(dir, relPad), dir, 'leadpad-cover-pad');
    expect(padBrightness).toBeLessThan(10);

    // relContent 與 relPad 是同一個固定路徑（output/cover.jpg，每次呼叫就地覆寫）——
    // 黑幀那次的量測已在上面完成讀取，這裡才呼叫第二次覆寫，沒有時序競爭。
    const relContent = await renderCoverImage(store.doc, dir, 2); // 內容段
    const contentBrightness = await meanBrightnessOfImage(
      join(dir, relContent),
      dir,
      'leadpad-cover-content',
    );
    expect(contentBrightness).toBeGreaterThan(30);
  }, 60_000);

  it('frozen clip 帶 leadPad：renderCoverImage 在內容段一律抽 in（定格幀語意），不是 clipSourceTime 的線性映射', async () => {
    const dir = await tmpDir('vidcut-leadpad-cover-frozen-');
    await makeVideo(dir, 'a.mp4', { duration: 4, withAudio: true });
    const store = await ProjectStore.load(join(dir, 'project.json'));
    store.mutate('ai', 'seed', (d) => {
      d.canvas = { width: 320, height: 568, fps: 30 };
      d.media = [
        {
          id: 'm1',
          path: 'a.mp4',
          probe: { duration: 4, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
      d.tracks.video = [
        { id: 'f1', mediaId: 'm1', in: 2, duration: 3, leadPad: 1, frozen: true, volume: 0 },
      ];
    });

    // 內容段兩個不同的時間軸時刻（1.2s、2.8s）都應抽到 in=2 那一幀——用平均亮度判別
    // 應該幾乎相同（都是同一張來源畫面），而不是隨時刻線性移動到不同來源時刻）。
    // 兩次呼叫就地覆寫同一個 output/cover.jpg：第一次的量測讀完才呼叫第二次，無時序競爭。
    const relA = await renderCoverImage(store.doc, dir, 1.2);
    const a = await meanBrightnessOfImage(join(dir, relA), dir, 'leadpad-cover-frozen-a');
    const relB = await renderCoverImage(store.doc, dir, 2.8);
    const b = await meanBrightnessOfImage(join(dir, relB), dir, 'leadpad-cover-frozen-b');
    expect(Math.abs(a - b)).toBeLessThan(2);
  }, 60_000);
});
