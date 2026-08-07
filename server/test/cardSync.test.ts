import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { PillowRasterizer } from '../src/rasterizer.js';
import { TextCardService } from '../src/textCards.js';
import { CaptionCardSync, capToCardRequest } from '../src/cardSync.js';
import { DEFAULT_CAPTION_STYLE } from '@vidcut/shared';
import { tmpDir } from './tmp.js';

const raster = new PillowRasterizer(() => undefined);
afterAll(() => raster.dispose());

async function setup() {
  const dir = await tmpDir('vidcut-cs-');
  const store = await ProjectStore.load(join(dir, 'project.json'));
  store.mutate('ai', 'seed captions', (d) => {
    d.tracks.captions = [
      { id: 'c1', text: '第一句', start: 0, duration: 1, style: DEFAULT_CAPTION_STYLE },
      {
        id: 'c2',
        text: '第二句',
        start: 1,
        duration: 1,
        style: DEFAULT_CAPTION_STYLE,
        tokens: [
          { text: '第二', start: 1, end: 1.5 },
          { text: '句', start: 1.5, end: 2 },
        ],
      },
    ];
  });
  return { store, svc: new TextCardService(dir, raster) };
}

describe('CaptionCardSync', () => {
  it('capToCardRequest: 逐詞字幕帶 tokens 文字序列', async () => {
    const { store } = await setup();
    const req = capToCardRequest(store.doc.tracks.captions[1]!, 1080);
    expect(req.tokens).toEqual(['第二', '句']);
    expect(req.width).toBe(1080);
  });

  it('runNow 產出每句的 hash 並記在 latest', async () => {
    const { store, svc } = await setup();
    const sync = new CaptionCardSync(store, svc, 10);
    const entries = await sync.runNow();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.id).toBe('c1');
    expect(sync.latest).toEqual(entries);
  }, 30_000);

  it('schedule 是 debounce:密集呼叫只跑一次 onReady', async () => {
    const { store } = await setup();
    // 假 service：ensure 直接回傳固定結果,不觸發 rasterizer 子行程。
    // debounce 只測 setTimeout 合併,無需實際轉卡。
    const stubService = {
      ensure: async () => ({ hash: 'stub-hash', width: 100, height: 40, lines: 1 }),
    } as unknown as TextCardService;
    const sync = new CaptionCardSync(store, stubService, 50);
    let calls = 0;
    sync.onReady = () => {
      calls += 1;
    };
    sync.schedule();
    sync.schedule();
    sync.schedule();
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toBe(1);
  }, 30_000);

  it('runNow 隔離單句失敗:壞的那句被略過,其餘句照樣產出並進 latest', async () => {
    const { store } = await setup();
    // 假 service:c1 一律失敗(模擬 rasterizer 子行程崩潰/壞字型/磁碟錯誤),c2 正常產卡。
    const flaky = {
      ensure: async (req: { text: string }) => {
        if (req.text === '第一句') throw new Error('boom: rasterizer crashed');
        return { hash: 'ok-hash', width: 100, height: 40, lines: 1 };
      },
    } as unknown as TextCardService;
    const sync = new CaptionCardSync(store, flaky, 10);
    const entries = await sync.runNow();
    expect(entries.find((e) => e.id === 'c1')).toBeUndefined();
    expect(entries.find((e) => e.id === 'c2')).toEqual({ id: 'c2', hash: 'ok-hash' });
    expect(sync.latest).toEqual(entries);
  }, 30_000);
});
