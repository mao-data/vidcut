import { describe, it, expect } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildRenderArgs, renderCaptionCards } from '../src/render.js';
import {
  createEmptyProject,
  buildCaptionPages,
  type CaptionItem,
  type Project,
} from '@vidcut/shared';
import { tmpDir } from './tmp.js';

function karaokeCaption(): CaptionItem {
  return buildCaptionPages([
    { text: '這隻', start: 1.0, end: 1.4 },
    { text: '貓', start: 1.4, end: 1.7 },
    { text: '太扯', start: 1.7, end: 2.2 },
  ])[0]!;
}

function projectWithCaption(cap: CaptionItem): Project {
  const p = createEmptyProject('p', 't');
  p.media = [
    {
      id: 'm1',
      path: 'a.mp4',
      probe: { duration: 10, width: 540, height: 960, fps: 30, hasAudio: true, rotation: 0 },
    },
  ];
  p.tracks.video = [{ id: 'c1', mediaId: 'm1', in: 0, duration: 5, volume: 1 }];
  p.tracks.captions = [cap];
  return p;
}

describe('renderCaptionCards', () => {
  it('makes one card per token, windowed by the next token start', async () => {
    const dir = await tmpDir('vidcut-kara-');
    await mkdir(join(dir, 'derived', 'captions'), { recursive: true });
    const cap = karaokeCaption();
    const cards = await renderCaptionCards(dir, cap, 1080);

    expect(cards).toHaveLength(3);
    expect(cards.map((c) => [c.start, c.end])).toEqual([
      [1.0, 1.4],
      [1.4, 1.7],
      // 最後一張延伸到 caption 結束
      [1.7, cap.start + cap.duration],
    ]);
    // 每個詞一個檔名，不會互相覆蓋
    expect(new Set(cards.map((c) => c.relPath)).size).toBe(3);
  }, 60_000);

  it('makes a single card covering the whole caption when there are no tokens', async () => {
    const dir = await tmpDir('vidcut-kara-');
    await mkdir(join(dir, 'derived', 'captions'), { recursive: true });
    const cap: CaptionItem = {
      id: 'cap1',
      text: 'no karaoke',
      start: 2,
      duration: 1.5,
      style: { fontFamily: 's', fontSize: 48, fill: '#fff', y: 0.7 },
    };
    const cards = await renderCaptionCards(dir, cap, 1080);
    expect(cards).toHaveLength(1);
    expect([cards[0]!.start, cards[0]!.end]).toEqual([2, 3.5]);
    expect(cards[0]!.relPath).toContain('cap1.png');
  }, 60_000);
});

describe('buildRenderArgs with karaoke cards', () => {
  it('overlays each card in its own window and never uses drawtext', async () => {
    const dir = await tmpDir('vidcut-kara-');
    await mkdir(join(dir, 'derived', 'captions'), { recursive: true });
    const cap = karaokeCaption();
    const p = projectWithCaption(cap);
    const cards = await renderCaptionCards(dir, cap, 1080);

    // 就算本機有 drawtext，有字卡就必須走字卡——drawtext 做不到逐詞著色
    const plan = buildRenderArgs(p, dir, join(dir, 'o.mp4'), {
      hasDrawtext: true,
      captionCards: cards,
    });
    const fc = plan.args[plan.args.indexOf('-filter_complex') + 1]!;
    expect(fc).not.toContain('drawtext');
    expect(plan.captionsBurned).toBe(true);
    // 3 張卡 → 3 個 overlay（標籤既是輸出也是下一段的輸入，故比對去重後的數量）
    expect(new Set(fc.match(/\[capc\d+\]/g)).size).toBe(3);
    expect(fc).toContain('between(t\\,1\\,1.4)');
    expect(fc).toContain('between(t\\,1.4\\,1.7)');
    // 1 clip input + 3 card inputs
    expect(plan.args.filter((a) => a === '-i')).toHaveLength(4);
  }, 60_000);
});
