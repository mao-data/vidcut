// server/test/canvasCards.test.ts — 改畫布後的字卡重烤接線與孤兒清理。
// 刻意用真的 PillowRasterizer（照 cardSync.test.ts / textOverlays.test.ts 的慣例）：
// 這一批要證明的正是「新寬度真的烤出不同的卡、舊檔真的被刪」，mock 掉產卡就什麼都沒證明。
import { describe, it, expect, afterAll } from 'vitest';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { DEFAULT_CAPTION_STYLE } from '@vidcut/shared';
import type { OverlayItem, WsServerMsg } from '@vidcut/shared';
import { ProjectStore } from '../src/store.js';
import { PillowRasterizer } from '../src/rasterizer.js';
import { TextCardService } from '../src/textCards.js';
import { CaptionCardSync } from '../src/cardSync.js';
import { resolveTextCommand } from '../src/textOverlays.js';
import { applyCommand } from '../src/commands.js';
import { refreshCardsForCanvas, sweepOrphanCards } from '../src/canvasCards.js';
import { startServer } from '../src/index.js';
import { tmpDir } from './tmp.js';

const raster = new PillowRasterizer(() => undefined);
afterAll(() => raster.dispose());

async function cardDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, 'derived', 'text'))).sort();
  } catch {
    return [];
  }
}

async function setup() {
  const dir = await tmpDir('vidcut-cc-');
  const store = await ProjectStore.load(join(dir, 'project.json'));
  store.mutate('ai', 'seed captions', (d) => {
    d.tracks.captions = [
      { id: 'c1', text: '第一句', start: 0, duration: 1, style: DEFAULT_CAPTION_STYLE },
    ];
  });
  const svc = new TextCardService(dir, raster);
  const sync = new CaptionCardSync(store, svc, 10);
  return { dir, store, svc, sync };
}

describe('refreshCardsForCanvas', () => {
  it('改畫布寬之後字幕的字卡 hash 變了、舊卡被清掉、undo 之後 hash 回到原值', async () => {
    const { dir, store, svc, sync } = await setup();
    const before = await sync.runNow();
    expect(before).toHaveLength(1);
    const oldHash = before[0]!.hash;
    // 舊卡確實在磁碟上
    await expect(stat(join(dir, 'derived', 'text', `${oldHash}.base.png`))).resolves.toBeTruthy();

    expect(applyCommand(store, 'human', { name: 'setCanvas', width: 1920, height: 1080 }).ok).toBe(
      true,
    );
    await refreshCardsForCanvas(dir, store, sync, svc);

    const newHash = sync.latest[0]!.hash;
    expect(newHash).not.toBe(oldHash); // 新寬度＝新 key
    await expect(stat(join(dir, 'derived', 'text', `${newHash}.base.png`))).resolves.toBeTruthy();
    // 孤兒清掉：舊寬度那張卡的檔案（含 .json）不再存在
    expect(await cardDir(dir)).not.toContain(`${oldHash}.base.png`);
    expect(await cardDir(dir)).not.toContain(`${oldHash}.json`);

    // undo 回去 → 內容定址讓同一把 key 重新算出來、檔案重畫一次。
    // 這同時證明前面刪掉舊卡是安全的（刪掉的東西一定回得來）。
    expect(store.undo('human')).not.toBeNull();
    expect(store.doc.canvas.width).toBe(1080);
    await refreshCardsForCanvas(dir, store, sync, svc);
    expect(sync.latest[0]!.hash).toBe(oldHash);
    await expect(stat(join(dir, 'derived', 'text', `${oldHash}.base.png`))).resolves.toBeTruthy();
    // 對稱地，換過去那輪的卡現在變成孤兒、也被清掉了
    expect(await cardDir(dir)).not.toContain(`${newHash}.base.png`);
  }, 60_000);

  it('文字 overlay 的 imagePath 跟著改到新寬度的卡，舊卡不被誤刪保留條件是還被指著', async () => {
    const { dir, store, svc, sync } = await setup();
    const cmd = await resolveTextCommand(svc, store, {
      name: 'addOverlay',
      overlay: {
        id: 'ov1',
        imagePath: '',
        text: { text: '大標題', fontFamily: 'Heiti TC', fontSize: 72, fill: '#ffffff' },
        start: 0,
        duration: 3,
        position: { x: 0.5, y: 0.4, scale: 1 },
      } as OverlayItem,
    });
    expect(applyCommand(store, 'human', cmd).ok).toBe(true);
    const oldPath = store.doc.tracks.overlays[0]!.imagePath;
    expect(oldPath).toMatch(/^derived\/text\/[0-9a-f]{16}\.base\.png$/);

    expect(applyCommand(store, 'human', { name: 'setCanvas', width: 1920, height: 1080 }).ok).toBe(
      true,
    );
    await refreshCardsForCanvas(dir, store, sync, svc);

    const newPath = store.doc.tracks.overlays[0]!.imagePath;
    expect(newPath).not.toBe(oldPath);
    // 現行 imagePath 指的檔案一定要在（不然 render 會 `ffmpeg -i` 讀不到而整支失敗）
    await expect(stat(join(dir, newPath))).resolves.toBeTruthy();
    await expect(stat(join(dir, oldPath))).rejects.toThrow();
  }, 60_000);

  it('sweepOrphanCards 保留 live hash 與認不得的檔名，刪除失敗不會 throw', async () => {
    const { dir, sync } = await setup();
    const entries = await sync.runNow();
    const live = entries[0]!.hash;
    // 假造一張孤兒卡 + 一個不是我們產的檔案
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'derived', 'text'), { recursive: true });
    await writeFile(join(dir, 'derived', 'text', '0123456789abcdef.base.png'), 'x');
    await writeFile(join(dir, 'derived', 'text', 'README.txt'), 'not ours');

    const removed = await sweepOrphanCards(dir, new Set([live]));
    expect(removed).toBeGreaterThanOrEqual(1);
    const left = await cardDir(dir);
    expect(left).toContain(`${live}.base.png`);
    expect(left).toContain('README.txt'); // 認不得的檔名一律保留
    expect(left).not.toContain('0123456789abcdef.base.png');

    // 目錄不存在時是 0，不是例外
    expect(await sweepOrphanCards(await tmpDir('vidcut-cc-empty-'), new Set())).toBe(0);
  }, 60_000);
});

describe('wsHub 觸發條件', () => {
  async function boot() {
    const dir = await tmpDir('vidcut-ccws-');
    // 種資料要用 server 自己的 store（它從 project.json 載入自己那份，先在旁邊
    // mutate 一個獨立 store 只會因為存檔 debounce 而讀不到）。
    const { server, store } = await startServer(dir, 0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return {
      dir,
      port,
      store,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  /** 等 textCards 廣播（cardSync 跑完的訊號），逾時回 null。 */
  function waitTextCards(ws: WebSocket, ms: number): Promise<Array<{ id: string; hash: string }>> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve([]), ms);
      const onMsg = (d: WebSocket.RawData): void => {
        const m = JSON.parse(d.toString()) as WsServerMsg;
        if (m.type === 'textCards') {
          clearTimeout(timer);
          ws.off('message', onMsg);
          resolve(m.entries);
        }
      };
      ws.on('message', onMsg);
    });
  }

  it('setCanvas 觸發重烤，setCanvasFit 不觸發（判別性）', async () => {
    const { dir, port, store, close } = await boot();
    // ws 一定要在 finally 關掉：`server.close()` 會等所有連線散場，斷言失敗時
    // 把它留在 try 裡就會從「一句清楚的斷言錯誤」變成整條測試逾時。
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    try {
      await new Promise((r) => ws.once('open', r));
      // 先連上再種字幕，才不會與啟動預熱那一輪搶時序（廣播只發給當下連著的人）
      const warmP = waitTextCards(ws, 30_000);
      store.mutate('ai', 'seed captions', (d) => {
        d.tracks.captions = [
          { id: 'c1', text: '第一句', start: 0, duration: 1, style: DEFAULT_CAPTION_STYLE },
        ];
      });
      const warm = await warmP;
      expect(warm).toHaveLength(1);
      const baseHash = warm[0]!.hash;

      // (a) fit 變更：不該觸發任何重烤 → 等不到新的 textCards
      ws.send(JSON.stringify({ type: 'command', cmd: { name: 'setCanvasFit', fit: 'blur' } }));
      expect(await waitTextCards(ws, 1500)).toEqual([]);
      // 也不該掃孤兒：基準卡還在
      expect(await cardDir(dir)).toContain(`${baseHash}.base.png`);

      // (b) 尺寸變更：重烤成立，hash 換成新寬度那把
      const gotP = waitTextCards(ws, 30_000);
      ws.send(
        JSON.stringify({
          type: 'command',
          cmd: { name: 'setCanvas', width: 1920, height: 1080 },
        }),
      );
      const got = await gotP;
      expect(got).toHaveLength(1);
      expect(got[0]!.hash).not.toBe(baseHash);
    } finally {
      ws.close();
      await close();
    }
  }, 90_000);
});
