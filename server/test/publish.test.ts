// 發佈包：命令層（Task 1）＋純函數（Task 2）＋檔案打包（Task 3）的測試都收在這裡。
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { applyCommand } from '../src/commands.js';
import { tmpDir } from './tmp.js';
import type { PublishInfo } from '@vidcut/shared';

function info(over: Partial<PublishInfo> = {}): PublishInfo {
  return {
    dir: 'output/publish/r1',
    stamp: 'r1',
    platforms: ['tiktok'],
    files: ['output/publish/r1/video.mp4', 'output/publish/r1/manifest.json'],
    warnings: [],
    createdAt: '2026-08-21T00:00:00.000Z',
    ...over,
  };
}

describe('setPublish command', () => {
  let store: ProjectStore;
  beforeEach(async () => {
    store = await ProjectStore.load(join(await tmpDir('vidcut-publish-cmd-'), 'project.json'));
  });

  it('records publish info under render.publish', () => {
    const r = applyCommand(store, 'ai', { name: 'setPublish', info: info() });
    expect(r.ok).toBe(true);
    expect(store.doc.render.publish).toEqual(info());
  });

  it('rejects empty dir', () => {
    const r = applyCommand(store, 'ai', { name: 'setPublish', info: info({ dir: '' }) });
    expect(r).toEqual({ ok: false, error: 'publish dir must not be empty' });
  });

  it('rejects empty platforms', () => {
    const r = applyCommand(store, 'ai', { name: 'setPublish', info: info({ platforms: [] }) });
    expect(r).toEqual({ ok: false, error: 'publish platforms must not be empty' });
  });

  it('does not enter the undo stack (render path is not undoable)', () => {
    applyCommand(store, 'ai', { name: 'setPublish', info: info() });
    const r = applyCommand(store, 'human', { name: 'undo' });
    expect(r).toEqual({ ok: false, error: 'nothing to undo' });
  });
});

import { metaToText, platformWarnings, resolveKind, UPLOAD_URLS } from '../src/publish.js';

describe('resolveKind', () => {
  it('defaults: youtube→short, facebook→video', () => {
    expect(resolveKind('youtube')).toBe('short');
    expect(resolveKind('facebook')).toBe('video');
  });
  it('honours an explicit kind the platform supports', () => {
    expect(resolveKind('youtube', 'video')).toBe('video');
    expect(resolveKind('facebook', 'short')).toBe('short');
  });
  it('tiktok/instagram only have short (video falls back)', () => {
    expect(resolveKind('tiktok', 'video')).toBe('short');
    expect(resolveKind('instagram', 'video')).toBe('short');
  });
});

describe('platformWarnings', () => {
  it('is empty within limits', () => {
    expect(platformWarnings('tiktok', 'short', 60, 10_000_000)).toEqual([]);
  });
  it('warns when a YouTube short exceeds 180s', () => {
    const w = platformWarnings('youtube', 'short', 181, 10_000_000);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('180');
  });
  it('a long YouTube video is clean (kind video lifts the Shorts limit)', () => {
    expect(platformWarnings('youtube', 'video', 3600, 10_000_000)).toEqual([]);
  });
  it('facebook video allows 240min but warns beyond', () => {
    expect(platformWarnings('facebook', 'video', 14_000, 10_000_000)).toEqual([]);
    expect(platformWarnings('facebook', 'video', 15_000, 10_000_000)).toHaveLength(1);
  });
  it('facebook reels (short) warns over 90s', () => {
    expect(platformWarnings('facebook', 'short', 91, 10_000_000)).toHaveLength(1);
  });
  it('warns on oversize file for instagram (1 GiB)', () => {
    const w = platformWarnings('instagram', 'short', 60, 2 * 2 ** 30);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('GiB');
  });
});

describe('metaToText', () => {
  it('joins title, body and hashtags with blank lines', () => {
    expect(metaToText({ title: 'T', body: 'B', hashtags: ['a', 'b'] })).toBe('T\n\nB\n\n#a #b');
  });
  it('omits missing title and hashtags', () => {
    expect(metaToText({ body: 'only body' })).toBe('only body');
  });
});

describe('UPLOAD_URLS', () => {
  it('covers every platform', () => {
    expect(Object.keys(UPLOAD_URLS).sort()).toEqual(['facebook', 'instagram', 'tiktok', 'youtube']);
  });
});
