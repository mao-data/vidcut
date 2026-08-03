#!/usr/bin/env node
/**
 * 預覽音訊同步驗收探針（spec 2026-08-02-preview-audio-sync B3）。
 *
 * 對運行中的 vidcut（預設 http://127.0.0.1:3845）headless 播放 4.5 秒，
 * 統計 media 元素的 seeking / waiting 事件。修正前基線：seeking 41+41、
 * waiting 41+40（每 ~83ms 一次的 seek 風暴＝聽感上的混雜雜音）。
 * 驗收：seeking 合計 ≤ 4 且無週期性 waiting。
 *
 * 需求：npm i（devDep playwright-core）＋ ms-playwright 的 Chromium 快取。
 * 用法：node scripts/audio-probe.mjs [url]
 */
import { chromium } from 'playwright-core';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:3845';

// 找 ms-playwright 快取裡最新的 chromium-*（不強依賴特定版號）
const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
const chromiumDir = readdirSync(cache)
  .filter((d) => /^chromium-\d+$/.test(d))
  .sort()
  .pop();
if (!chromiumDir)
  throw new Error('ms-playwright 快取裡沒有 chromium，先跑 npx playwright install chromium');
const exe = path.join(
  cache,
  chromiumDir,
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
);

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();

await page.addInitScript(() => {
  window.__ev = [];
  for (const type of ['seeking', 'waiting', 'stalled']) {
    // media 事件不 bubble，但 capture 相位在 document 一樣攔得到
    document.addEventListener(
      type,
      (e) => {
        const el = e.target;
        if (el && (el.tagName === 'AUDIO' || el.tagName === 'VIDEO')) {
          window.__ev.push({ type, el: el.tagName, t: performance.now() });
        }
      },
      true,
    );
  }
});

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('[title="Play/Pause (Space)"]', { timeout: 15000 });
await page.waitForTimeout(1500); // 讓 media preload

await page.evaluate(() => {
  window.__ev.length = 0;
});
await page.click('[title="Play/Pause (Space)"]');
await page.waitForTimeout(4500);
await page.click('[title="Play/Pause (Space)"]');

const ev = await page.evaluate(() => window.__ev);
await browser.close();

const counts = {};
for (const e of ev) counts[`${e.type} ${e.el}`] = (counts[`${e.type} ${e.el}`] ?? 0) + 1;
console.log('=== 4.5 秒播放內的事件計數 ===');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(v, k);
const seeks = ev.filter((e) => e.type === 'seeking').length;
console.log(`total seeking: ${seeks}`);
console.log(seeks <= 4 ? 'PROBE: PASS（無 seek 風暴）' : 'PROBE: FAIL（seek 風暴仍在）');
process.exit(seeks <= 4 ? 0 : 1);
