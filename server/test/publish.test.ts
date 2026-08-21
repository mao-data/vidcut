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
