import { describe, it, expect } from 'vitest';
import { serializeSrt, serializeVtt } from './subtitles.js';
import { DEFAULT_CAPTION_STYLE } from './captions.js';
import type { CaptionItem } from './types.js';

const cap = (id: string, text: string, start: number, duration: number): CaptionItem => ({
  id,
  text,
  start,
  duration,
  style: DEFAULT_CAPTION_STYLE,
});

describe('serializeSrt', () => {
  it('writes numbered blocks with HH:MM:SS,mmm timestamps', () => {
    const out = serializeSrt([cap('a', '你好', 3661.5, 2.25)]);
    expect(out).toBe('1\n01:01:01,500 --> 01:01:03,750\n你好\n');
  });

  it('sorts by start time and renumbers accordingly', () => {
    const out = serializeSrt([cap('b', 'second', 5, 1), cap('a', 'first', 1, 1)]);
    expect(out).toBe(
      '1\n00:00:01,000 --> 00:00:02,000\nfirst\n\n2\n00:00:05,000 --> 00:00:06,000\nsecond\n',
    );
  });

  it('drops blank-text and non-positive-duration captions', () => {
    const out = serializeSrt([
      cap('a', '   ', 0, 1),
      cap('b', 'kept', 1, 1),
      cap('c', 'zero length', 2, 0),
    ]);
    expect(out).toBe('1\n00:00:01,000 --> 00:00:02,000\nkept\n');
  });

  it('returns an empty string when nothing survives filtering', () => {
    expect(serializeSrt([cap('a', '', 0, 1)])).toBe('');
  });
});

describe('serializeVtt', () => {
  it('writes a WEBVTT header and dot-separated milliseconds, without cue numbers', () => {
    const out = serializeVtt([cap('a', 'hi', 1.5, 1)]);
    expect(out).toBe('WEBVTT\n\n00:00:01.500 --> 00:00:02.500\nhi\n');
  });

  it('emits a header-only file when there are no usable captions', () => {
    expect(serializeVtt([])).toBe('WEBVTT\n');
  });
});
