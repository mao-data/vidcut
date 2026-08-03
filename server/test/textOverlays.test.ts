import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { applyCommand } from '../src/commands.js';
import { PillowRasterizer } from '../src/rasterizer.js';
import { TextCardService } from '../src/textCards.js';
import { resolveTextCommand } from '../src/textOverlays.js';
import type { Command, OverlayItem } from '@vidcut/shared';

const raster = new PillowRasterizer(() => undefined);
afterAll(() => raster.dispose());

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-to-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
  return { dir, store, svc: new TextCardService(dir, raster) };
}

const TEXT = { text: '大標題', fontFamily: 'Heiti TC', fontSize: 72, fill: '#ffffff', stroke: '#000000' };
const ADD: Command = {
  name: 'addOverlay',
  overlay: {
    id: 'ov1', imagePath: '', text: TEXT, start: 0, duration: 3,
    position: { x: 0.5, y: 0.4, scale: 1 },
  } as OverlayItem,
};

describe('resolveTextCommand + 命令層', () => {
  it('addOverlay 帶 text:resolve 後 imagePath 指向實存的字卡,applyCommand 一次成立', async () => {
    const { dir, store, svc } = await setup();
    const resolved = await resolveTextCommand(svc, store, ADD);
    const r = applyCommand(store, 'human', resolved);
    expect(r.ok).toBe(true);
    const ov = store.doc.tracks.overlays[0]!;
    expect(ov.text?.text).toBe('大標題');
    expect(ov.imagePath).toMatch(/^derived\/text\/[0-9a-f]{16}\.base\.png$/);
    expect((await stat(join(dir, ov.imagePath))).size).toBeGreaterThan(0);
  }, 30_000);

  it('updateOverlay 改 text:text 與 imagePath 在同一版本一起變(原子)', async () => {
    const { store, svc } = await setup();
    applyCommand(store, 'human', await resolveTextCommand(svc, store, ADD));
    const before = store.doc.tracks.overlays[0]!.imagePath;
    const cmd: Command = { name: 'updateOverlay', id: 'ov1', patch: { text: { ...TEXT, text: '改標題' } } };
    const r = applyCommand(store, 'human', await resolveTextCommand(svc, store, cmd));
    expect(r.ok).toBe(true);
    const ov = store.doc.tracks.overlays[0]!;
    expect(ov.text?.text).toBe('改標題');
    expect(ov.imagePath).not.toBe(before);
  }, 30_000);

  it('無 text 的命令原樣通過(既有排名 PNG 行為不變)', async () => {
    const { store, svc } = await setup();
    const cmd: Command = {
      name: 'addOverlay',
      overlay: { id: 'png1', imagePath: 'assets/x.png', start: 0, duration: 2, position: { x: 0.5, y: 0, scale: 1 } },
    };
    expect(await resolveTextCommand(svc, store, cmd)).toBe(cmd);
  });

  it('驗證:text overlay 空字串被拒;text overlay 的 imagePath 空(未 resolve)被拒', async () => {
    const { store } = await setup();
    const bad1: Command = {
      name: 'addOverlay',
      overlay: { ...(ADD as Extract<Command, { name: 'addOverlay' }>).overlay, text: { ...TEXT, text: '  ' } },
    };
    expect(applyCommand(store, 'human', bad1).ok).toBe(false);
    expect(applyCommand(store, 'human', ADD).ok).toBe(false); // imagePath 仍是 ''
  });
});
