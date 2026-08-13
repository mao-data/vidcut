import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { buildDemoProject, writeTitleCard } from '../src/demo.js';
import { runFfmpeg } from '../src/ffmpeg.js';
import { ProjectStore } from '../src/store.js';
import { tmpDir } from './tmp.js';

/** 把 PNG 的 alpha 通道抽成灰階原始位元組，回傳最大值（0 = 整張全透明）。 */
async function maxAlpha(png: string, dir: string): Promise<number> {
  const raw = join(dir, 'alpha.raw');
  await runFfmpeg(['-i', png, '-vf', 'alphaextract', '-pix_fmt', 'gray', '-f', 'rawvideo', raw]);
  return Math.max(...(await readFile(raw)));
}

describe('buildDemoProject', () => {
  it('creates a playable 5-clip project with overlay and captions', async () => {
    const dir = await tmpDir('vidcut-demo-');
    await buildDemoProject(dir);
    const store = await ProjectStore.load(join(dir, 'project.json'));
    // 5 支影片；overlay PNG 走 imagePath 直接引用，不進 media
    expect(store.doc.media.length).toBe(5);
    expect(store.doc.tracks.video).toHaveLength(5);
    expect(store.doc.tracks.overlays.length).toBeGreaterThan(0);
    expect(store.doc.tracks.captions.length).toBeGreaterThan(0);
    for (const m of store.doc.media) {
      expect(m.proxyPath).toBeTruthy();
    }
  }, 180_000);

  /**
   * 上面那條只斷言 overlay **軌**存在——結構在不等於使用者看得見。實際踩到的：
   * `drawbox` 只混 RGB、不寫 alpha，底圖是 `black@0.0` 就讓整張 title.png 的 alpha
   * 全為 0，橫幅在預覽和匯出都是隱形的，而上面那條測試照樣綠。README 明寫 demo 會
   * 附一個 title overlay，這是新使用者第一眼看到的東西。
   */
  it('標題卡不是整張透明——alpha 全 0 的話橫幅在預覽與匯出都是隱形的', async () => {
    const dir = await tmpDir('vidcut-title-');
    const png = await writeTitleCard(dir);
    expect(await maxAlpha(png, dir)).toBeGreaterThan(0);
  }, 60_000);
});
