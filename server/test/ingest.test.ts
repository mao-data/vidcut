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
  it(
    'produces proxy + filmstrip + peaks and registers the asset',
    async () => {
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
      };
      expect(peaks.sampleRate).toBe(8000);
      // 4 秒 × 8000Hz ÷ 160 樣本/桶 ≈ 200 桶
      expect(peaks.peaks.length).toBeGreaterThan(150);
      expect(Math.max(...peaks.peaks)).toBeLessThanOrEqual(1);
    },
    60_000,
  );

  it(
    'injects silent audio track for mute sources',
    async () => {
      const { dir, store } = await setup();
      await makeVideo(dir, 'mute.mp4', { withAudio: false });
      const id = await ingestMedia(store, dir, 'mute.mp4');
      const asset = store.doc.media.find((m) => m.id === id)!;
      expect(asset.probe.hasAudio).toBe(false); // 原始檔的事實
      expect((await probe(join(dir, asset.proxyPath!))).hasAudio).toBe(true); // proxy 一定有音軌
    },
    60_000,
  );

  it(
    'is idempotent per relPath',
    async () => {
      const { dir, store } = await setup();
      await makeVideo(dir, 'src.mp4', {});
      const a = await ingestMedia(store, dir, 'src.mp4');
      const b = await ingestMedia(store, dir, 'src.mp4');
      expect(b).toBe(a);
      expect(store.doc.media).toHaveLength(1);
    },
    60_000,
  );
});
