import { describe, it, expect, afterAll } from 'vitest';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { CaptionItem } from '@vidcut/shared';
import { cardKey, TextCardService } from '../src/textCards.js';
import { capToCardRequest } from '../src/cardSync.js';
import {
  cardRequestError,
  estimateCard,
  MAX_ADVANCE_EM,
  MAX_CARD_PIXELS,
} from '../src/cardBudget.js';
import { loadFontTable } from '../src/fonts.js';
import { PillowRasterizer, type CardGeometry, type CardRequest } from '../src/rasterizer.js';
import { ProjectStore } from '../src/store.js';
import { createApp } from '../src/app.js';
import { renderCaptionCard } from '../src/render.js';

const raster = new PillowRasterizer(() => undefined);
afterAll(() => raster.dispose());
const execFileP = promisify(execFile);

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
  // 舊版這條是 `cardKey(REQ) === cardKey({ ...REQ })`——淺拷貝必然序列化成同一串,
  // 不管 cardKey 怎麼寫都會通過。真正有內容的「同輸入同 key」是:**結構相同但寫法
  // 不同**的兩個請求要算出同一把 key(欄位順序不同、省略的可選欄位 vs 顯式預設值)。
  // 這是內容定址的實質要求:同一張卡不能因為呼叫端怎麼組物件而算出兩把 key
  // (那會讓快取永遠 miss、同一張圖重畫兩份)。
  it('same input → same key：欄位順序與「省略 vs 顯式預設值」都不影響 key', () => {
    const shuffled: CardRequest = {
      width: 1080,
      style: {
        highlight: '#FCDE5A',
        stroke: '#000000',
        fill: '#ffffff',
        fontSize: 64,
        fontFamily: 'Heiti TC',
      },
      tokens: ['哈囉', '世界'],
      text: '哈囉世界',
      maxWidthFrac: 0.9, // REQ 省略了它,預設就是 0.9 → 必須算出同一把 key
    };
    expect(cardKey(shuffled, 'pillow-1')).toBe(cardKey(REQ, 'pillow-1'));
  });

  // 每一個會影響「畫出來長什麼樣」的欄位都必須改變 key。少任何一個,改了樣式卻沿用
  // 舊圖,使用者會看到「改了但畫面沒變」——而且因為是內容定址,再也修不回來。
  it('每個影響渲染的欄位都會改變 key（含 rasterizerId）', () => {
    const variants: Array<[string, CardRequest, string]> = [
      ['原樣', REQ, 'pillow-1'],
      ['改字', { ...REQ, text: '改了' }, 'pillow-1'],
      ['改詞界', { ...REQ, tokens: ['哈', '囉世界'] }, 'pillow-1'],
      ['去掉 tokens', { ...REQ, tokens: undefined }, 'pillow-1'],
      ['換字型', { ...REQ, style: { ...REQ.style, fontFamily: 'PingFang TC' } }, 'pillow-1'],
      ['改字級', { ...REQ, style: { ...REQ.style, fontSize: 65 } }, 'pillow-1'],
      ['改填色', { ...REQ, style: { ...REQ.style, fill: '#fffffe' } }, 'pillow-1'],
      ['改描邊', { ...REQ, style: { ...REQ.style, stroke: '#010101' } }, 'pillow-1'],
      ['去掉描邊', { ...REQ, style: { ...REQ.style, stroke: undefined } }, 'pillow-1'],
      ['改高亮色', { ...REQ, style: { ...REQ.style, highlight: '#FCDE5B' } }, 'pillow-1'],
      ['去掉高亮色', { ...REQ, style: { ...REQ.style, highlight: undefined } }, 'pillow-1'],
      ['改畫布寬', { ...REQ, width: 1081 }, 'pillow-1'],
      ['改換行寬', { ...REQ, maxWidthFrac: 0.8 }, 'pillow-1'],
      ['換 rasterizerId', REQ, 'chromium-1'],
    ];
    const keys = variants.map(([, req, id]) => cardKey(req, id));
    const dupes = variants
      .map(([name], i) => [name, keys[i]!] as const)
      .filter(([, k], i) => keys.indexOf(k) !== i);
    expect(dupes, `這些變體與前面某個變體撞 key：${JSON.stringify(dupes)}`).toEqual([]);
  });

  // spec §10 的「改時間不變」。CardRequest 本身沒有任何時間欄位,所以這個性質只有在
  // 「CaptionItem → CardRequest」那一層才表達得出來——時間就是在那裡被丟掉的。
  it('改時間不變：只動字幕的時間欄位（含逐詞時間戳）不得改變 key', () => {
    const cap: CaptionItem = {
      id: 'c1',
      text: '哈囉世界',
      start: 0,
      duration: 2,
      style: { fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff', y: 0.8 },
      tokens: [
        { text: '哈囉', start: 0, end: 1 },
        { text: '世界', start: 1, end: 2 },
      ],
    };
    const moved: CaptionItem = {
      ...cap,
      start: 37.5,
      duration: 9,
      tokens: [
        { text: '哈囉', start: 37.5, end: 42 },
        { text: '世界', start: 42, end: 46.5 },
      ],
    };
    expect(cardKey(capToCardRequest(moved, 1080), 'pillow-1')).toBe(
      cardKey(capToCardRequest(cap, 1080), 'pillow-1'),
    );
    // 對照組:同一層改「字」照樣要變 key,證明上面那條不是因為兩邊都退化成常數才相等。
    expect(cardKey(capToCardRequest({ ...cap, text: '改了' }, 1080), 'pillow-1')).not.toBe(
      cardKey(capToCardRequest(cap, 1080), 'pillow-1'),
    );
  });
});

describe('TextCardService', () => {
  it('ensure 產卡落盤;第二次命中快取(檔案 mtime 不變)', async () => {
    const dir = await tmpDir('vidcut-tcs-');
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
    const dir = await tmpDir('vidcut-tcs-heal-');
    const svc = new TextCardService(dir, raster);
    const a = await svc.ensure(REQ);
    const baseAbs = join(dir, svc.relBasePath(a.hash));
    await unlink(baseAbs);
    const b = await svc.ensure(REQ);
    expect(b.hash).toBe(a.hash); // 內容定址：hash 本來就該一樣
    expect((await stat(baseAbs)).size).toBeGreaterThan(0); // 但圖必須真的被補回來
  }, 30_000);

  it('有 tokens 時 .hl.png 被刪掉 → 一樣重畫（karaoke 疊圖少一張就沒得揭色）', async () => {
    const dir = await tmpDir('vidcut-tcs-heal-hl-');
    const svc = new TextCardService(dir, raster);
    const a = await svc.ensure(REQ);
    const hlAbs = join(dir, 'derived', 'text', `${a.hash}.hl.png`);
    await unlink(hlAbs);
    await svc.ensure(REQ);
    expect((await stat(hlAbs)).size).toBeGreaterThan(0);
  }, 30_000);

  // 幾何 schema 長出新欄位（2026-08-05 的 `ink`）時的自癒。內容定址代表同一份輸入永遠
  // 算出同一把 key，所以舊 `.json` 若被當成命中，既有專案就**永遠**拿不到新欄位——
  // 預覽端的命中框只能一直退回整張卡，那正是要修的 bug。走這條而不是把 rasterizerId
  // 往上加：PNG 的位元組一個都沒變，沒有理由讓全部的卡改名、讓所有 imagePath 要靠遷移追。
  it('舊 .json 缺 ink（schema 是後來加的）→ 視為 miss 重畫，hash 不變、原地補上', async () => {
    const dir = await tmpDir('vidcut-tcs-heal-schema-');
    const svc = new TextCardService(dir, raster);
    const a = await svc.ensure(REQ);
    expect(a.ink).toBeDefined();

    const metaAbs = join(dir, 'derived', 'text', `${a.hash}.json`);
    const full = JSON.parse(await readFile(metaAbs, 'utf8')) as CardGeometry;
    const old: Partial<CardGeometry> = { ...full };
    delete old.ink;
    await writeFile(metaAbs, JSON.stringify(old)); // 退回成「加 ink 之前」的樣子
    expect(JSON.parse(await readFile(metaAbs, 'utf8')).ink).toBeUndefined();

    const b = await svc.ensure(REQ);
    expect(b.hash).toBe(a.hash); // 同輸入→同 key，不該換名字
    expect(b.ink).toEqual(a.ink); // 回傳補回來了
    expect((JSON.parse(await readFile(metaAbs, 'utf8')) as CardGeometry).ink).toEqual(a.ink); // 檔案也補回來了
  }, 30_000);

  it('圖檔存在但是 0 byte（上次寫到一半被中斷）→ 也要重畫', async () => {
    const dir = await tmpDir('vidcut-tcs-heal-empty-');
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
  const dir = await tmpDir('vidcut-tcs-http-');
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
//
// ⚠️ 2026-08-04（自動換行上線）之後這裡從「等號」改成「上界」：python 的無 tokens 路徑
// 現在會折行，一行長文字可以變成幾百行，而 Node 這側量不到字寬。`estimateCard` 因此
// 改成「每個字元最壞情況各佔一行」的上界（見 cardBudget.ts 的 maxWrappedLines）。
// **不要**把這些斷言改回 `toBe`：那等於要求估算式精確重現 Pillow 的字型量測，做不到，
// 而且改回去的當下預算就會開始低估。
describe('estimateCard ≥ text_card.py 的實際幾何（上界，不是等號）', () => {
  const cases: Array<[string, CardRequest]> = [
    [
      '單行',
      { text: '一行字', style: { fontFamily: 'x', fontSize: 64, fill: '#fff' }, width: 1080 },
    ],
    [
      '多行（每個 \\n 一定是一行）',
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
    [
      '長中文（真的會折行的那種）',
      {
        text: '這是一段很長的中文字幕測試自動換行行為，混合 Latin words 與中文標點。',
        style: { fontFamily: 'x', fontSize: 64, fill: '#fff' },
        width: 1080,
      },
    ],
    [
      '超長不可斷單字（逐字硬切）',
      {
        text: 'x'.repeat(120),
        style: { fontFamily: 'x', fontSize: 48, fill: '#fff' },
        width: 1080,
        maxWidthFrac: 0.3,
      },
    ],
  ];
  for (const [name, req] of cases) {
    it(`${name}：估算高度 ≥ 實際高度`, async () => {
      const dir = await tmpDir('vidcut-est-');
      const geo = await raster.rasterize(req, join(dir, 'e.base.png'));
      const est = estimateCard(req);
      expect(est.lines).toBeGreaterThanOrEqual(geo.lines);
      expect(est.height).toBeGreaterThanOrEqual(geo.height);
      expect(est.pixels).toBeGreaterThanOrEqual(geo.width * geo.height);
    }, 30_000);
  }

  // 這條是上界說明裡「可以被打到」那句話的證據。沒有它，`maxWrappedLines` 看起來
  // 只是一個隨手放大的保險係數，下一個人就會想「一定過度保守吧」而把它調鬆。
  // 構造：可用寬 = 1080 × 0.1 = 108px < 一個 512px 的 CJK 字（全形＝1em）
  // → 每個字真的各佔一行 → 實際行數 = 字元數 = 上界，等號成立。
  it('最壞情況會打到上界（每個字元各佔一行）——證明它不是隨手放大的保險係數', async () => {
    const dir = await tmpDir('vidcut-est-worst-');
    const req: CardRequest = {
      text: '一二三四五六七八九十',
      style: { fontFamily: 'x', fontSize: 512, fill: '#fff' },
      width: 1080,
      maxWidthFrac: 0.1,
    };
    const est = estimateCard(req);
    expect(est.lines).toBe(10);
    const geo = await raster.rasterize(req, join(dir, 'w.base.png'));
    expect(geo.lines).toBe(est.lines); // 等號：再緊一點的估算就會低估
    expect(geo.width * geo.height).toBe(est.pixels);
  }, 30_000);

  it('有 tokens 時估算是上界（每行至少一個詞）——寧可高估，絕不低估', async () => {
    const dir = await tmpDir('vidcut-est-tok-');
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

// ---- 行數上界的地基：「沒有字元寬過 MAX_ADVANCE_EM 個 em」----
//
// 2026-08-04（第二次）：行數上界從「每個字元各佔一行」收緊成
// 「floor(2 × 字元數 × MAX_ADVANCE_EM × fontSize ÷ 可用寬) + 1」（見 cardBudget.ts）。
// 新式子唯一的假設就是那個 3 em——**它是量出來的**，所以這裡真的再量一次：
// 換字型／加字型時這條會當場失敗，而不是等到某天一張卡默默超出預算。
const FONT_SCAN_PY = `
import json, sys
from PIL import Image, ImageDraw, ImageFont
tmp = Image.new("RGBA", (1, 1)); d = ImageDraw.Draw(tmp)
SIZE = 64
# 整個 BMP + emoji / 數學字母 / CJK ext-B 開頭幾段星號平面
RANGES = [(0x20,0xFFFF),(0x1F300,0x1FAFF),(0x1D400,0x1D7FF),(0x20000,0x2007F)]
out = []
for path in sys.argv[1:]:
    f = ImageFont.truetype(path, SIZE)
    best, cp_best = 0.0, 0
    for lo, hi in RANGES:
        for cp in range(lo, hi + 1):
            try:
                w = d.textlength(chr(cp), font=f)
            except Exception:
                continue
            if w > best: best, cp_best = w, cp
    out.append({"path": path, "em": best / SIZE, "cp": cp_best})
print(json.dumps(out))
`;
import { tmpDir } from './tmp.js';

async function scanWidestGlyphs(
  paths: string[],
): Promise<Array<{ path: string; em: number; cp: number }>> {
  const { stdout } = await execFileP('python3', ['-c', FONT_SCAN_PY, ...paths]);
  return JSON.parse(stdout) as Array<{ path: string; em: number; cp: number }>;
}

describe('MAX_ADVANCE_EM 的前提：字型表裡沒有字元寬過這個倍數', () => {
  it('掃過每個可用字型的整個 BMP＋星號平面樣本，最寬字元 ≤ MAX_ADVANCE_EM em', async () => {
    const table = await loadFontTable(raster);
    expect(table.length).toBeGreaterThan(0); // 一個字型都載不起來的話這條就沒在驗東西
    const scan = await scanWidestGlyphs(table.map((f) => f.path));
    for (const r of scan) {
      // 失敗時要看得出是哪個字型的哪個字元把上界撐破的（不是只看到一個 false）
      expect(
        r.em,
        `${r.path} 最寬字元 U+${r.cp.toString(16).toUpperCase()} = ${r.em.toFixed(3)} em`,
      ).toBeLessThanOrEqual(MAX_ADVANCE_EM);
    }
    // 也順便釘住「這個常數不是無限保守」：本機最寬的字型（Arial Unicode 的 U+FDA9
    // 阿拉伯連字 2.27 em）已經吃掉 3 em 的三分之二以上。
    expect(Math.max(...scan.map((r) => r.em))).toBeGreaterThan(MAX_ADVANCE_EM / 2);
  }, 180_000);
});

// 用**全字型表最寬**的字型（Arial Unicode MS）跑對抗式案例：預設的字型解析器回 undefined
// → python 退回 STHeiti（最寬 1.19 em），撐不出真正的最壞情況，把 2 倍係數拿掉都測不出來。
const WIDE_FONT = '/System/Library/Fonts/Supplemental/Arial Unicode.ttf';
const hasWideFont = existsSync(WIDE_FONT);
const wideRaster = new PillowRasterizer(() => WIDE_FONT);
afterAll(() => wideRaster.dispose());

describe.skipIf(!hasWideFont)('新行數上界的對抗式驗證（真的排版，比實際行數）', () => {
  // 可用寬 = 1080 − cardMargin(1080, 0.9) × 2 = 972
  const F = 64;
  const req = (text: string, extra: Partial<CardRequest> = {}): CardRequest => ({
    text,
    style: { fontFamily: 'Arial Unicode MS', fontSize: F, fill: '#fff' },
    width: 1080,
    ...extra,
  });
  // 鋸齒：一個接近滿寬的不可斷長單字後面跟一個單字元 → 每兩行才用掉約一個可用寬，
  // 這正是式子裡那個 2 倍的來源。
  const zigzag = Array.from({ length: 40 }, (_, i) => (i % 2 ? 'i' : 'm'.repeat(18))).join(' ');
  // 最寬字元（U+FDA9，2.27 em ＝ 145px）四個一組 ＝ 580px > 可用寬的一半 → 每行只放得下一組
  const widestAtoms = Array.from({ length: 120 }, () => 'ﶩﶩﶩﶩ').join(' ');
  const cases: Array<[string, CardRequest]> = [
    ['鋸齒（長單字與單字元交錯）', req(zigzag)],
    ['最寬字元組成的原子，每行只放得下一組', req(widestAtoms)],
    ['真實中文長段（新上限 369 字）', req('天地玄黃宇宙洪荒日月盈昃'.repeat(30) + '辰宿列張')],
    ['英文散文', req('the quick brown fox jumps over the lazy dog '.repeat(15))],
    ['emoji（星號平面：JS 長度 2、python 1 字元）', req('😀🎉'.repeat(80))],
    ['換行寬壓到最小（0.1）＋混合中英', req('中文abc'.repeat(20), { maxWidthFrac: 0.1 })],
    [
      'karaoke tokens 長句',
      req('詞'.repeat(120), { tokens: Array.from({ length: 120 }, () => '詞') }),
    ],
  ];
  for (const [name, r] of cases) {
    it(`${name}：實際行數 ≤ 估算行數`, async () => {
      const dir = await tmpDir('vidcut-adv-');
      const geo = await wideRaster.rasterize(r, join(dir, 'a.base.png'));
      const est = estimateCard(r);
      expect(est.lines).toBeGreaterThanOrEqual(geo.lines);
      expect(est.height).toBeGreaterThanOrEqual(geo.height);
      expect(est.pixels).toBeGreaterThanOrEqual(geo.width * geo.height);
    }, 60_000);
  }

  // 上界不能只是「安全」，還要說得出有多鬆。這條把最緊的對抗案例釘住：
  // 拿掉式子裡的 2 倍係數會讓它掉到 1 以上（上面那批 ≤ 就會先紅——這也是
  // widestAtoms 用 120 組而不是 60 組的原因：60 組時「拿掉 2 倍」剛好卡在等號上，
  // 測不出來），把 MAX_ADVANCE_EM 放大到 6 則會讓它掉到 0.25 而在這裡被抓到。
  //
  // 這個 case 實測穩定在 **0.5063**（80 行 ÷ 158 行），0.45 是留約 11% 餘裕的下限。
  // （2026-08-05 有一次審查建議把下限收到 0.65，理由是「實測其實是 0.710」——覆核後
  // 不採納：重跑就是 0.5063，0.65 會讓這條當場紅。那個 0.710 來自另一組取樣掃描的
  // 最緊值，跟這個構造不是同一件事。至於它想防的「MAX_ADVANCE_EM 被調小到 2」，
  // 有下面「估算式＝floor(...)」那條把行數硬釘在 40 擋著，K=2 會算出 27，
  // 是硬失敗、沒有餘裕問題，不需要靠這條的下限去抓。）
  it('最緊的對抗案例：實際／估算 ≈ 0.51（2 倍係數與 3 em 都不是隨手放大的）', async () => {
    const dir = await tmpDir('vidcut-adv-tight-');
    const r = req(Array.from({ length: 120 }, () => 'ﶩﶩﶩﶩ').join(' '));
    const geo = await wideRaster.rasterize(r, join(dir, 't.base.png'));
    const est = estimateCard(r);
    expect(geo.lines / est.lines).toBeGreaterThan(0.45);
    expect(geo.lines / est.lines).toBeLessThanOrEqual(1);
  }, 60_000);
});

describe('收緊之後的實務上限（這次改動要解決的問題本身）', () => {
  // 式子本身的釘子（不必真的排版）：可用寬 = 1080 − cardMargin(1080, 0.9)×2 = 972，
  // 100 個字元、fontSize 64 → floor(2 × 100 × 3em × 64 ÷ 972) + 1 = floor(39.5) + 1 = 40。
  // 2 倍係數、3 em、可用寬三者任何一個被動到，這條就會紅——上面那批對抗案例是
  // 「安全性」的證據，這條是「式子沒被偷改」的證據。
  it('估算式＝floor(2 × 字元數 × MAX_ADVANCE_EM × fontSize ÷ 可用寬) + 1', () => {
    const est = estimateCard({
      text: 'x'.repeat(100),
      style: { fontFamily: 'Heiti TC', fontSize: 64, fill: '#fff' },
      width: 1080,
    });
    expect(est.lines).toBe(Math.floor((2 * 100 * MAX_ADVANCE_EM * 64) / 972) + 1);
    expect(est.lines).toBe(40);
  });

  const req = (text: string, fontSize = 64): CardRequest => ({
    text,
    style: { fontFamily: 'Heiti TC', fontSize, fill: '#ffffff' },
    width: 1080,
  });
  const oldEstimateRejects = (text: string, fontSize = 64): boolean => {
    // 收緊前的估算式：每個字元各佔一行（Σ 各段落 max(1, 字元數)）
    const lineH = fontSize + Math.max(6, Math.floor(fontSize / 5));
    return 1080 * (lineH * text.length + 8) > MAX_CARD_PIXELS;
  };

  it('1080 寬 / fontSize 64 的上限從 146 字變成 369 字', () => {
    expect(cardRequestError(req('字'.repeat(369)))).toBeNull();
    expect(cardRequestError(req('字'.repeat(370)))).toMatch(/too large/);
    // 舊估算在第 147 字就會拒——這條同時證明「146」那個數字不是我編的
    expect(oldEstimateRejects('字'.repeat(146))).toBe(false);
    expect(oldEstimateRejects('字'.repeat(147))).toBe(true);
  });

  it('一段 163 字的真實中文散文：舊估算會拒，現在收得下（實際只折成十幾行）', () => {
    const para =
      '在台北的午後，我沿著河堤慢慢地走，風把樹葉吹得沙沙作響，遠處的觀音山被薄霧籠罩著，' +
      '像是一幅還沒乾透的水彩畫。攤販推著車經過，鐵輪在石板路上發出規律的聲響，' +
      '孩子們追著一隻流浪貓跑過草地，笑聲一路灑到堤防的另一端。我停下腳步，' +
      '看著河面上倒映的天光慢慢變成橘紅色，忽然覺得這座城市其實一直都很溫柔，' +
      '只是我們太忙，忘了停下來看它一眼。';
    expect(para.length).toBeGreaterThan(146); // 舊上限之外
    expect(oldEstimateRejects(para)).toBe(true);
    expect(cardRequestError(req(para))).toBeNull();
  });

  // karaoke 走 layout_tokens（另一個貪婪迴圈），舊估算是「行數 ≤ 詞數」。同一套論證
  // 適用，所以一起收緊——不然同一句話「加了逐詞時間戳就變成太大」會很難解釋。
  it('karaoke（tokens）一起收緊：160 個詞的字幕從被拒變成收得下', () => {
    const tokens = Array.from({ length: 160 }, () => '詞');
    const r: CardRequest = {
      text: tokens.join(''),
      tokens,
      style: { fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' },
      width: 1080,
    };
    // 舊估算＝詞數就是行數 → 160 行 × line_h 76 已經超出預算
    expect(1080 * (76 * 160 + 8)).toBeGreaterThan(MAX_CARD_PIXELS);
    expect(cardRequestError(r)).toBeNull();
    expect(estimateCard(r).lines).toBeLessThan(tokens.length);
  });

  it('收緊的是估算、不是預算：估算出來的像素數仍然不得超過 MAX_CARD_PIXELS', () => {
    expect(estimateCard(req('字'.repeat(369))).pixels).toBeLessThanOrEqual(MAX_CARD_PIXELS);
    expect(estimateCard(req('字'.repeat(370))).pixels).toBeGreaterThan(MAX_CARD_PIXELS);
    // reviewer 那個 40 GB payload 照樣被算成天文數字（4001 個空段落 → 每段仍佔一行）
    expect(
      estimateCard({
        text: '\n'.repeat(4000),
        style: { fontFamily: 'Heiti TC', fontSize: 512, fill: '#ffffff' },
        width: 4096,
        maxWidthFrac: 1,
      }).pixels,
    ).toBeGreaterThan(10e9);
  });
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
    const dir = await tmpDir('vidcut-budget-');
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
    const dir = await tmpDir('vidcut-budget-ok-');
    const svc = new TextCardService(dir, raster);
    // 1080 寬、fontSize 64（line_h 76）→ 157 行 = 11,940px 高 ≈ 12.9 Mpx（超標，用來卡上界）
    const overLines = 156;
    // 每段刻意只有**一個字元**：這樣「上界行數」＝「實際行數」＝ 段落數，
    // 邊界才卡得準。（自動換行上線後估算改成逐字元上界，用「第123行」這種
    // 多字元段落會讓上界＝字元數，邊界就不是行數了。）
    const under: CardRequest = {
      text: Array.from({ length: 145 }, () => '字').join('\n'),
      style: { fontFamily: 'Heiti TC', fontSize: 64, fill: '#ffffff' },
      width: 1080,
    };
    expect(estimateCard(under).pixels).toBeLessThanOrEqual(MAX_CARD_PIXELS);
    const r = await svc.ensure(under);
    expect(r.width * r.height).toBeLessThanOrEqual(MAX_CARD_PIXELS);

    // 多幾行就越界 → 拒絕（邊界兩側都驗過，不是只驗一邊）
    const over: CardRequest = {
      ...under,
      text: Array.from({ length: overLines }, () => '字').join('\n'),
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
    const dir = await tmpDir('vidcut-render-budget-');
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
    const dir = await tmpDir('vidcut-render-ok-');
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

/**
 * 自動換行讓「匯出端的 margin 從哪來」第一次變成看得見的事。
 *
 * 匯出路徑（render.ts 自己 spawn `text_card.py`）以前**不傳 margin**，靠 python 的
 * 預設 `max(32, width // 20)`；預覽路徑（rasterizer）傳的是 `cardMargin(width, 0.9)`
 * ＝ `round(width * 0.05)`。兩式在 width ≥ 640 時剛好同值（1080→54、720→36、640→32），
 * 所以「不換行」的年代永遠看不出差別。畫布寬 < 640 時兩式會分岔（500 → 25 vs 32），
 * 一旦真的折行就會變成「預覽折三行、成品折兩行」——這是本分支招牌宣稱的直接破口，
 * 而且只在小畫布的專案上出現，最容易漏掉。
 */
describe('小畫布寬時匯出字卡與預覽字卡仍然是同一張圖（換行寬同源）', () => {
  it('canvas width 500：renderCaptionCard 與 rasterize 的 PNG 位元組相同，且真的折行了', async () => {
    const width = 500; // python 預設 margin = max(32, 25) = 32；cardMargin(500) = 25
    const dir = await tmpDir('vidcut-margin-');
    await mkdir(join(dir, 'derived', 'captions'), { recursive: true });
    // fontSize 45 刻意挑過：全形字 advance 恰好 45px，可用寬 450（cardMargin）放得下
    // 整整 10 字、436（python 預設 margin 32）只放得下 9 字 → 兩式會折出 2 行 vs 3 行。
    // 換成 48 之類的字級兩邊都是 9 字/行，這條測試就會變成永遠通過的假斷言。
    const cap: CaptionItem = {
      id: 'narrow',
      text: '一二三四五六七八九十壹貳參肆伍陸柒捌玖拾',
      start: 0,
      duration: 2,
      style: { fontFamily: 'Heiti TC', fontSize: 45, fill: '#ffffff', y: 0.8 },
    };
    const rel = await renderCaptionCard(dir, cap, width);
    const previewPath = join(dir, 'preview.png');
    const geo = await raster.rasterize(capToCardRequest(cap, width), previewPath);
    // 這條卡真的被折過（否則兩邊相同只是因為「都只有一行」，斷言就沒有鑑別力）
    expect(geo.lines).toBeGreaterThan(1);
    const [exportBuf, previewBuf] = await Promise.all([
      readFile(join(dir, rel)),
      readFile(previewPath),
    ]);
    expect(exportBuf.equals(previewBuf)).toBe(true);
  }, 30_000);
});
