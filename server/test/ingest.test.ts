import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { ingestMedia } from '../src/ingest.js';
import { probe } from '../src/ffmpeg.js';
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
});
