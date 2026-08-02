/**
 * 面板收合/展開控制項的可用性回歸檢查（真瀏覽器，非 jsdom）。
 *
 * 為什麼不是 vitest：這些是「元素有沒有被別人蓋住 / 有沒有被捲出視窗」的問題，
 * 需要真的排版與命中測試，jsdom 沒有版面引擎，量不出來。
 *
 * 前置：`npm run demo`（server 起在 :3845 並吃 ui/dist）＋ `npm run build -w @vidcut/ui`。
 * 執行：`npm run verify:panels`
 * Chrome 路徑可用 CHROME_BIN 覆寫。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const APP_URL = process.env.VIDCUT_URL ?? 'http://127.0.0.1:3845/';
const CDP_PORT = 9333;
const VIEWPORT = { w: 1440, h: 820 };

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const pw = join(homedir(), 'Library/Caches/ms-playwright');
  if (existsSync(pw)) {
    for (const dir of readdirSync(pw).filter((d) => d.startsWith('chromium-'))) {
      for (const app of [
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-linux/chrome',
      ]) {
        const p = join(pw, dir, app);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]) {
    if (existsSync(p)) return p;
  }
  throw new Error('找不到 Chrome/Chromium，請設 CHROME_BIN');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // 還沒起來
    }
    await sleep(250);
  }
  throw new Error('CDP 連不上');
}

async function main() {
  try {
    const r = await fetch(APP_URL);
    if (!r.ok) throw new Error(String(r.status));
  } catch (e) {
    console.error(`✗ ${APP_URL} 沒有回應（先跑 npm run demo）：${e.message}`);
    process.exit(2);
  }

  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--window-size=${VIEWPORT.w},${VIEWPORT.h}`,
      '--user-data-dir=' + join(process.env.TMPDIR ?? '/tmp', 'vidcut-e2e-profile'),
      '--no-first-run',
      '--disable-gpu',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let ws;
  const failures = [];
  try {
    ws = new WebSocket(await connect(), { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => {
      ws.on('open', res);
      ws.on('error', rej);
    });

    let id = 0;
    const pending = new Map();
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    });
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    const evalJs = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: APP_URL });
    // 等專案真的載進來：doc 還沒到時 Player 回 null、時間軸是空的，版面高度會不一樣，
    // 用固定 sleep 量到的會是載入中的版面（而不是使用者看到的版面）。
    let ready = false;
    for (let i = 0; i < 60; i++) {
      ready = await evalJs(
        `!!document.querySelector('video') && !!document.querySelector('button[title="Collapse"]')`,
      );
      if (ready) break;
      await sleep(250);
    }
    if (!ready) throw new Error('專案沒有在 15 秒內載入');
    // 關掉所有過渡/動畫再量。headless 的畫面被節流時 CSS transition 可能整整幾秒不推進，
    // 於是量到收合「前」的版面；這裡要驗的是終態版面，不是動畫本身。
    await evalJs(`(() => {
      const s = document.createElement('style');
      s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
      document.head.appendChild(s);
      return 1;
    })()`);
    await sleep(300);

    /** 元素中心點的命中測試：回 true 表示這個位置真的點得到它（沒被蓋、沒被裁掉）。 */
    const clickable = (title) => `(() => {
      const b = document.querySelector('button[title="${title}"]');
      if (!b) return { ok: false, why: '按鈕不存在' };
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return { ok: false, why: '尺寸為 0' };
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) {
        return { ok: false, why: \`中心點在視窗外 (\${Math.round(cx)}, \${Math.round(cy)})\` };
      }
      const top = document.elementFromPoint(cx, cy);
      if (!top || !(b === top || b.contains(top))) {
        return { ok: false, why: '被 ' + (top ? top.tagName + '「' + (top.textContent || '').trim().slice(0, 24) + '」' : 'null') + ' 蓋住' };
      }
      return { ok: true };
    })()`;

    const click = (title) =>
      evalJs(`document.querySelector('button[title="${title}"]')?.click(), 1`);
    const check = async (name, expr) => {
      const r = await evalJs(expr);
      if (r?.ok) console.log(`  ✓ ${name}`);
      else {
        console.log(`  ✗ ${name} — ${r?.why ?? '未知'}`);
        failures.push(name);
      }
    };

    /**
     * 等 grid 的 0.25s 收合過渡跑完再量。用固定 sleep 會偶爾量到過渡中的座標
     * （右欄還留著 320px），量出來的重疊關係是假的。
     */
    /**
     * 等 grid 的 0.25s 收合過渡真的跑完。用「座標連續幾次相同」判斷會誤判——
     * 過渡還沒起跑的那幾幀座標也是不變的，於是量到收合前的版面。
     * 這裡直接等收合的終態：左右軌都變成 0px。
     */
    const collapsedCols = async () => {
      let last = null;
      for (let i = 0; i < 60; i++) {
        last = await evalJs(`(() => {
          const g = [...document.querySelectorAll('div')].find((d) => {
            const s = getComputedStyle(d);
            return s.display === 'grid' && s.gridTemplateColumns.split(' ').length === 3;
          });
          return g ? getComputedStyle(g).gridTemplateColumns : 'no-grid';
        })()`);
        const tracks = last.split(' ');
        if (tracks.length === 3 && tracks[0] === '0px' && tracks[2] === '0px') return;
        await sleep(100);
      }
      throw new Error(`面板沒有在 6 秒內收合完成（gridTemplateColumns=${last}）`);
    };

    // 兩側面板都收合
    await click('Collapse');
    await click('Collapse properties panel');
    await collapsedCols();

    console.log('收合後、未開下拉：');
    await check('右側展開鈕可點', clickable('Expand captions/activity panel'));
    await check('左側展開鈕可點', clickable('Expand properties panel'));

    console.log('Export 下拉開啟時：');
    await click('Export settings');
    await sleep(400);
    // 沒真的開起來的話，下面兩項會假性通過——先確認它開了、而且真的疊在右鈕上方
    await check(
      '下拉確實開啟且與右鈕重疊（前置條件）',
      `(() => {
        const p = document.querySelector('[data-export-pop]');
        if (!p) return { ok: false, why: '下拉沒開，這兩項檢查沒有意義' };
        const a = p.getBoundingClientRect();
        const b = document.querySelector('button[title="Expand captions/activity panel"]')?.getBoundingClientRect();
        if (!b) return { ok: false, why: '右鈕不存在' };
        const overlaps = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        const box = (x) => \`[\${Math.round(x.left)},\${Math.round(x.top)} → \${Math.round(x.right)},\${Math.round(x.bottom)}]\`;
        return overlaps
          ? { ok: true }
          : { ok: false, why: \`兩者沒有重疊，這個 case 沒測到東西。pop=\${box(a)} btn=\${box(b)} vp=\${innerWidth}x\${innerHeight}\` };
      })()`,
    );
    await check('右側展開鈕不被下拉蓋住', clickable('Expand captions/activity panel'));
    await check('左側展開鈕不被下拉蓋住', clickable('Expand properties panel'));
    await click('Export settings');
    await sleep(300);

    console.log('中欄捲到底時：');
    const scrolled = await evalJs(`(() => {
      const all = [...document.querySelectorAll('div')].filter((el) => {
        const s = getComputedStyle(el);
        return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
      });
      all.forEach((el) => { el.scrollTop = el.scrollHeight; });
      return all.length;
    })()`);
    console.log(`  （把 ${scrolled} 個可捲動容器捲到底）`);
    await sleep(300);
    await check('捲動後右側展開鈕仍可點', clickable('Expand captions/activity panel'));
    await check('捲動後左側展開鈕仍可點', clickable('Expand properties panel'));

    console.log('預覽區尺寸：');
    await check(
      '預覽依容器縮放、不產生捲軸',
      `(() => {
        const v = document.querySelector('video');
        if (!v) return { ok: false, why: '找不到 <video>' };
        let el = v.parentElement, sc = null;
        while (el) {
          if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1) { sc = el; break; }
          el = el.parentElement;
        }
        return sc
          ? { ok: false, why: \`預覽欄溢位 scrollHeight \${sc.scrollHeight} > clientHeight \${sc.clientHeight}\` }
          : { ok: true };
      })()`,
    );

    console.log('展開狀態下的伸縮把手：');
    await click('Expand captions/activity panel');
    await sleep(300);
    await click('Expand properties panel');
    await sleep(500);
    await check(
      '中欄底部仍有左側伸縮熱區',
      `(() => {
        const grid = document.querySelector('.resizer')?.parentElement;
        if (!grid) return { ok: false, why: '找不到 resizer' };
        const mid = grid.getBoundingClientRect();
        const res = [...document.querySelectorAll('.resizer')].map((r) => r.getBoundingClientRect());
        const y = mid.bottom - 4;
        const covered = res.some((r) => r.top <= y && r.bottom >= y);
        return covered ? { ok: true } : { ok: false, why: '底部 y=' + Math.round(y) + ' 沒有任何 resizer 覆蓋' };
      })()`,
    );
  } finally {
    ws?.close();
    chrome.kill();
  }

  if (failures.length) {
    console.error(`\n✗ ${failures.length} 項失敗：${failures.join('、')}`);
    process.exit(1);
  }
  console.log('\n✓ 全部通過');
}

await main();
