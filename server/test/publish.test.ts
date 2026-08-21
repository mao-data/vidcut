// 發佈包：命令層（Task 1）＋純函數（Task 2）＋檔案打包（Task 3）的測試都收在這裡。
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { applyCommand } from '../src/commands.js';
import { tmpDir } from './tmp.js';
import { buildPublishPackage } from '../src/publish.js';
import { createEmptyProject } from '@vidcut/shared';
import type { PublishInfo, Project } from '@vidcut/shared';

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

/** 假成品：不跑真 render——打包只做複製與 stat，手寫檔案即可。 */
async function doneProject(dir: string): Promise<Project> {
  const doc = createEmptyProject('p', 'p');
  doc.tracks.video = [{ id: 'c1', mediaId: 'm1', in: 0, duration: 200, volume: 1 }];
  doc.tracks.captions = [
    {
      id: 'cap1',
      text: 'hello',
      start: 0,
      duration: 2,
      style: { fontFamily: 'sans-serif', fontSize: 48, fill: '#fff', y: 0.8 },
    },
  ];
  await mkdir(join(dir, 'output'), { recursive: true });
  await writeFile(join(dir, 'output', 'r1.mp4'), Buffer.alloc(1024, 1));
  doc.render = { status: 'done', lastOutput: join('output', 'r1.mp4') };
  return doc;
}

describe('buildPublishPackage', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tmpDir('vidcut-publish-pkg-');
  });

  it('copies video, writes srt + per-platform txt + manifest, aggregates warnings by kind', async () => {
    const doc = await doneProject(dir);
    const info = await buildPublishPackage(dir, doc, {
      tiktok: { body: 'hi', hashtags: ['fyp'] },
      youtube: { title: 'T', body: 'D' },
      facebook: { title: 'F', body: 'long form' },
    });
    expect(info.dir).toBe(join('output', 'publish', 'r1'));
    expect(info.platforms).toEqual(['tiktok', 'youtube', 'facebook']);
    for (const f of info.files) expect(existsSync(join(dir, f))).toBe(true);
    const names = info.files.map((f) => f.split('/').pop());
    expect(names).toContain('video.mp4');
    expect(names).toContain('subtitles.srt');
    expect(names).toContain('tiktok.txt');
    expect(names).toContain('youtube.txt');
    expect(names).toContain('facebook.txt');
    expect(names).toContain('manifest.json');
    expect(names).not.toContain('cover.jpg'); // 沒設封面就不該有
    // timeline 200s：youtube 預設 short 超 180s 要警告；tiktok（600s 內）與
    // facebook（預設 video，240min 內）不該有
    expect(info.warnings.some((w) => w.startsWith('youtube:'))).toBe(true);
    expect(info.warnings.some((w) => w.startsWith('tiktok:'))).toBe(false);
    expect(info.warnings.some((w) => w.startsWith('facebook:'))).toBe(false);
    const manifest = JSON.parse(await readFile(join(dir, info.dir, 'manifest.json'), 'utf8')) as {
      platforms: Record<string, { uploadUrl: string; kind: string }>;
    };
    expect(manifest.platforms.tiktok!.uploadUrl).toBe(UPLOAD_URLS.tiktok);
    expect(manifest.platforms.facebook!.kind).toBe('video');
    expect(manifest.platforms.youtube!.kind).toBe('short');
  });

  it('kind: video lifts the YouTube Shorts warning for long videos', async () => {
    const doc = await doneProject(dir); // timeline 200s
    const info = await buildPublishPackage(dir, doc, {
      youtube: { title: 'T', body: 'D', kind: 'video' },
    });
    expect(info.warnings).toEqual([]);
  });

  it('repackaging drops files from platforms no longer requested', async () => {
    const doc = await doneProject(dir);
    await buildPublishPackage(dir, doc, { tiktok: { body: 'a' } });
    const info = await buildPublishPackage(dir, doc, { youtube: { title: 'T', body: 'b' } });
    expect(existsSync(join(dir, info.dir, 'tiktok.txt'))).toBe(false);
    expect(existsSync(join(dir, info.dir, 'youtube.txt'))).toBe(true);
  });

  it('throws before a finished render', async () => {
    const doc = createEmptyProject('p', 'p');
    await expect(buildPublishPackage(dir, doc, { tiktok: { body: 'x' } })).rejects.toThrow(
      /render first/,
    );
  });

  it('throws with no platform', async () => {
    const doc = await doneProject(dir);
    await expect(buildPublishPackage(dir, doc, {})).rejects.toThrow(/at least one platform/);
  });
});
