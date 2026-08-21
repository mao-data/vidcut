import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { render } from '../src/render.js';
import { ProjectStore } from '../src/store.js';
import { probe, runFfmpeg } from '../src/ffmpeg.js';
import { makeVideo } from './fixtures.js';
import { tmpDir } from './tmp.js';

/**
 * 抽某一時刻的單幀，8x8 downscale 成 raw rgb24 後回傳平均亮度（0–255）。用來判斷
 * 一幀是否接近全黑——用在「整幀應該接近純黑」的斷言（黑尾本身，沒有任何內容疊上）。
 * ⚠️ **不要**拿它來驗「小範圍內容有沒有疊上去」：字卡只佔畫面一小塊，8x8 平均池化
 * 會把它稀釋到跟純黑幾乎無法區分（實測 320x568 畫布上一張 320x84 白字卡，全幀平均
 * 只有 ~3.5，本地直接開圖驗證合成其實是對的）——那種情況改用 maxBrightnessInCrop
 * 只看內容應該出現的那個區域。
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
 * 抽某一時刻某個裁切區域的單幀，回傳裡面**最亮像素**的亮度（0–255）。用來驗「這個
 * 範圍裡有沒有疊上非黑內容」——小範圍的字卡/overlay 用平均值會被大片黑底稀釋掉
 * （見 meanBrightnessAt 的註解），改看峰值就穩定：有疊上內容 → 峰值接近白；
 * 純黑底 → 峰值也接近 0。
 */
async function maxBrightnessInCrop(
  videoPath: string,
  t: number,
  crop: string,
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
    `crop=${crop}`,
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    raw,
  ]);
  const buf = await readFile(raw);
  let max = 0;
  for (const b of buf) if (b > max) max = b;
  return max;
}

/** 探測音訊串流本身的時長（非容器 format.duration，兩者在部分封裝下可能不同源）。 */
async function audioStreamDuration(file: string): Promise<number> {
  const { spawn } = await import('node:child_process');
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=duration',
      '-print_format',
      'json',
      file,
    ]);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`ffprobe ${code}`))));
  });
  const data = JSON.parse(stdout) as { streams: Array<{ duration?: string }> };
  return Number(data.streams[0]?.duration ?? 0);
}

describe('render 黑尾整合測試（Plan 13 Task 2，真 ffmpeg）', () => {
  it('音訊超出主軌時：容器總時長=outputDuration、黑尾抽幀為黑、音訊不被剪到主軌總長', async () => {
    const dir = await tmpDir('vidcut-blacktail-audio-');
    await makeVideo(dir, 'v.mp4', { duration: 1, withAudio: true });
    await makeVideo(dir, 'bgm.mp4', { duration: 3, withAudio: true, freq: 220 });
    const store = await ProjectStore.load(join(dir, 'project.json'));
    store.mutate('ai', 'seed', (d) => {
      d.canvas = { width: 320, height: 568, fps: 30 };
      d.media = [
        {
          id: 'mv',
          path: 'v.mp4',
          probe: { duration: 1, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
        {
          id: 'mb',
          path: 'bgm.mp4',
          probe: { duration: 3, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
      // 主軌 1s；獨立音訊項從 0s 播 2s → outputDuration = 2
      d.tracks.video = [{ id: 'c1', mediaId: 'mv', in: 0, duration: 1, volume: 1 }];
      d.tracks.audio = [{ id: 'a1', mediaId: 'mb', start: 0, in: 0, duration: 2, volume: 1 }];
    });

    const res = await render(store, dir, 'tail-audio');
    const outAbs = join(dir, res.outPath);
    const info = await probe(outAbs);

    // 容器總時長 = outputDuration(2)，不是主軌總長(1)
    expect(info.duration).toBeGreaterThan(1.85);
    expect(info.duration).toBeLessThan(2.15);

    // 黑尾區間（1.5s，在主軌 1s 之後、outputDuration 2s 之前）抽幀近乎全黑
    const brightness = await meanBrightnessAt(outAbs, 1.5, dir, 'tail-audio-frame');
    expect(brightness).toBeLessThan(10);

    // 音訊串流本身沒有被剪到主軌總長(1s)，該有 ~2s
    const aDur = await audioStreamDuration(outAbs);
    expect(aDur).toBeGreaterThan(1.7);
  }, 180_000);

  it('caption/overlay 延伸到黑尾時，在黑尾區間照常合成（該時刻抽幀非全黑）', async () => {
    const dir = await tmpDir('vidcut-blacktail-caption-');
    await makeVideo(dir, 'v.mp4', { duration: 1, withAudio: true });
    const store = await ProjectStore.load(join(dir, 'project.json'));
    store.mutate('ai', 'seed', (d) => {
      d.canvas = { width: 320, height: 568, fps: 30 };
      d.media = [
        {
          id: 'mv',
          path: 'v.mp4',
          probe: { duration: 1, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
      // 主軌 1s；caption 延伸到 3s → outputDuration = 3，黑尾 (1,3]
      d.tracks.video = [{ id: 'c1', mediaId: 'mv', in: 0, duration: 1, volume: 1 }];
      d.tracks.captions = [
        {
          id: 'cap1',
          text: 'HELLO',
          start: 0,
          duration: 3,
          style: { fontFamily: 'sans-serif', fontSize: 64, fill: '#ffffff', y: 0.5 },
        },
      ];
    });

    const res = await render(store, dir, 'tail-caption');
    const outAbs = join(dir, res.outPath);

    // 字卡是白字、y=0.5（卡片上緣貼在畫布正中）。整幀平均會被大片黑底稀釋掉
    // （320x568 畫布上一張約 320x84 的字卡，全幀均值只有 ~3.5——本地開圖驗證過
    // 合成其實是對的，問題出在量測方式），改裁切卡片所在區域看峰值。
    const peak = await maxBrightnessInCrop(outAbs, 2, '320:100:0:270', dir, 'tail-caption-crop');
    expect(peak).toBeGreaterThan(200); // 白字峰值應接近 255；純黑底峰值接近 0
  }, 180_000);

  it('無黑尾（outputDuration===totalDuration）時渲染行為不變：容器時長=主軌總長', async () => {
    const dir = await tmpDir('vidcut-nooverhang-');
    await makeVideo(dir, 'v.mp4', { duration: 1, withAudio: true });
    const store = await ProjectStore.load(join(dir, 'project.json'));
    store.mutate('ai', 'seed', (d) => {
      d.canvas = { width: 320, height: 568, fps: 30 };
      d.media = [
        {
          id: 'mv',
          path: 'v.mp4',
          probe: { duration: 1, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
        },
      ];
      d.tracks.video = [{ id: 'c1', mediaId: 'mv', in: 0, duration: 1, volume: 1 }];
    });

    const res = await render(store, dir, 'no-overhang');
    const info = await probe(join(dir, res.outPath));
    expect(info.duration).toBeGreaterThan(0.85);
    expect(info.duration).toBeLessThan(1.15);
  }, 120_000);
});
