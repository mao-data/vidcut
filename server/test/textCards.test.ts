import { describe, it, expect, afterAll } from 'vitest';
import { mkdir, mkdtemp, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { cardKey, TextCardService } from '../src/textCards.js';
import { estimateCard, MAX_CARD_PIXELS } from '../src/cardBudget.js';
import { PillowRasterizer, type CardRequest } from '../src/rasterizer.js';
import { ProjectStore } from '../src/store.js';
import { createApp } from '../src/app.js';
import { renderCaptionCard } from '../src/render.js';

const raster = new PillowRasterizer(() => undefined);
afterAll(() => raster.dispose());

const REQ: CardRequest = {
  text: '哈囉世界',
  tokens: ['哈囉', '世界'],
  style: {
    fontFamily: 'Heiti TC',
    fontSize: 64,
    fill: '#ffffff',
    stroke: '#000000',
    highlight: '#FCDE5A',
  },
  width: 1080,
};

describe('cardKey', () => {
  it('same input → same key; 與時間無關的欄位不影響 key', () => {
    expect(cardKey(REQ, 'pillow-1')).toBe(cardKey({ ...REQ }, 'pillow-1'));
  });
  it('改字必變;換 rasterizerId 必變', () => {
    expect(cardKey({ ...REQ, text: '改了' }, 'pillow-1')).not.toBe(cardKey(REQ, 'pillow-1'));
    expect(cardKey(REQ, 'chromium-1')).not.toBe(cardKey(REQ, 'pillow-1'));
  });
});

describe('TextCardService', () => {
  it('ensure 產卡落盤;第二次命中快取(檔案 mtime 不變)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-tcs-'));
    const svc = new TextCardService(dir, raster);
    const a = await svc.ensure(REQ);
    expect(a.tokens).toHaveLength(2);
    const baseAbs = join(dir, svc.relBasePath(a.hash));
    const m1 = (await stat(baseAbs)).mtimeMs;
    const b = await svc.ensure(REQ);
    expect(b.hash).toBe(a.hash);
    expect((await stat(baseAbs)).mtimeMs).toBe(m1); // 沒重畫
  }, 30_000);

  // 命中判斷只看 .json 的話，PNG 一旦不見就永遠補不回來：內容定址代表同一份輸入
  // 永遠算出同一把 key，使用者在 UI 上做什麼都救不回來（字幕永久退回 DOM 近似、
  // 文字 overlay 的 imagePath 指向不存在的檔案，render 會整次匯出失敗）。
  it('.json 還在但 .base.png 被刪掉 → 視為 miss 重畫（不能只憑 .json 就算命中）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-tcs-heal-'));
    const svc = new TextCardService(dir, raster);
    const a = await svc.ensure(REQ);
    const baseAbs = join(dir, svc.relBasePath(a.hash));
    await unlink(baseAbs);
    const b = await svc.ensure(REQ);
    expect(b.hash).toBe(a.hash); // 內容定址：hash 本來就該一樣
    expect((await stat(baseAbs)).size).toBeGreaterThan(0); // 但圖必須真的被補回來
  }, 30_000);

  it('有 tokens 時 .hl.png 被刪掉 → 一樣重畫（karaoke 疊圖少一張就沒得揭色）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-tcs-heal-hl-'));
    const svc = new TextCardService(dir, raster);
    const a = await svc.ensure(REQ);
    const hlAbs = join(dir, 'derived', 'text', `${a.hash}.hl.png`);
    await unlink(hlAbs);
    await svc.ensure(REQ);
    expect((await stat(hlAbs)).size).toBeGreaterThan(0);
  }, 30_000);

  it('圖檔存在但是 0 byte（上次寫到一半被中斷）→ 也要重畫', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-tcs-heal-empty-'));
    const svc = new TextCardService(dir, raster);
    const a = await svc.ensure(REQ);
    const baseAbs = join(dir, svc.relBasePath(a.hash));
    await writeFile(baseAbs, '');
    await svc.ensure(REQ);
    expect((await stat(baseAbs)).size).toBeGreaterThan(0);
  }, 30_000);
});

// HTTP 面：驅動真的 Express app（真的 listen + fetch），不是直接呼叫 service。
// 保護的是路由層屬性（掛載順序、驗證），單元測試碰不到。
async function startTestServer() {
  const dir = await mkdtemp(join(tmpdir(), 'vidcut-tcs-http-'));
  const store = await ProjectStore.load(join(dir, 'project.json'));
  const svc = new TextCardService(dir, raster);
  const server: Server = createServer(createApp(store, dir, undefined, { textCards: svc }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { dir, store, server, base: `http://127.0.0.1:${port}` };
}

describe('HTTP: /text-card/*', () => {
  it('POST /text-card/preview 合法 body → 200 + 16-hex hash + geometry；且是唯讀（store.version 不變）', async () => {
    const { store, server, base } = await startTestServer();
    const versionBefore = store.version;
    // 這條 assertion 通過本身就證明了掛載順序正確：POST 真的到了 handler，
    // 而不是被 `/text-card` static（fallthrough:false）攔成 404。
    const res = await fetch(`${base}/text-card/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(REQ),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { hash: string; width: number; height: number; lines: number };
    expect(j.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(j.width).toBeGreaterThan(0);
    expect(j.height).toBeGreaterThan(0);
    expect(j.lines).toBeGreaterThan(0);
    expect(store.version).toBe(versionBefore); // POST 唯讀，不寫 doc

    // 卡已經落盤，static 端點可讀到非空檔案。
    const png = await fetch(`${base}/text-card/${j.hash}.base.png`);
    expect(png.status).toBe(200);
    const buf = Buffer.from(await png.arrayBuffer());
    expect(buf.byteLength).toBeGreaterThan(0);

    server.close();
  }, 30_000);

  it('POST /text-card/preview 缺必填 style 子欄位 → 400（不是被 ensure 丟出的 500）', async () => {
    const { server, base } = await startTestServer();
    const res = await fetch(`${base}/text-card/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x', style: {} }),
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(typeof j.error).toBe('string');
    server.close();
  });

  // 這條端點是瀏覽器一個 POST 就到得了的，而 Pillow 的記憶體用量隨字級/畫布大小暴增。
  // 沒有上限的話，一個超大 fontSize 會讓 worker 被 OOM killer 用「訊號」殺掉——
  // 那正是 rasterizer worker 被訊號殺死、整個編輯器卡死那條路徑的遠端觸發點。
  it('POST /text-card/preview 超出上限的輸入 → 400（剛好越界的值）', async () => {
    const { server, base } = await startTestServer();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...REQ, style: { ...REQ.style, fontSize: 513 } }, /fontSize/],
      [{ ...REQ, width: 4097 }, /width/],
      [{ ...REQ, width: 8 }, /width/],
      [{ ...REQ, maxWidthFrac: 0.05 }, /maxWidthFrac/],
      [{ ...REQ, text: 'x'.repeat(4001) }, /text/],
      [{ ...REQ, tokens: Array.from({ length: 1001 }, () => 'x') }, /tokens/],
    ];
    for (const [body, m] of cases) {
      const res = await fetch(`${base}/text-card/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect((await res.json()).error).toMatch(m);
    }
    server.close();
  }, 30_000);

  it('POST /text-card/preview 荒謬到會把 worker 撐爆的值 → 400（不能真的送進 Pillow）', async () => {
    const { server, base } = await startTestServer();
    const res = await fetch(`${base}/text-card/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...REQ, style: { ...REQ.style, fontSize: 1e9 }, width: 1e9 }),
    });
    expect(res.status).toBe(400);
    server.close();
  }, 30_000);

  // 這是 reviewer 實測「每個欄位都在上限之內卻依然回 HTTP 200」的那個 payload：
  // text 只有 100 個字元（≤4000 ✅）、fontSize 512 ✅、width 4096 ✅、maxWidthFrac 1 ✅，
  // 但無 tokens 路徑不換行，101 行 × line_h 614 = 62,022px 高 → 4096×62022 ≈ 254 Mpx。
  // 實測要 102 秒、2.2 GB，期間單一 worker 被獨佔（所有字卡與字型 probe 全部排在後面）。
  it('POST /text-card/preview 欄位全部合法但輸出像素爆量（行數驅動）→ 400，而且是立刻回', async () => {
    const { server, base } = await startTestServer();
    const t0 = Date.now();
    const res = await fetch(`${base}/text-card/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '\n'.repeat(100),
        style: { fontFamily: 'Heiti TC', fontSize: 512, fill: '#ffffff' },
        width: 4096,
        maxWidthFrac: 1,
      }),
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string };
    expect(j.error).toMatch(/too large/);
    expect(j.error).toMatch(/101 line/); // 訊息要講出「是行數把它撐大的」
    // 「沒有真的畫下去」的證據：舊行為是 102 秒後才回 200。
    expect(Date.now() - t0).toBeLessThan(2000);
    server.close();
  }, 30_000);

  it('POST /text-card/preview 剛好在上限內的值仍然通過（邊界沒有訂得太緊）', async () => {
    const { server, base } = await startTestServer();
    const res = await fetch(`${base}/text-card/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...REQ, style: { ...REQ.style, fontSize: 512 }, maxWidthFrac: 1 }),
    });
    expect(res.status).toBe(200);
    server.close();
  }, 30_000);
});

// 像素預算的可信度完全建立在「Node 這側估的高度 ≥ python 真的畫出來的高度」上。
// 估算式一旦跟 text_card.py 的 render_cards 漂開，預算就變成一個好看的假數字。
describe('estimateCard 與 text_card.py 的實際幾何一致', () => {
  const cases: Array<[string, CardRequest]> = [
    [
      '單行',
      { text: '一行字', style: { fontFamily: 'x', fontSize: 64, fill: '#fff' }, width: 1080 },
    ],
    [
      '多行（無 tokens：python 完全不換行，行數＝\\n 數+1，這條路徑就是漏洞所在）',
      {
        text: 'a\nb\nc\nd\ne',
        style: { fontFamily: 'x', fontSize: 48, fill: '#fff' },
        width: 1080,
      },
    ],
    [
      '有描邊（stroke_w 會加進高度）',
      {
        text: 'a\nb',
        style: { fontFamily: 'x', fontSize: 96, fill: '#fff', stroke: '#000' },
        width: 1080,
      },
    ],
    [
      '小字級（line_h 的 max(6, size//5) 分支）',
      { text: 'a\nb', style: { fontFamily: 'x', fontSize: 10, fill: '#fff' }, width: 720 },
    ],
  ];
  for (const [name, req] of cases) {
    it(`${name}：估算高度 = 實際高度`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'vidcut-est-'));
      const geo = await raster.rasterize(req, join(dir, 'e.base.png'));
      expect(estimateCard(req).height).toBe(geo.height);
      expect(estimateCard(req).pixels).toBe(geo.width * geo.height);
    }, 30_000);
  }

  it('有 tokens 時估算是上界（每行至少一個詞）——寧可高估，絕不低估', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-est-tok-'));
    const req: CardRequest = {
      text: '這是測試字幕',
      tokens: ['這是', '測試', '字幕'],
      style: { fontFamily: 'x', fontSize: 64, fill: '#fff' },
      width: 1080,
    };
    const geo = await raster.rasterize(req, join(dir, 't.base.png'));
    expect(estimateCard(req).height).toBeGreaterThanOrEqual(geo.height);
  }, 30_000);
});

describe('TextCardService.ensure 的像素預算（所有產卡路徑的最後一道防線）', () => {
  it('reviewer 那個「欄位全合法」的最大 payload 的確被算成天文數字（純算術，不執行）', () => {
    // 每一個欄位都在舊的欄位級上限之內（text ≤ 4000、fontSize ≤ 512、width ≤ 4096），
    // 但輸出是 4001 行 × line_h 614 → 4096×2,456,622 = 10.06 Gpx ≈ 40 GB RGBA、約 17 分鐘。
    // 這條刻意**不呼叫** ensure()：真的畫下去會把這台機器打垮，跑測試不該有那種風險。
    const bomb: CardRequest = {
      text: '\n'.repeat(4000),
      style: { fontFamily: 'Heiti TC', fontSize: 512, fill: '#ffffff' },
      width: 4096,
      maxWidthFrac: 1,
    };
    const est = estimateCard(bomb);
    expect(est.lines).toBe(4001);
    expect(est.pixels).toBeGreaterThan(10e9); // 10 Gpx＝40 GB RGBA
    expect(est.pixels / MAX_CARD_PIXELS).toBeGreaterThan(800); // 超出預算 800 倍以上
  });

  it('超出預算 → reject，而且完全沒送進 worker、沒有落盤', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-budget-'));
    const svc = new TextCardService(dir, raster);
    // 用「超標但即使真的畫下去也只是幾秒／幾百 MB」的量（約 40 Mpx）：
    // 這樣把這道防線拿掉做變異測試時不會拖垮機器，斷言強度不變。
    const over: CardRequest = {
      text: '一行\n'.repeat(480),
      style: { fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' },
      width: 1080,
    };
    expect(estimateCard(over).pixels).toBeGreaterThan(MAX_CARD_PIXELS);
    const t0 = Date.now();
    await expect(svc.ensure(over)).rejects.toThrow(/too large/);
    // 「沒有真的去畫」的證據：拒絕是即時的（這個量真的畫要好幾秒，reviewer 的十分之一
    // payload 要 102 秒）。
    expect(Date.now() - t0).toBeLessThan(1000);
    // 也沒有留下任何檔案（.json / .png 都不該產生）
    await expect(stat(join(dir, 'derived', 'text'))).rejects.toThrow();
  }, 30_000);

  it('剛好在預算內的卡仍然畫得出來，而且實際像素數真的沒超過預算', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-budget-ok-'));
    const svc = new TextCardService(dir, raster);
    // 1080 寬、fontSize 64（line_h 76）→ 157 行 = 11,940px 高 ≈ 12.9 Mpx（超標，用來卡上界）
    const overLines = 156;
    const under: CardRequest = {
      text: Array.from({ length: 145 }, (_, i) => `第${i}行`).join('\n'),
      style: { fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' },
      width: 1080,
    };
    expect(estimateCard(under).pixels).toBeLessThanOrEqual(MAX_CARD_PIXELS);
    const r = await svc.ensure(under);
    expect(r.width * r.height).toBeLessThanOrEqual(MAX_CARD_PIXELS);

    // 多幾行就越界 → 拒絕（邊界兩側都驗過，不是只驗一邊）
    const over: CardRequest = {
      ...under,
      text: Array.from({ length: overLines }, (_, i) => `第${i}行`).join('\n'),
    };
    expect(estimateCard(over).pixels).toBeGreaterThan(MAX_CARD_PIXELS);
    await expect(svc.ensure(over)).rejects.toThrow(/too large/);
  }, 60_000);
});

// 匯出路徑（render.ts）自己 spawn python3，不走常駐 worker：卡不住佇列，但一樣會被
// OOM killer 收掉。而且它讀的是**已經存在文件裡**的字幕——這次改動之前存下來的專案
// 不受命令層檢查保護，所以匯出前要再擋一次。
describe('render 的字卡也吃同一份預算（保護改動前存下來的舊專案）', () => {
  it('舊專案裡 fontSize 荒謬的字幕 → 匯出時回一句看得懂的錯誤，不會去 spawn python', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-render-budget-'));
    const t0 = Date.now();
    await expect(
      renderCaptionCard(
        dir,
        {
          id: 'legacy',
          text: '舊專案的字幕',
          start: 0,
          duration: 2,
          style: { fontFamily: 'Heiti TC', fontSize: 20000, fill: '#ffffff', y: 0.8 },
        },
        1080,
      ),
    ).rejects.toThrow(/legacy.*too large|legacy.*fontSize/);
    expect(Date.now() - t0).toBeLessThan(1000);
  }, 30_000);

  it('正常字幕照樣畫得出來（沒有把匯出路徑一起擋死）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-render-ok-'));
    await mkdir(join(dir, 'derived', 'captions'), { recursive: true }); // render() 平常會先建
    const rel = await renderCaptionCard(
      dir,
      {
        id: 'normal',
        text: '正常字幕',
        start: 0,
        duration: 2,
        style: { fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff', y: 0.8 },
      },
      1080,
    );
    expect((await stat(join(dir, rel))).size).toBeGreaterThan(0);
  }, 30_000);
});
