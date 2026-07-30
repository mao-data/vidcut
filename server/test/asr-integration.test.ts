import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCaptionPages, createEmptyProject, type Project } from '@vidcut/shared';
import { runFfmpeg } from '../src/ffmpeg.js';
import { probe } from '../src/ffmpeg.js';
import { findWhisperBinary, findWhisperModel, transcribe } from '../src/asr.js';

const hasSay = spawnSync('which', ['say']).status === 0;
const hasWhisper = findWhisperBinary() !== null && findWhisperModel() !== null;

/**
 * 真的跑一次 whisper。需要 whisper.cpp + 模型 + macOS 的 say，缺任何一項就跳過
 * （CI 或別台機器不該因為沒裝 ASR 而紅）。
 */
describe.skipIf(!hasSay || !hasWhisper)('transcribe (integration, needs whisper.cpp)', () => {
  it('gives monotonic word timestamps inside the timeline duration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-asr-'));
    // 太短的音訊 whisper 的時間戳會退化（見 normalizeWords 註解），所以講久一點
    spawnSync('say', [
      '-r',
      '170',
      '-o',
      join(dir, 'speech.aiff'),
      'This cat is completely unhinged. I cannot believe what happened next. ' +
        'The ranking starts at number five, and honestly, number one broke me.',
    ]);
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=0x101820:s=540x960:r=30',
      '-i',
      join(dir, 'speech.aiff'),
      '-shortest',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      join(dir, 'talk.mp4'),
    ]);
    const info = await probe(join(dir, 'talk.mp4'));

    const p: Project = createEmptyProject('p', 't');
    p.media = [{ id: 'm1', path: 'talk.mp4', probe: info }];
    p.tracks.video = [{ id: 'c1', mediaId: 'm1', in: 0, duration: info.duration, volume: 1 }];

    const r = await transcribe(p, dir, { language: 'en' });

    expect(r.words.length).toBeGreaterThan(15);
    expect(r.text.toLowerCase()).toContain('unhinged');
    // 時間必須遞增且落在片長內——這正是 t_dtw 修掉的兩個病態
    let prev = -1;
    for (const w of r.words) {
      expect(w.start).toBeGreaterThanOrEqual(prev);
      expect(w.end).toBeLessThanOrEqual(info.duration + 1e-6);
      expect(w.end).toBeGreaterThan(w.start);
      prev = w.start;
    }
    // 最後一個詞不該卡在開頭（尾段退化的症狀）
    expect(r.words[r.words.length - 1]!.start).toBeGreaterThan(info.duration * 0.5);

    // 分頁後每句都要有 tokens 才能做逐詞高亮
    const captions = buildCaptionPages(r.words);
    expect(captions.length).toBeGreaterThan(3);
    for (const c of captions) expect(c.tokens!.length).toBeGreaterThan(0);
  }, 180_000);
});
