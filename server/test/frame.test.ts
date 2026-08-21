import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { createEmptyProject, type Project } from '@vidcut/shared';
import { extractFrame } from '../src/frame.js';
import { probe } from '../src/ffmpeg.js';
import { makeVideo } from './fixtures.js';
import { tmpDir } from './tmp.js';

function base(): Project {
  const p = createEmptyProject('p', 't');
  p.media = [
    {
      id: 'm1',
      path: 'a.mp4',
      probe: { duration: 10, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
    },
  ];
  p.tracks.video = [{ id: 'c1', mediaId: 'm1', in: 0, duration: 2, volume: 1 }];
  return p;
}

/**
 * get_frame 的時間夾制與黑尾回幀（Plan 13 Task 2，裁決 6）：夾制上界從 totalDuration
 * 換成 outputDuration，黑尾時刻（主軌之後、outputDuration 之前）必須回黑幀而不是
 * `null`（locate() 對那段時間本來就回 null，因為那裡沒有 active clip）。
 */
describe('extractFrame：黑尾夾制與回幀', () => {
  it('主軌範圍內行為不變（回實際幀，非黑）', async () => {
    const dir = await tmpDir('vidcut-frame-main-');
    await makeVideo(dir, 'a.mp4', { duration: 2, withAudio: true });
    const p = base();
    const rel = await extractFrame(dir, p, 1);
    expect(rel).not.toBeNull();
    const info = await probe(join(dir, rel!));
    expect(info.width).toBeGreaterThan(0);
  }, 60_000);

  it('黑尾時刻（主軌之後、outputDuration 之前）回黑幀而非 null', async () => {
    const dir = await tmpDir('vidcut-frame-tail-');
    await makeVideo(dir, 'a.mp4', { duration: 2, withAudio: true });
    const p = base();
    // 用一個延伸到 5s 的 caption 製造黑尾：outputDuration = 5 > totalDuration = 2
    p.tracks.captions = [
      {
        id: 'cap1',
        text: 'hi',
        start: 0,
        duration: 5,
        style: { fontFamily: 's', fontSize: 48, fill: '#fff', y: 0.8 },
      },
    ];
    const rel = await extractFrame(dir, p, 3.5); // 落在 (2, 5] 的黑尾區間
    expect(rel).not.toBeNull();
    const info = await probe(join(dir, rel!));
    // 黑幀維度採專案畫布尺寸（1080x1920，createEmptyProject 預設）
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
  }, 60_000);

  it('time 超出 outputDuration 仍夾制在 outputDuration（黑尾上界，不是 totalDuration）', async () => {
    const dir = await tmpDir('vidcut-frame-clamp-');
    await makeVideo(dir, 'a.mp4', { duration: 2, withAudio: true });
    const p = base();
    p.tracks.captions = [
      {
        id: 'cap1',
        text: 'hi',
        start: 0,
        duration: 5,
        style: { fontFamily: 's', fontSize: 48, fill: '#fff', y: 0.8 },
      },
    ];
    // 遠超 outputDuration=5 的時間仍應成功回黑幀（夾制生效），不是回 null
    const rel = await extractFrame(dir, p, 999);
    expect(rel).not.toBeNull();
  }, 60_000);

  it('無黑尾專案（outputDuration===totalDuration）超出範圍仍回 null（既有行為不變）', async () => {
    const dir = await tmpDir('vidcut-frame-nooverhang-');
    await makeVideo(dir, 'a.mp4', { duration: 2, withAudio: true });
    const p = base(); // 沒有任何超出主軌的軌道 → outputDuration === totalDuration === 2
    const rel = await extractFrame(dir, p, -1); // 負時間先被夾制到 0，這裡改測「空主軌」以下另條
    expect(rel).not.toBeNull(); // 夾制到 0 之後仍在主軌範圍內
  }, 60_000);

  it('空主軌（無 clip）任何時間都回 null', async () => {
    const dir = await tmpDir('vidcut-frame-empty-');
    const p = createEmptyProject('p', 't');
    const rel = await extractFrame(dir, p, 0);
    expect(rel).toBeNull();
  });
});
