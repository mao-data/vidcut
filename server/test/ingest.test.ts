import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { ingestMedia } from '../src/ingest.js';
import { probe, runFfmpeg } from '../src/ffmpeg.js';
import { makeVideo } from './fixtures.js';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-ingest-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
  return { dir, store };
}

describe('ingestMedia', () => {
  it('produces proxy + filmstrip + peaks and registers the asset', async () => {
    const { dir, store } = await setup();
    await makeVideo(dir, 'src.mp4', { duration: 4, withAudio: true });
    const id = await ingestMedia(store, dir, 'src.mp4', { label: 'N1' });

    const asset = store.doc.media.find((m) => m.id === id)!;
    expect(asset.label).toBe('N1');
    expect(asset.probe.hasAudio).toBe(true);

    const proxy = await probe(join(dir, asset.proxyPath!));
    expect(proxy.height).toBe(960);
    expect(proxy.hasAudio).toBe(true);

    expect((await stat(join(dir, asset.filmstripPath!))).size).toBeGreaterThan(0);

    const peaks = JSON.parse(await readFile(join(dir, asset.peaksPath!), 'utf8')) as {
      samplesPerBucket: number;
      sampleRate: number;
      peaks: number[];
      rms?: number[];
    };
    expect(peaks.sampleRate).toBe(8000);
    // 100 桶/秒（8000 ÷ 80）；4 秒 ≈ 400 桶
    expect(peaks.sampleRate / peaks.samplesPerBucket).toBe(100);
    expect(peaks.peaks.length).toBeGreaterThan(300);
    expect(Math.max(...peaks.peaks)).toBeLessThanOrEqual(1);

    // RMS：與 peaks 等長、逐桶 ≤ peak
    expect(peaks.rms).toBeDefined();
    expect(peaks.rms!.length).toBe(peaks.peaks.length);
    for (let i = 0; i < peaks.peaks.length; i++) {
      expect(peaks.rms![i]!).toBeLessThanOrEqual(peaks.peaks[i]! + 1e-9);
    }
    // 正弦波 RMS ≈ peak/√2 ≈ 0.707：抽最響的桶（≥80% 最大峰值）驗證比值合理
    const maxPeak = Math.max(...peaks.peaks);
    expect(maxPeak).toBeGreaterThan(0);
    const loud = peaks.peaks
      .map((p, i) => [p, peaks.rms![i]!] as const)
      .filter(([p]) => p >= maxPeak * 0.8);
    expect(loud.length).toBeGreaterThan(0);
    for (const [p, r] of loud) expect(r / p).toBeGreaterThan(0.4);
  }, 60_000);

  it('injects silent audio track for mute sources', async () => {
    const { dir, store } = await setup();
    await makeVideo(dir, 'mute.mp4', { withAudio: false });
    const id = await ingestMedia(store, dir, 'mute.mp4');
    const asset = store.doc.media.find((m) => m.id === id)!;
    expect(asset.probe.hasAudio).toBe(false); // 原始檔的事實
    expect((await probe(join(dir, asset.proxyPath!))).hasAudio).toBe(true); // proxy 一定有音軌
  }, 60_000);

  it('is idempotent per relPath', async () => {
    const { dir, store } = await setup();
    await makeVideo(dir, 'src.mp4', {});
    const a = await ingestMedia(store, dir, 'src.mp4');
    const b = await ingestMedia(store, dir, 'src.mp4');
    expect(b).toBe(a);
    expect(store.doc.media).toHaveLength(1);
  }, 60_000);

  it('可以 ingest 專案資料夾外的絕對路徑，原檔不被複製', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vidcut-outside-'));
    const src = join(outside, 'external.mp4');
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

    const dir = await mkdtemp(join(tmpdir(), 'vidcut-proj-'));
    const store = await ProjectStore.load(join(dir, 'project.json'));
    const id = await ingestMedia(store, dir, src);

    const m = store.doc.media.find((x) => x.id === id)!;
    expect(m.path).toBe(src); // 絕對路徑原樣保存
    expect(existsSync(join(dir, 'external.mp4'))).toBe(false); // 沒有複製進專案
    expect(m.proxyPath).toBeDefined();
    expect(existsSync(join(dir, m.proxyPath!))).toBe(true); // 衍生檔仍在專案內
  }, 60_000);

  it('同一個絕對路徑重複 ingest 回同一個 id', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vidcut-outside2-'));
    const src = join(outside, 'dup.mp4');
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
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-proj2-'));
    const store = await ProjectStore.load(join(dir, 'project.json'));
    const a = await ingestMedia(store, dir, src);
    const b = await ingestMedia(store, dir, src);
    expect(b).toBe(a);
    expect(store.doc.media).toHaveLength(1);
  }, 60_000);
});
