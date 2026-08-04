/**
 * 「預覽即成品」的**幾何**回歸：真的渲染一支影片，再把成品的像素與預覽畫面對齊比對。
 *
 * 為什麼要有這支：`verify:canvas` 只證明「伺服器存了新座標」，它的「誤差 0.000%」
 * 只讀了 transform 矩陣的 a（scaleX）——看不到 maxWidth 夾制、看不到 position.scale
 * 有沒有被渲染端實作。這個 repo 從頭到尾**沒有人 render 過一次去比成品像素**
 * （HANDOFF.md 自己寫著），兩個真實落差就是靠讀程式碼、不是靠自動化發現的。
 * 這支腳本補的就是那條路：render → 抽幀 → 量墨跡外框；預覽 → 截圖 → 量同一個墨跡外框，
 * 兩邊都換算回 1080×1920 畫布座標再比。
 *
 * 執行：`npm run verify:wysiwyg`
 * 前置：`npm run build -w @vidcut/ui`（伺服器服務的是 ui/dist，不是原始碼）+ python3/Pillow。
 * **不需要**先起 server——這支腳本自己起一台（預設 :3999，`VIDCUT_WYSIWYG_PORT` 可改），
 * 吃自己在 os.tmpdir() 底下建的臨時專案，**完全不碰 projects/demo，也不碰 :3845 上那台**。
 * 每次跑都先把臨時專案整個刪掉重建 → 重跑任意次的起點都一樣（`verify:canvas` 那個
 * 「上一次的終點變成下一次的起點」的坑在這裡不存在）。
 * Chrome 路徑可用 CHROME_BIN 覆寫；視窗尺寸可用 VIDCUT_VIEWPORT（如 1400x1000）。
 *
 * ⚠️ 這支腳本**現在應該是紅的**：overlay 的兩項是已知缺陷（見 CLAUDE.md
 * 「『預覽即成品』的實際範圍」），字幕那項應該綠。字幕也紅＝量測本身壞了，先修腳本；
 * overlay 兩項綠＝斷言鬆掉了，也是腳本壞了。
 *
 * CDP 那段（findChrome/connect/send/evalJs 與 failures/exit code 慣例）是照抄
 * ui/e2e/canvas-direct.mjs 的——刻意不抽共用模組：抽了就得改 canvas-direct.mjs，
 * 而驗證它沒壞唯一的辦法是跑 `verify:canvas`，那支會寫回 projects/demo。
 * 等哪天有人要同時動這兩支再抽。
 */
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.VIDCUT_WYSIWYG_PORT ?? 3999);
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.VIDCUT_CDP_PORT ?? 9336);
const PROJECT_DIR = process.env.VIDCUT_WYSIWYG_DIR ?? join(tmpdir(), 'vidcut-wysiwyg-fixture');
/** 兩邊量到的畫面都留一份 PNG——數字對不上時，能直接開圖看是「位置錯」還是「量錯東西」。 */
const ART_DIR = join(PROJECT_DIR, 'measure');
const [vw, vh] = (process.env.VIDCUT_VIEWPORT ?? '1200x1400').split('x').map(Number);
const VIEWPORT = { w: vw, h: vh };

const CANVAS = { w: 1080, h: 1920, fps: 30 };

/**
 * 墨跡判定門檻（0–255 luma）。素材是純深灰 #181818（luma 24）、文字是白色 #ffffff
 * 配深色描邊，所以「亮過 128」就是白色字身，中間那條反鋸齒/描邊的灰階斜坡在兩邊
 * 都會被切在大約同一個相對位置——這正是我們敢用固定門檻跨「PNG 截圖」與
 * 「h264 解回來的幀」比對的理由（不是比像素，是比同一條等亮度線圍出來的外框）。
 */
const INK_LUMA = 128;

/**
 * 容差（1080×1920 畫布 px）。經驗值來源見檔尾 report 印的字幕那一列：
 * 字幕走的是「兩邊同一張 PNG、同一個位置」的路徑，它量到的誤差就是這套量測法
 * 的本底雜訊（h264 4:2:0 色度次取樣 + crf 壓縮讓邊緣斜坡位移、截圖在非整數
 * 縮放下重新光柵化、clip 原點四捨五入）。實測本底 ≤2px，取 4px 當門檻＝兩倍餘裕。
 * 已知的兩個落差都是幾十到上百 px 級，不可能躲在這裡面。
 */
const TOL_PX = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 子行程 / ffmpeg

function runProc(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, {
      stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      cwd: opts.cwd,
      env: opts.env,
    });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => {
      err += d;
    });
    p.on('error', rej);
    p.on('close', (code) =>
      code === 0
        ? res(Buffer.concat(out))
        : rej(new Error(`${cmd} exited ${code}: ${err.slice(-1200)}`)),
    );
    if (opts.input) {
      p.stdin.on('error', () => {}); // ffmpeg 提早收工時的 EPIPE，不是錯誤
      p.stdin.end(opts.input);
    }
  });
}

/** 任意來源 → rgb24 raw。兩條量測路徑（成品的幀、預覽的截圖）共用同一個解碼器，才有可比性。 */
async function rawRgb(args, input) {
  return runProc('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { input });
}

/** 成品的第 n 幀（不是 -ss 秒數：select=eq(n,N) 是幀精確的，沒有 seek 誤差的疑慮）。 */
async function exportFrame(mp4, frameIndex) {
  const data = await rawRgb([
    '-i',
    mp4,
    '-vf',
    `select=eq(n\\,${frameIndex})`,
    '-fps_mode',
    'passthrough',
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    'pipe:1',
  ]);
  const expect = CANVAS.w * CANVAS.h * 3;
  if (data.length !== expect) {
    throw new Error(`成品第 ${frameIndex} 幀解碼長度 ${data.length} ≠ 預期 ${expect}`);
  }
  return { data, w: CANVAS.w, h: CANVAS.h };
}

/** PNG（CDP 截圖）→ rgb24 raw。尺寸直接讀 IHDR，不必再開一個 ffprobe。 */
async function pngToRgb(png) {
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const data = await rawRgb(
    ['-f', 'image2pipe', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    png,
  );
  if (data.length !== w * h * 3) {
    throw new Error(`截圖解碼長度 ${data.length} ≠ 預期 ${w * h * 3}（${w}×${h}）`);
  }
  return { data, w, h };
}

/** 亮過門檻的像素的外接矩形。回 null＝整張圖都沒有墨跡。 */
function inkBBox(img, minLuma = INK_LUMA) {
  const { data, w, h } = img;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  let count = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w * 3;
    for (let x = 0; x < w; x++) {
      const i = row + x * 3;
      const luma = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      if (luma < minLuma) continue;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, count };
}

const fmtBox = (b) =>
  b
    ? `x0=${b.x0.toFixed(1)} y0=${b.y0.toFixed(1)} w=${b.w.toFixed(1)} h=${b.h.toFixed(1)}`
    : '（無墨跡）';

// ---------------------------------------------------------------- MCP（無狀態 HTTP）

let mcpId = 0;

/**
 * 呼叫一個 MCP 工具。伺服器是 stateless 模式（sessionIdGenerator: undefined），
 * 所以不需要 initialize 握手，直接 POST 一個 tools/call 就好；回應是 SSE 包一行 JSON。
 * 走 MCP 而不是直接 import server 的 TS：建 fixture 的每一步都因此跟 AI 使用者
 * 走同一條真路徑（含文字 overlay 的產卡前置），少一層「測試專用捷徑」的失真。
 */
async function mcp(name, args) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++mcpId,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await r.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  if (!line) throw new Error(`MCP ${name}: 回應不是 SSE：${text.slice(0, 400)}`);
  const msg = JSON.parse(line.slice(5));
  if (msg.error) throw new Error(`MCP ${name}: ${JSON.stringify(msg.error)}`);
  const res = msg.result;
  const asText = (res.content ?? []).map((c) => c.text ?? '').join(' ');
  if (res.isError) throw new Error(`MCP ${name}: ${asText}`);
  return { text: asText, data: res.structuredContent };
}

// ---------------------------------------------------------------- fixture

/**
 * 專門為了「量得準」而設計的素材：純深灰滿版直式影片（沒有 testsrc2 的花紋，
 * 亮度門檻才切得乾淨）、白字深描邊（墨跡＝白色字身，跟背景差 200+ luma）、
 * 三個項目各佔一段互不重疊的時間窗（同一幀只有一個東西，墨跡外框＝那個項目的外框，
 * 不必做連通區域分割這種會自己引入誤差的事）。
 */
const CASES = [
  {
    key: 'overlay-scale1',
    title: 'overlay（position.scale = 1）',
    frame: 15, // t = 0.5s
    note: '預覽端 Player.tsx 給 <img> 設 maxWidth: 1080*0.9，render.ts 是原生尺寸合成',
  },
  {
    key: 'overlay-scale05',
    title: 'overlay（position.scale = 0.5）',
    frame: 45, // t = 1.5s
    note: '預覽端吃 CSS scale(0.5)，render.ts 的 overlay 濾鏡鏈上根本沒有 scale',
  },
  {
    key: 'caption',
    title: '字幕（無逐詞高亮）',
    frame: 75, // t = 2.5s
    note: '兩邊同一張 PNG、同一個位置——這一項綠才代表量測本身是準的',
  },
];

async function buildFixture() {
  rmSync(PROJECT_DIR, { recursive: true, force: true });
  mkdirSync(ART_DIR, { recursive: true });
  // 純色滿版直式：畫布 1080×1920 → scale/pad 是恆等，成品像素＝合成結果，中間沒有縮放。
  await runProc('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x181818:s=${CANVAS.w}x${CANVAS.h}:d=3:r=${CANVAS.fps}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    join(PROJECT_DIR, 'bg.mp4'),
  ]);
}

async function populateProject() {
  // 字型：用伺服器字型表的第一個 family。預覽（rasterizer）與匯出（captionFontResolver）
  // 是同一個 resolver，取表內存在的 family 才能排除「字型 fallback 不同」這個雜訊源。
  const fonts = await (await fetch(`${BASE}/api/fonts`)).json();
  if (fonts.length === 0)
    throw new Error('伺服器字型表是空的（python3/Pillow 沒裝？）——沒有字卡就沒得比');
  const family = fonts[0].family;

  const imported = await mcp('import_media', { relPath: 'bg.mp4', label: 'bg' });
  const mediaId = imported.data.mediaId;
  await mcp('set_timeline', { clips: [{ mediaId, in: 0, duration: 3 }] });

  const text = {
    text: 'WYSIWYG',
    fontFamily: family,
    fontSize: 96,
    fill: '#ffffff',
    stroke: '#000000',
  };
  await mcp('add_overlay', {
    overlay: {
      id: 'ov_scale1',
      text,
      start: 0,
      duration: 1,
      position: { x: 0.5, y: 0.2, scale: 1 },
    },
  });
  await mcp('add_overlay', {
    overlay: {
      id: 'ov_scale05',
      text,
      start: 1,
      duration: 1,
      position: { x: 0.5, y: 0.2, scale: 0.5 },
    },
  });
  await mcp('set_captions', {
    captions: [
      {
        id: 'cap_plain',
        text: 'CAPTION',
        start: 2,
        duration: 1,
        style: { fontFamily: family, fontSize: 96, fill: '#ffffff', stroke: '#000000', y: 0.6 },
      },
    ],
  });
  // 字卡是 debounce 300ms 後才產的；預覽端沒有 hash 就會退回 DOM 近似（＝量到別的東西）。
  // 這裡等它產完，下面還會再驗一次「畫面上真的是 /text-card/*.png」。
  await sleep(1500);
  return { family };
}

// ---------------------------------------------------------------- Chrome / CDP

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

async function cdpTarget() {
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

// ---------------------------------------------------------------- main

async function main() {
  const failures = [];
  const notes = [];

  // 佔用中的 port 會讓後面每一步都在對別人的專案下指令——寧可一開始就停。
  try {
    await fetch(`${BASE}/api/project`);
    console.error(
      `✗ ${BASE} 已經有人在用。換一個：VIDCUT_WYSIWYG_PORT=4001 npm run verify:wysiwyg`,
    );
    process.exit(2);
  } catch {
    // 沒人在用，正常
  }
  if (!existsSync(join(ROOT, 'ui/dist/index.html'))) {
    console.error('✗ 找不到 ui/dist —— 先跑 `npm run build -w @vidcut/ui`');
    process.exit(2);
  }

  console.log(`臨時專案：${PROJECT_DIR}（每次跑都重建）`);
  await buildFixture();

  const server = spawn('npx', ['tsx', 'server/src/index.ts', PROJECT_DIR], {
    cwd: ROOT,
    env: { ...process.env, VIDCUT_PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let serverErr = '';
  server.stderr.on('data', (d) => {
    serverErr += d;
  });

  let chrome = null;
  let ws = null;
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      try {
        await fetch(`${BASE}/api/project`);
        up = true;
      } catch {
        await sleep(250);
      }
    }
    if (!up) throw new Error(`server 沒起來：${serverErr.slice(-800)}`);

    await populateProject();

    // ---- 匯出：跑一次真的 render ----
    console.log('render（真 ffmpeg，會花幾秒）…');
    const rendered = await mcp('render', { stamp: 'wysiwyg' });
    const mp4 = join(PROJECT_DIR, rendered.data.output);
    if (!existsSync(mp4)) throw new Error(`render 說成功了但找不到 ${mp4}`);

    const exportInk = {};
    for (const c of CASES) {
      exportInk[c.key] = inkBBox(await exportFrame(mp4, c.frame));
      if (!exportInk[c.key]) {
        throw new Error(`成品第 ${c.frame} 幀完全沒有墨跡（${c.title}）——fixture 或渲染壞了`);
      }
      await runProc('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        mp4,
        '-vf',
        `select=eq(n\\,${c.frame})`,
        '-fps_mode',
        'passthrough',
        '-frames:v',
        '1',
        join(ART_DIR, `${c.key}.export.png`),
      ]);
    }

    // ---- 預覽：真瀏覽器 ----
    chrome = spawn(
      findChrome(),
      [
        '--headless=new',
        `--remote-debugging-port=${CDP_PORT}`,
        `--window-size=${VIEWPORT.w},${VIEWPORT.h}`,
        '--user-data-dir=' + join(process.env.TMPDIR ?? '/tmp', 'vidcut-e2e-wysiwyg-profile'),
        '--no-first-run',
        '--disable-gpu',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );

    ws = new WebSocket(await cdpTarget(), { maxPayload: 128 * 1024 * 1024 });
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
    await send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.w,
      height: VIEWPORT.h,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // GSAP 是用 JS 逐幀寫 inline style 的，`animation: none !important` 攔不到它——
    // 只有 prefers-reduced-motion 能讓 motion.ts 的 motionOK() 回 false、整批 GSAP 動效
    // 直接不跑。不做這件事的後果是量到位移中的版面：實測過一次字幕那格的 stage 在
    // 「讀 rect」與「截圖」之間被面板動畫挪走，墨跡座標整整偏了 18 畫布 px（看起來像
    // 一個不存在的第三個落差）。下面還有一道「截圖後複驗 rect」的保險。
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await send('Page.navigate', { url: `${BASE}/` });

    let ready = false;
    for (let i = 0; i < 60; i++) {
      ready = await evalJs(
        `!!document.querySelector('video') && !!document.querySelector('[data-ov-id]')`,
      );
      if (ready) break;
      await sleep(250);
    }
    if (!ready) throw new Error('專案沒有在 15 秒內載入（t=0 應該看得到 ov_scale1）');

    // headless 下 CSS transition/animation 可能數秒不推進，量到的會是過渡中的座標；
    // fx-enter 進場動畫本身就帶 transform: scale(0.9)，不關掉會直接汙染尺寸量測。
    await evalJs(`(() => {
      const s = document.createElement('style');
      s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
      document.head.appendChild(s);
      return 1;
    })()`);
    await sleep(300);

    /** ArrowRight 一次 1 幀、Shift+ArrowRight 一次 10 幀（App.tsx 的快捷鍵，step = 1/fps）。 */
    const stepFrames = async (n) => {
      const tens = Math.floor(n / 10);
      const ones = n % 10;
      for (const [count, shift] of [
        [tens, true],
        [ones, false],
      ]) {
        for (let i = 0; i < count; i++) {
          for (const type of ['rawKeyDown', 'keyUp']) {
            await send('Input.dispatchKeyEvent', {
              type,
              key: 'ArrowRight',
              code: 'ArrowRight',
              windowsVirtualKeyCode: 39,
              nativeVirtualKeyCode: 39,
              modifiers: shift ? 8 : 0,
            });
          }
        }
      }
      await sleep(250); // React 不在同一次呼叫內同步 flush
    };

    /** 工具列的 timecode（`m:ss.s / m:ss.s`）——獨立驗證 playhead 真的在我們以為的時間。 */
    const readTimecode = () =>
      evalJs(`(() => {
        const el = [...document.querySelectorAll('span')].find((s) =>
          /^\\d+:\\d\\d\\.\\d\\s*\\/\\s*\\d+:\\d\\d\\.\\d$/.test(s.textContent.trim()));
        return el ? el.textContent.trim().split('/')[0].trim() : null;
      })()`);

    const stageRect = async () =>
      evalJs(`(() => {
        // 錨定 1080×1920 的座標空間 wrapper，不是 document.querySelector('video')
        // ——Player 同時掛 A/B 兩顆 video，blur 填充時還有第三顆帶 scale(1.15) 的背景層。
        const wrapper = [...document.querySelectorAll('div')].find((d) => {
          const s = getComputedStyle(d);
          return s.width === '1080px' && s.height === '1920px' && s.position === 'absolute';
        });
        if (!wrapper || !wrapper.parentElement) return null;
        const r = wrapper.parentElement.getBoundingClientRect();
        // DOMRect 逐欄取值：JSON.stringify(DOMRect) 回 {}（見 CLAUDE.md）
        return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
      })()`);

    /**
     * 截圖只截 stage 那一塊，並用 `clip.scale` 讓輸出大約是 1080 寬——CDP 的 clip.scale
     * 是**重新光柵化**（不是把小圖放大），所以量到的邊緣是瀏覽器在那個解析度下真的畫出來的。
     *
     * 換算刻意不假設「輸出就是 1080 寬」：Chrome 會先把 clip 矩形對齊到整數 CSS px 再乘
     * scale（實測 stage 寬 628.875、要求 scale 1.7173，拿回來的是 1078 而不是 1080），
     * 所以一律用「實得影像尺寸 ÷ 實際送出的 clip 尺寸」回推每 CSS px 幾個影像 px，
     * 再加上 clip 原點與 stage 原點的差，最後乘 1080/stage寬。少了這層回推，量到的座標
     * 會帶一個隨視窗尺寸浮動的系統性偏差。
     */
    const previewInk = async (label) => {
      const st = await stageRect();
      if (!st) throw new Error('找不到 1080×1920 座標空間 wrapper');
      const clip = {
        x: Math.floor(st.x),
        y: Math.floor(st.y),
        width: Math.ceil(st.x + st.w) - Math.floor(st.x),
        height: Math.ceil(st.y + st.h) - Math.floor(st.y),
        scale: CANVAS.w / st.w,
      };
      const shot = await send('Page.captureScreenshot', { format: 'png', clip });
      // 版面在「讀 rect」與「截圖」之間動過的話，整組換算就是錯的（而且錯得很像一個
      // 真的落差）。複驗一次，不一致就當場失敗，不要輸出一個看起來很有說服力的數字。
      const st2 = await stageRect();
      if (!st2 || st2.x !== st.x || st2.y !== st.y || st2.w !== st.w || st2.h !== st.h) {
        throw new Error(
          `截圖前後 stage 位置改變了（${JSON.stringify(st)} → ${JSON.stringify(st2)}）——版面還在動，量到的座標不可信`,
        );
      }
      const png = Buffer.from(shot.data, 'base64');
      writeFileSync(join(ART_DIR, `${label}.preview.png`), png);
      const img = await pngToRgb(png);
      const box = inkBBox(img);
      if (!box) return { box: null, img, st };
      const sx = img.w / clip.width; // 影像 px / CSS px
      const sy = img.h / clip.height;
      const cx = (ix) => (ix / sx + clip.x - st.x) * (CANVAS.w / st.w);
      const cy = (iy) => (iy / sy + clip.y - st.y) * (CANVAS.h / st.h);
      return {
        box: {
          x0: cx(box.x0),
          y0: cy(box.y0),
          w: cx(box.x1 + 1) - cx(box.x0),
          h: cy(box.y1 + 1) - cy(box.y0),
          count: box.count,
        },
        raw: box,
        img,
        st,
        clip,
      };
    };

    /** 量之前先確認畫面上**只有**該量的那一個東西，而且它畫的是真的字卡圖。 */
    const previewState = () =>
      evalJs(`(() => {
        const ovs = [...document.querySelectorAll('[data-ov-id]')];
        const caps = [...document.querySelectorAll('[data-drag-kind="caption"]')];
        return {
          overlayIds: ovs.map((e) => e.dataset.ovId),
          overlaysLoaded: ovs.every((e) => e.complete && e.naturalWidth > 0),
          captionCount: caps.length,
          captionCards: caps.map((c) => {
            const img = c.querySelector('img');
            return img ? { src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0 } : null;
          }),
        };
      })()`);

    const previewInkByCase = {};
    let atFrame = 0;
    for (const c of CASES) {
      await stepFrames(c.frame - atFrame);
      atFrame = c.frame;
      const tc = await readTimecode();
      // Toolbar.tsx 的 fmt()：`${分}:${秒.toFixed(1).padStart(4,'0')}`（0.5 → "0:00.5"）
      const wantTc = `0:${(c.frame / CANVAS.fps).toFixed(1).padStart(4, '0')}`;
      if (tc !== wantTc) {
        throw new Error(`playhead 沒到位：timecode=${tc}，預期 ${wantTc}（第 ${c.frame} 幀）`);
      }
      const st = await previewState();
      const wantOverlay = c.key.startsWith('overlay') ? [c.key.replace('overlay-', 'ov_')] : [];
      const gotOverlay = st.overlayIds;
      if (JSON.stringify(gotOverlay) !== JSON.stringify(wantOverlay)) {
        throw new Error(
          `t=${(c.frame / CANVAS.fps).toFixed(2)}s 畫面上的 overlay 是 ${JSON.stringify(gotOverlay)}，預期 ${JSON.stringify(wantOverlay)}`,
        );
      }
      if (!st.overlaysLoaded) throw new Error(`t=${c.frame} 的 overlay 圖還沒載入完`);
      if (c.key === 'caption') {
        if (st.captionCount !== 1) throw new Error(`預期畫面上 1 句字幕，實際 ${st.captionCount}`);
        const card = st.captionCards[0];
        if (!card || !card.src.startsWith('/text-card/')) {
          throw new Error(
            '字幕退回了 DOM 近似（沒有字卡 <img>）——那不是成品那張圖，量了也沒意義。' +
              '通常是字卡還沒產好或 Pillow 掛了。',
          );
        }
        if (!card.loaded) throw new Error('字卡圖沒載入成功');
      } else if (st.captionCount !== 0) {
        throw new Error(`t=${c.frame} 不該有字幕，實際 ${st.captionCount} 句`);
      }
      const r = await previewInk(c.key);
      if (!r.box) throw new Error(`預覽第 ${c.frame} 幀完全沒有墨跡（${c.title}）`);
      previewInkByCase[c.key] = r.box;
      notes.push(
        `  ${c.key}: stage=${r.st.x.toFixed(2)},${r.st.y.toFixed(2)} ${r.st.w.toFixed(3)}×${r.st.h.toFixed(3)} CSS px` +
          ` → 截圖 ${r.img.w}×${r.img.h}，影像墨跡 x0=${r.raw.x0} y0=${r.raw.y0} w=${r.raw.w} h=${r.raw.h}`,
      );
    }

    // ---- 比對 ----
    console.log(`\n量測換算（截圖 → 1080×1920 畫布座標）：\n${notes.join('\n')}`);
    console.log(`\n墨跡外框比對（單位：1080×1920 畫布 px，容差 ±${TOL_PX}）`);
    for (const c of CASES) {
      const e = exportInk[c.key];
      const p = previewInkByCase[c.key];
      const d = { x0: p.x0 - e.x0, y0: p.y0 - e.y0, w: p.w - e.w, h: p.h - e.h };
      const worst = Math.max(...Object.values(d).map(Math.abs));
      const pass = worst <= TOL_PX;
      console.log(`\n${pass ? '✓' : '✗'} ${c.title}   t=${(c.frame / CANVAS.fps).toFixed(2)}s`);
      console.log(`    成品(expected)  ${fmtBox(e)}`);
      console.log(`    預覽(actual)    ${fmtBox(p)}`);
      console.log(
        `    差值 Δx0=${d.x0.toFixed(1)} Δy0=${d.y0.toFixed(1)} Δw=${d.w.toFixed(1)} Δh=${d.h.toFixed(1)}  ` +
          `最大 ${worst.toFixed(1)}px（容差 ${TOL_PX}）`,
      );
      console.log(`    預覽/成品 尺寸比 w=${(p.w / e.w).toFixed(4)} h=${(p.h / e.h).toFixed(4)}`);
      if (!pass) {
        console.log(`    ↳ ${c.note}`);
        failures.push(c.title);
      }
    }
  } finally {
    ws?.close();
    chrome?.kill();
    server.kill();
    await sleep(200);
  }

  if (failures.length) {
    console.error(
      `\n✗ ${failures.length} 項「預覽 ≠ 成品」：${failures.join('、')}\n` +
        '  （這支腳本在修掉 overlay 那兩個缺陷之前本來就該是紅的；字幕那項若也紅，先懷疑量測本身）',
    );
    process.exit(1);
  }
  console.log('\n✓ 全部通過：預覽與成品的墨跡外框在容差內一致');
}

await main();
