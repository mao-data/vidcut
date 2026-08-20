import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { probe, probeKeyframeInterval, runFfmpeg } from '../src/ffmpeg.js';
import { makeVideo, makeAudio } from './fixtures.js';
import { tmpDir } from './tmp.js';

describe('ffmpeg wrapper', () => {
  it('probe reads duration/size/fps/audio', async () => {
    const dir = await tmpDir('vidcut-ff-');
    const f = await makeVideo(dir, 'a.mp4', { duration: 3, withAudio: true });
    const p = await probe(f);
    expect(p.width).toBe(540);
    expect(p.height).toBe(960);
    expect(p.fps).toBeCloseTo(30, 0);
    expect(p.duration).toBeGreaterThan(2.5);
    expect(p.hasAudio).toBe(true);
    expect(p.rotation).toBe(0);
  }, 30_000);

  it('probe detects missing audio', async () => {
    const dir = await tmpDir('vidcut-ff-');
    const f = await makeVideo(dir, 'mute.mp4', { withAudio: false });
    expect((await probe(f)).hasAudio).toBe(false);
  }, 30_000);

  // Plan 8 final review F4：keyframeIntervalSec 量測（第二次 ffprobe，掃前 60 秒封包流）
  // 現在是 opt-in（`probe(file, { keyframes: true })`）——預設關閉，因為 render 路徑
  // 唯一需要 probe() 的地方（render.ts 的 withProbedChannels）只要 audioChannels，
  // 卻因為舊版無條件量測而白扛這筆成本。只有 prepareMedia（A0，決定 proxyPlan）該
  // 傳 keyframes:true。

  it('probe 預設（不傳 opts）不含 keyframeIntervalSec，即使來源有多個 keyframe 可量', async () => {
    // 用短 GOP 的來源確保「量得到」是可能的，藉此排除「本來就量不到」的混淆——
    // 拿到 undefined 必須是因為沒開 opt-in，不是因為來源條件不夠。
    const dir = await tmpDir('vidcut-ff-');
    const f = join(dir, 'a.mp4');
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=duration=3:size=540x960:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '15',
      '-c:a',
      'aac',
      '-shortest',
      f,
    ]);
    const p = await probe(f);
    expect(p.codec).toBe('h264');
    expect(p.pixFmt).toBe('yuv420p');
    expect(p.container).toBe('mov'); // ffprobe format_name 第一段（mp4 容器回報 mov,mp4,m4a,...）
    expect(p.keyframeIntervalSec).toBeUndefined();
  }, 30_000);

  it('probe({ keyframes: true }) 附帶 codec/pixFmt/container/keyframeIntervalSec（有視訊的檔案）', async () => {
    // makeVideo 預設用 libx264 內建 GOP（≈250 幀）,3 秒片在 60 秒量測窗內只有 1 個
    // keyframe,依規則量不出間距（見下方 probeKeyframeInterval 套件的 <2 個回
    // undefined）。這裡顯式帶 -g 15 讓量測窗內有多個 keyframe,才驗得到非 undefined。
    const dir = await tmpDir('vidcut-ff-');
    const f = join(dir, 'a.mp4');
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=duration=3:size=540x960:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '15',
      '-c:a',
      'aac',
      '-shortest',
      f,
    ]);
    const p = await probe(f, { keyframes: true });
    expect(p.codec).toBe('h264');
    expect(p.pixFmt).toBe('yuv420p');
    expect(p.container).toBe('mov'); // ffprobe format_name 第一段（mp4 容器回報 mov,mp4,m4a,...）
    expect(p.keyframeIntervalSec).toBeGreaterThan(0);
  }, 30_000);

  it('probe({ keyframes: true })：短片＋預設長 GOP（60 秒窗內僅 1 個 keyframe）時 keyframeIntervalSec 缺席', async () => {
    const dir = await tmpDir('vidcut-ff-');
    const f = await makeVideo(dir, 'a.mp4', { duration: 3, withAudio: true });
    const p = await probe(f, { keyframes: true });
    expect(p.codec).toBe('h264');
    expect(p.keyframeIntervalSec).toBeUndefined();
  }, 30_000);

  it('probe({ keyframes: true })：純音訊檔沒有 keyframeIntervalSec（undefined）', async () => {
    const dir = await tmpDir('vidcut-ff-');
    const f = await makeAudio(dir, 'a.wav', { duration: 2 });
    const p = await probe(f, { keyframes: true });
    expect(p.hasVideo).toBe(false);
    expect(p.keyframeIntervalSec).toBeUndefined();
  }, 30_000);

  it('runFfmpeg rejects with stderr on bad args', async () => {
    await expect(runFfmpeg(['-i', '/nonexistent.mp4', '/dev/null/out.mp4'])).rejects.toThrow(
      /nonexistent|No such file/i,
    );
  });
});

describe('probeKeyframeInterval', () => {
  it('短 GOP（-g 15,30fps→每 0.5s 一個 keyframe）：量測平均間距 ≈0.5', async () => {
    const dir = await tmpDir('vidcut-ff-');
    const f = join(dir, 'short-gop.mp4');
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=duration=10:size=540x960:rate=30',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '15',
      f,
    ]);
    const interval = await probeKeyframeInterval(f);
    expect(interval).toBeGreaterThan(0.4);
    expect(interval).toBeLessThan(0.7);
  }, 30_000);

  it('長 GOP（25s,30fps,-g 300→keyframe 落在 0/10/20s）：量測平均間距 ≥9', async () => {
    const dir = await tmpDir('vidcut-ff-');
    const f = join(dir, 'long-gop.mp4');
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=duration=25:size=540x960:rate=30',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '300',
      f,
    ]);
    const interval = await probeKeyframeInterval(f);
    expect(interval).toBeGreaterThanOrEqual(9);
  }, 30_000);

  it('無視訊檔回 undefined', async () => {
    const dir = await tmpDir('vidcut-ff-');
    const f = await makeAudio(dir, 'audio-only.wav', { duration: 2 });
    expect(await probeKeyframeInterval(f)).toBeUndefined();
  }, 30_000);
});
