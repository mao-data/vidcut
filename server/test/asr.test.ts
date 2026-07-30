import { describe, it, expect } from 'vitest';
import { buildAsrAudioArgs, parseWhisperJson, findWhisperModel, dtwPresetFor } from '../src/asr.js';
import { createEmptyProject, type Project } from '@vidcut/shared';

function projectWith(opts: { silentSecond?: boolean; frozen?: boolean; narration?: boolean } = {}) {
  const p: Project = createEmptyProject('p', 't');
  p.media = [
    {
      id: 'm1',
      path: 'a.mp4',
      probe: { duration: 10, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
    },
    {
      id: 'm2',
      path: 'mute.mp4',
      probe: { duration: 10, width: 540, height: 960, fps: 30, hasAudio: false, rotation: 0 },
    },
    {
      id: 'vo',
      path: 'vo.mp3',
      probe: { duration: 30, width: 0, height: 0, fps: 0, hasAudio: true, rotation: 0 },
    },
  ];
  p.tracks.video = [
    // volume 0：被靜音的片段，ASR 仍該讀它（辨識優先於混音）
    { id: 'c1', mediaId: 'm1', in: 1, duration: 3, volume: 0 },
  ];
  if (opts.silentSecond) {
    p.tracks.video.push({ id: 'c2', mediaId: 'm2', in: 0, duration: 2, volume: 1 });
  }
  if (opts.frozen) {
    p.tracks.video.push({ id: 'c3', mediaId: 'm1', in: 5, duration: 1, volume: 1, frozen: true });
  }
  if (opts.narration) {
    p.tracks.audio = [
      { id: 'a1', mediaId: 'vo', start: 2, in: 0, duration: 4, volume: 0.2, ducking: true },
    ];
  }
  return p;
}

describe('buildAsrAudioArgs', () => {
  it('outputs 16k mono pcm wav', () => {
    const args = buildAsrAudioArgs(projectWith(), '/proj', '/proj/derived/asr.wav');
    expect(args).toContain('-vn');
    expect(args.join(' ')).toContain('-ac 1 -ar 16000 -c:a pcm_s16le');
    expect(args[args.length - 1]).toBe('/proj/derived/asr.wav');
  });

  it('ignores clip volume so muted clips still get transcribed', () => {
    const fc = fcOf(buildAsrAudioArgs(projectWith(), '/proj', 'o.wav'));
    expect(fc).not.toContain('volume=');
  });

  it('pads silent and frozen clips with anullsrc to keep timeline alignment', () => {
    const p = projectWith({ silentSecond: true, frozen: true });
    const args = buildAsrAudioArgs(p, '/proj', 'o.wav');
    const fc = fcOf(args);
    // 只有 c1 有真的音軌 → 只有 1 個 input
    expect(args.filter((a) => a === '-i')).toHaveLength(1);
    expect(fc.match(/anullsrc/g)).toHaveLength(2);
    expect(fc).toContain('concat=n=3:v=0:a=1[aclips]');
  });

  it('mixes narration at its absolute start, ignoring its volume and ducking', () => {
    const args = buildAsrAudioArgs(projectWith({ narration: true }), '/proj', 'o.wav');
    const fc = fcOf(args);
    expect(args.filter((a) => a === '-i')).toHaveLength(2);
    expect(fc).toContain('adelay=2000');
    expect(fc).toContain('amix=inputs=2:normalize=0:dropout_transition=0[aout]');
    expect(fc).not.toContain('volume=0.2');
  });

  it('passes a single source straight through instead of amix', () => {
    expect(fcOf(buildAsrAudioArgs(projectWith(), '/proj', 'o.wav'))).toContain(
      '[aclips]anull[aout]',
    );
  });

  it('throws a readable error when there is nothing to transcribe', () => {
    const p = createEmptyProject('p', 't');
    expect(() => buildAsrAudioArgs(p, '/proj', 'o.wav')).toThrow(/沒有任何聲音/);
  });
});

function fcOf(args: string[]): string {
  return args[args.indexOf('-filter_complex') + 1]!;
}

describe('dtwPresetFor', () => {
  it('maps model filenames to whisper.cpp aheads presets', () => {
    expect(dtwPresetFor('/m/ggml-large-v3-turbo-q5_0.bin')).toBe('large.v3.turbo');
    expect(dtwPresetFor('/m/ggml-large-v3.bin')).toBe('large.v3');
    expect(dtwPresetFor('/m/ggml-medium.en.bin')).toBe('medium.en');
    expect(dtwPresetFor('/m/ggml-small.bin')).toBe('small');
  });

  it('returns null for an unrecognised model so we fall back instead of erroring', () => {
    expect(dtwPresetFor('/m/my-custom-model.bin')).toBeNull();
  });
});

describe('parseWhisperJson (segment level, no tokens)', () => {
  const sample = JSON.stringify({
    result: { language: 'zh' },
    transcription: [
      { offsets: { from: 0, to: 400 }, text: ' 這' },
      { offsets: { from: 400, to: 720 }, text: '隻' },
      { offsets: { from: 720, to: 1000 }, text: '' },
      { offsets: { from: 1000, to: 1500 }, text: '貓' },
    ],
  });

  it('maps ms offsets to seconds and trims text', () => {
    const { words } = parseWhisperJson(sample);
    expect(words).toEqual([
      { text: '這', start: 0, end: 0.4 },
      { text: '隻', start: 0.4, end: 0.72 },
      { text: '貓', start: 1.0, end: 1.5 },
    ]);
  });

  it('reads the detected language', () => {
    expect(parseWhisperJson(sample).language).toBe('zh');
  });

  it('survives missing fields', () => {
    expect(parseWhisperJson('{}')).toEqual({ language: 'unknown', words: [] });
  });
});

describe('parseWhisperJson (token level with DTW)', () => {
  /** 取自 whisper.cpp 1.9.1 的真實輸出形狀：offsets 尾段整批退化，t_dtw 仍正確。 */
  const realShape = JSON.stringify({
    result: { language: 'en' },
    transcription: [
      {
        offsets: { from: 10, to: 12390 },
        text: ' this cat is unhinged. watch until the end',
        tokens: [
          { text: ' this', offsets: { from: 10, to: 630 }, t_dtw: 16 },
          { text: ' cat', offsets: { from: 630, to: 1090 }, t_dtw: 48 },
          { text: ' is', offsets: { from: 1150, to: 1410 }, t_dtw: 68 },
          // 子詞會被併回一個詞
          { text: ' un', offsets: { from: 2990, to: 3240 }, t_dtw: 142 },
          { text: 'hing', offsets: { from: 3300, to: 3860 }, t_dtw: 164 },
          { text: 'ed', offsets: { from: 4120, to: 4240 }, t_dtw: 184 },
          { text: '.', offsets: { from: 4240, to: 4650 }, t_dtw: 198 },
          // 以下 offsets 全部退化成 12390，但 t_dtw 正常
          { text: ' watch', offsets: { from: 12390, to: 12390 }, t_dtw: 860 },
          { text: ' until', offsets: { from: 12390, to: 12390 }, t_dtw: 884 },
          { text: ' the', offsets: { from: 12390, to: 12390 }, t_dtw: 904 },
          { text: ' end', offsets: { from: 12390, to: 12390 }, t_dtw: 934 },
          { text: '[_EOT_]', offsets: { from: 30000, to: 30000 }, t_dtw: -1 },
        ],
      },
    ],
  });

  it('uses t_dtw so the degenerate tail offsets do not collapse the words', () => {
    const { words } = parseWhisperJson(realShape);
    expect(words.map((w) => w.text)).toEqual([
      'this',
      'cat',
      'is',
      'unhinged.',
      'watch',
      'until',
      'the',
      'end',
    ]);
    // 尾段照 t_dtw（8.60/8.84/9.04/9.34），不是全部 12.39
    expect(words.slice(4).map((w) => w.start)).toEqual([8.6, 8.84, 9.04, 9.34]);
  });

  it('ends each word where the next one starts', () => {
    const { words } = parseWhisperJson(realShape);
    expect(words[0]).toEqual({ text: 'this', start: 0.16, end: 0.48 });
    // 最後一個詞收在 segment 結束
    expect(words[words.length - 1]!.end).toBe(12.39);
  });

  it('drops whisper special tokens', () => {
    expect(parseWhisperJson(realShape).words.some((w) => w.text.includes('EOT'))).toBe(false);
  });

  it('treats each CJK token as its own word (no spaces to split on)', () => {
    const cjk = JSON.stringify({
      result: { language: 'zh' },
      transcription: [
        {
          offsets: { from: 0, to: 1200 },
          text: '這隻貓',
          tokens: [
            { text: '這', t_dtw: 10 },
            { text: '隻', t_dtw: 40 },
            { text: '貓', t_dtw: 70 },
          ],
        },
      ],
    });
    expect(parseWhisperJson(cjk).words).toEqual([
      { text: '這', start: 0.1, end: 0.4 },
      { text: '隻', start: 0.4, end: 0.7 },
      { text: '貓', start: 0.7, end: 1.2 },
    ]);
  });

  it('falls back to token offsets when t_dtw is unavailable', () => {
    const noDtw = JSON.stringify({
      transcription: [
        {
          offsets: { from: 0, to: 900 },
          tokens: [
            { text: ' hi', offsets: { from: 100, to: 400 } },
            { text: ' there', offsets: { from: 400, to: 900 } },
          ],
        },
      ],
    });
    expect(parseWhisperJson(noDtw).words).toEqual([
      { text: 'hi', start: 0.1, end: 0.4 },
      { text: 'there', start: 0.4, end: 0.9 },
    ]);
  });
});

describe('findWhisperModel', () => {
  it('returns null for a bogus VIDCUT_WHISPER_MODEL instead of a broken path', () => {
    const prev = process.env.VIDCUT_WHISPER_MODEL;
    process.env.VIDCUT_WHISPER_MODEL = '/nope/model.bin';
    try {
      expect(findWhisperModel()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.VIDCUT_WHISPER_MODEL;
      else process.env.VIDCUT_WHISPER_MODEL = prev;
    }
  });
});
