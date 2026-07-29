import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe, runFfmpeg } from '../src/ffmpeg.js';
import { makeVideo } from './fixtures.js';

describe('ffmpeg wrapper', () => {
  it('probe reads duration/size/fps/audio', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-ff-'));
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
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-ff-'));
    const f = await makeVideo(dir, 'mute.mp4', { withAudio: false });
    expect((await probe(f)).hasAudio).toBe(false);
  }, 30_000);

  it('runFfmpeg rejects with stderr on bad args', async () => {
    await expect(runFfmpeg(['-i', '/nonexistent.mp4', '/dev/null/out.mp4'])).rejects.toThrow(
      /nonexistent|No such file/i,
    );
  });
});
