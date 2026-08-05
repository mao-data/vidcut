import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fontFallbackError, renderCaptionCard, setCaptionFontResolver } from '../src/render.js';
import { PillowRasterizer } from '../src/rasterizer.js';
import { loadFontTable, fontResolver } from '../src/fonts.js';
import { DEFAULT_CAPTION_STYLE } from '@vidcut/shared';

afterEach(() => setCaptionFontResolver(() => undefined)); // 測試間不互相污染

// 混合拉丁 + CJK,且夠長——不同字型的字距(advance width)差異在這種文字上才會
// 實際反映到排版/畫素上。純 CJK 短字串(如「字型測試」)在任何裝好的字型下都只會
// 排成一行,量不出差異。
const TEXT = 'Caption 字型 WYSIWYG test';
const cap = { id: 'c1', text: TEXT, start: 0, duration: 1, style: DEFAULT_CAPTION_STYLE };

// text_card.py 的舊候選鏈(fontPath 為 null/未注入時的退回路徑)——抄自
// server/scripts/text_card.py 的 FONT_CANDIDATES,用來在執行期判斷這台機器上
// legacy chain 實際會落到哪個字型檔,才能挑一個「保證跟它不同」的 fontFamily 來測。
const LEGACY_CANDIDATES = [
  '/System/Library/Fonts/PingFang.ttc',
  '/System/Library/Fonts/STHeiti Medium.ttc',
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
];

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

describe('匯出字卡的字型解析', () => {
  it(
    '注入 resolver 後,匯出字卡與預覽字卡走同一個字型檔(位元組相同);' +
      '未注入時退回 legacy chain,視覺輸出必須不同(判別性防護)',
    async (ctx) => {
      const dir = await mkdtemp(join(tmpdir(), 'vidcut-rf-'));
      await mkdir(join(dir, 'derived', 'captions'), { recursive: true });
      const raster = new PillowRasterizer(() => undefined);
      try {
        const table = await loadFontTable(raster);

        // legacy chain 在這台機器上第一個 probe 成功的字型檔
        let legacyPath: string | undefined;
        for (const p of LEGACY_CANDIDATES) {
          if (await raster.probeFont(p)) {
            legacyPath = p;
            break;
          }
        }

        // 挑字型表裡路徑保證跟 legacyPath 不同的一筆——優先 Arial Unicode MS
        // (legacy chain 在 CJK 系統上通常先命中 PingFang/STHeiti,Arial Unicode 排在候選鏈尾段)。
        const distinctEntry =
          table.find((f) => f.family === 'Arial Unicode MS' && f.path !== legacyPath) ??
          table.find((f) => f.path !== legacyPath);

        if (!distinctEntry) {
          // 這台機器上字型表跟 legacy chain 撞到同一個檔案,量不出差異——
          // 明確跳過並說明原因,不要讓斷言變成永遠為真的假通過。
          ctx.skip(
            `字型表(${table.map((f) => f.family).join(', ')})找不到與 legacy chain 落點` +
              `(${legacyPath ?? '(none)'})不同的字型,無法驗證判別性,跳過。`,
          );
        }
        const entry = distinctEntry!;

        const resolve = fontResolver(table);
        raster.resolveFontPath = resolve;
        const testCap = { ...cap, style: { ...cap.style, fontFamily: entry.family } };

        // ---- (a) 平價性:注入 resolver 後,匯出路徑與預覽路徑走同一個字型檔 ----
        setCaptionFontResolver(resolve);
        const relInjected = await renderCaptionCard(dir, testCap, 1080);

        const previewPath = join(dir, 'preview.png');
        await raster.rasterize(
          {
            text: testCap.text,
            style: {
              fontFamily: testCap.style.fontFamily,
              fontSize: testCap.style.fontSize,
              fill: testCap.style.fill,
              stroke: testCap.style.stroke,
            },
            width: 1080,
          },
          previewPath,
        );

        const [injectedBuf, previewBuf] = await Promise.all([
          readFile(join(dir, relInjected)),
          readFile(previewPath),
        ]);
        expect(sha256(injectedBuf)).toBe(sha256(previewBuf));

        // ---- (b) 判別性防護:不注入 resolver 時退回 legacy chain,
        // 視覺輸出必須跟預覽「不同」——這條斷言存在的意義是證明這個測試真的
        // 抓得到迴歸(把 render.ts 的 fontPath 那行拿掉,這條會失敗)。
        // 別因為它看起來像是在斷言「失敗」就把它刪掉:刪了,這份測試就變成
        // 不管怎麼改都會過的假測試。
        setCaptionFontResolver(() => undefined);
        const dir2 = await mkdtemp(join(tmpdir(), 'vidcut-rf-'));
        await mkdir(join(dir2, 'derived', 'captions'), { recursive: true });
        const relFallback = await renderCaptionCard(dir2, testCap, 1080);
        const fallbackBuf = await readFile(join(dir2, relFallback));
        expect(sha256(fallbackBuf)).not.toBe(sha256(previewBuf));
      } finally {
        raster.dispose();
      }
    },
    30_000,
  );

  it('未注入 resolver 時仍可產卡(舊行為不壞)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-rf-'));
    await mkdir(join(dir, 'derived', 'captions'), { recursive: true });
    const rel = await renderCaptionCard(dir, cap, 1080);
    expect(rel).toContain('derived/captions');
  }, 30_000);
});

/**
 * 「一個字型都開不了」的降級路徑（2026-08-05）。在此之前 `fonts.ts` 的 CANDIDATES 與
 * `text_card.py` 的 FONT_CANDIDATES **都只有 macOS 路徑**，所以在 Linux/CI 上字型表必然是空的
 * → resolver 回 undefined → python 候選鏈全滅 → 掉進 Pillow 內建的點陣字型：沒有中日韓
 * 字符、字重與描邊都不對。而預覽與匯出吃的是同一張壞卡，所以畫面上看不出異常，
 * `verify:wysiwyg` 也照樣全綠——一路靜默到成品燒進一排小豆腐字為止。
 */
describe('字型全滅時不得靜默交出成品', () => {
  it('text_card.py：候選鏈全滅時回報 fontFallback（CLI 模式也要帶出來）', async () => {
    // 把腳本複製一份、清空候選鏈，模擬「這台機器沒有任何字型」
    const dir = await mkdtemp(join(tmpdir(), 'vidcut-nofont-'));
    const src = join(import.meta.dirname, '../scripts/text_card.py');
    const patched = join(dir, 'text_card.py');
    const body = await readFile(src, 'utf8');
    expect(body).toContain('FONT_CANDIDATES = [');
    await writeFile(patched, body.replace(/FONT_CANDIDATES = \[[^\]]*\]/, 'FONT_CANDIDATES = []'));

    const run = (cfg: Record<string, unknown>): Promise<string> =>
      new Promise((res, rej) => {
        const c = spawn('python3', [patched], { stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        c.stdout.on('data', (d) => (out += d));
        c.stderr.on('data', (d) => (err += d));
        c.on('close', (code) => (code === 0 ? res(out) : rej(new Error(err))));
        c.stdin.end(JSON.stringify(cfg));
      });

    const base = {
      text: '嗨 hello',
      fontSize: 64,
      fill: '#ffffff',
      width: 1080,
      margin: 54,
    };
    const fell = JSON.parse(await run({ ...base, out: join(dir, 'a.png') })) as {
      fontFallback?: boolean;
    };
    expect(fell.fontFallback).toBe(true);

    // 對照組：同一份腳本、原封不動的候選鏈 → 不該回報 fallback（否則這條測試恆真）
    const ok = JSON.parse(
      await new Promise<string>((res, rej) => {
        const c = spawn('python3', [src], { stdio: ['pipe', 'pipe', 'ignore'] });
        let out = '';
        c.stdout.on('data', (d) => (out += d));
        c.on('close', (code) => (code === 0 ? res(out) : rej(new Error('exit ' + code))));
        c.stdin.end(JSON.stringify({ ...base, out: join(dir, 'b.png') }));
      }),
    ) as { fontFallback?: boolean };
    expect(ok.fontFallback).toBeUndefined();
  }, 60_000);

  it('render 端把 fontFallback 當成中止條件，不是警告', () => {
    expect(
      fontFallbackError(JSON.stringify({ width: 1080, fontFallback: true }), 'cap1'),
    ).toContain('cap1');
    expect(fontFallbackError(JSON.stringify({ width: 1080 }), 'cap1')).toBeNull();
    // 輸出不是 JSON 時不擋（圖已經寫出來了，唯一的退場條件是那個旗標）
    expect(fontFallbackError('some python warning\n', 'cap1')).toBeNull();
    expect(fontFallbackError('', 'cap1')).toBeNull();
  });
});
