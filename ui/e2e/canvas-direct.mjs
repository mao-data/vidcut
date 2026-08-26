/**
 * 畫布直接操作（拖曳/吸附/縮放）的真瀏覽器回歸檢查（真瀏覽器，非 jsdom）。
 *
 * 為什麼不是 vitest：這裡要驗的是「螢幕上實際量到的縮放比例」與「合成滑鼠事件拖曳後
 * 伺服器真的存了新位置」，jsdom 沒有版面引擎也沒有真的 pointer capture，量不出來、
 * 也拖不動。
 *
 * 前置：`npm run build -w @vidcut/ui` 是最新的 + 一個吃著真專案的 server 已在跑
 * （`npx tsx server/src/index.ts projects/demo`，:3845）。**不要**用 `npm run demo`
 * （會重新產生 projects/demo，蓋掉既有內容）。
 * 執行：`npm run verify:canvas`
 * Chrome 路徑可用 CHROME_BIN 覆寫；視窗尺寸可用 VIDCUT_VIEWPORT（如 1280x620）。
 * 畫布比例可用 VIDCUT_CANVAS（preset id，預設 portrait＝1080×1920）——尺寸從
 * `shared/src/canvasPresets.ts` 解析，見 ui/e2e/canvasPreset.mjs。**這支腳本本身不
 * 設定專案的畫布**，只是照著讀到的尺寸換算；跑非 portrait 之前要先讓專案真的是那個比例。
 *
 * ⚠️ 檢查 2/4（拖曳 overlay）會真的透過 WS 送 updateOverlay 命令，把 demo 專案裡
 * 第一個在畫面上看得到的 overlay 位置往旁邊挪一點並寫回 projects/demo/project.json
 * （專案檔就叫 project.json，不是 doc.json——`doc` 是它裡面的鍵）。
 * 這是預期的（demo 專案本來就是拿來被操作的），不是要清乾淨的副作用。
 *
 * 沿用 ui/e2e/panel-affordance.mjs 的 findChrome/connect/send/evalJs 與
 * 失敗蒐集、exit code 慣例；scale 量測手法沿用 Task 13 一次性腳本
 * （caption-scale-check.mjs）已驗證過的做法：錨定座標空間 wrapper，
 * 讀它的 parentElement 當 stage 寬，解析 matrix() 而不是字串比對 scale()。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { resolveCanvas } from './canvasPreset.mjs';

const APP_URL = process.env.VIDCUT_URL ?? 'http://127.0.0.1:3845/';
const CDP_PORT = Number(process.env.VIDCUT_CDP_PORT ?? 9334);
const [vw, vh] = (process.env.VIDCUT_VIEWPORT ?? '1440x820').split('x').map(Number);
const VIEWPORT = { w: vw, h: vh };
/** 單發 CDP 的逾時（見 send 的註解：沒有它，卡住的瀏覽器會讓整支腳本永遠 pending）。 */
const CDP_TIMEOUT_MS = Number(process.env.VIDCUT_CDP_TIMEOUT_MS ?? 30_000);
/**
 * 畫布尺寸——本檔所有座標換算的唯一來源，不得再有第二個 1080/1920 字面值。
 * 預設 portrait（1080×1920）＝現狀行為，跟參數化之前逐項等值。
 */
const CANVAS = resolveCanvas();

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

async function fetchProject() {
  // 不用 `new URL(path, base)`（要多宣告一個 URL global，其他 .mjs 腳本都沒這個需求）——
  // APP_URL 一律帶結尾斜線（預設值與 env override 慣例都是），直接字串接就好。
  const r = await fetch(`${APP_URL.replace(/\/$/, '')}/api/project`);
  if (!r.ok) throw new Error(`GET /api/project → ${r.status}`);
  return r.json();
}

async function main() {
  try {
    const r = await fetch(APP_URL);
    if (!r.ok) throw new Error(String(r.status));
  } catch (e) {
    console.error(
      `✗ ${APP_URL} 沒有回應（先起 server：npx tsx server/src/index.ts projects/demo）：${e.message}`,
    );
    process.exit(2);
  }

  const chrome = spawn(
    findChrome(),
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--window-size=${VIEWPORT.w},${VIEWPORT.h}`,
      '--user-data-dir=' + join(process.env.TMPDIR ?? '/tmp', 'vidcut-e2e-canvas-profile'),
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
    // 每一發都帶 timeout：沒有它，任何一個沒回覆的 CDP 呼叫會讓整支腳本永遠 pending
    // ——不是紅也不是綠，是掛著。當 gate 用的時候那是最糟的失敗模式（實際觀察過
    // `verify:panels` 掛了九分鐘）。逾時就 reject，訊息帶方法名，一眼看得出卡在哪。
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => {
          pending.delete(i);
          rej(new Error(`CDP ${method} 超過 ${CDP_TIMEOUT_MS}ms 沒有回覆（瀏覽器卡住了）`));
        }, CDP_TIMEOUT_MS);
        const done = (fn) => (v) => {
          clearTimeout(timer);
          fn(v);
        };
        pending.set(i, { res: done(res), rej: done(rej) });
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

    // 等專案真的載完（不是載入中的骨架版面）。
    let loaded = false;
    for (let i = 0; i < 60; i++) {
      loaded = await evalJs(`!!document.querySelector('video')`);
      if (loaded) break;
      await sleep(250);
    }
    if (!loaded) {
      failures.push('專案載入');
      console.log('✗ 專案沒有在 15 秒內載入完成（找不到 <video>）');
      throw new Error('load-timeout');
    }

    // 這支腳本要拖一個 overlay，所以得先讓 playhead 停在**有 overlay 可見**的時刻。
    //
    // ⚠️ 不要假設 t=0 就有（原本是這樣寫的，理由是「demo 在 t=0 有 rank1」）：
    // `projects/demo` 是共用的可變狀態，別的 session 一改內容這個前提就沒了——實測
    // 2026-08-05 那份 demo 只剩 4 個 overlay、rank 卡全部改成 anchored、最早的一個
    // start=0.317，於是這支腳本每次都在「專案載入」這一步逾時，看起來像 UI 壞了。
    // 改成往前掃：用 Shift+→（一次 10 幀）找第一個看得到 overlay 的時刻，找不到才報錯。
    const shiftRight = async () => {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', {
          type,
          key: 'ArrowRight',
          code: 'ArrowRight',
          windowsVirtualKeyCode: 39,
          nativeVirtualKeyCode: 39,
          modifiers: 8, // shift＝一次 10 幀
        });
      }
    };
    let ready = false;
    let steps = 0;
    for (; steps < 60; steps++) {
      ready = await evalJs(`!!document.querySelector('[data-ov-id]')`);
      if (ready) break;
      await shiftRight();
      await sleep(80);
    }
    if (!ready) {
      failures.push('找不到可拖曳的 overlay');
      console.log(
        `✗ 從 t=0 掃到第 ${60 * 10} 幀（20 秒）都沒有任何 [data-ov-id] overlay 出現。` +
          '這支腳本要拖一個 overlay 才能驗證——請確認 projects/demo 裡還有 overlay。',
      );
      throw new Error('no-overlay');
    }
    if (steps > 0) console.log(`  （playhead 前進到第 ${steps * 10} 幀才有 overlay 可見）`);

    // 關掉所有過渡/動畫再量/再拖——headless 節流下 CSS transition 可能整整幾秒不推進，
    // 拖曳中的導線淡入淡出也是 transition，會讓「導線出現了沒」量到過渡中的狀態。
    await evalJs(`(() => {
      const s = document.createElement('style');
      s.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
      document.head.appendChild(s);
      return 1;
    })()`);
    await sleep(300);

    // ---- 檢查 1：縮放正確 ----
    // 錨定座標空間 wrapper（不是 document.querySelector('video')——Player
    // 同時掛 A/B 兩顆播放用 video，開 blur 填充時還有第三顆帶 transform: scale(1.15) 的
    // 背景模糊 video，量到它會得到一個看似合理但 ~15% 錯的數字，見 CLAUDE.md「UI 驗證的
    // 陷阱」）。wrapper 的 parentElement 就是 Player.tsx 的 ResizeObserver 實際觀測的
    // stage 容器,量它的寬才是 ground truth。
    //
    // ⚠️ 這項檢查證明的範圍很窄,別過度解讀:它只讀 matrix(a,b,c,d,e,f) 的 **a**（scaleX）,
    // 不看 d（scaleY）、不看 e/f（平移）、也不看 transform-origin。做過對抗性驗證——
    // 刻意把整層改成 transformOrigin: 'center'（整片位移 391×696px）、把 transform 改成
    // scale(a, a*1.5)（垂直比例錯掉），這段量測**照樣回報 0.000%**。
    // 它是一個貨真價實的獨立量測（新鮮的 getBoundingClientRect vs 解析出來的矩陣，
    // 不是把同一個值比對自己），但它成立的命題是「ResizeObserver 拿到的寬不是舊值、
    // 除數確實是畫布寬」，**不是**「預覽跟匯出成品對齊」。後者只能真的 render 一次比像素,
    // 目前沒有任何自動化在做這件事。
    //
    // ⚠️ 用 data-testid 找 wrapper，**不要**回頭改成比對 `width === '1080px'`：
    // 尺寸字串比對在畫布尺寸一變時不是變紅、是找不到元素直接掛掉，守門人會靜默失效。
    console.log(`檢查 1：縮放正確（畫布 ${CANVAS.id} ${CANVAS.w}×${CANVAS.h}）`);
    const scaleResult = await evalJs(`(() => {
      const wrapper = document.querySelector('[data-testid="canvas-layer"]');
      if (!wrapper) return { error: '[data-testid=canvas-layer] not found' };
      const stage = wrapper.parentElement;
      if (!stage) return { error: 'wrapper has no parentElement' };
      const stageW = stage.getBoundingClientRect().width;
      // getComputedStyle(el).transform 一律回 matrix(a,b,c,d,e,f)，就算行內寫的是
      // scale(0.xxx)；字串比對 scale(...) 會直接落空，要拆 matrix() 的 6 個數字，
      // a 就是 scaleX。
      const t = getComputedStyle(wrapper).transform;
      const m = t.match(/matrix\\(([^)]+)\\)/);
      if (!m) return { error: 'transform 不是 matrix()', raw: t };
      const parts = m[1].split(',').map((x) => parseFloat(x.trim()));
      return { stageW, scaleX: parts[0], expected: stageW / ${CANVAS.w} };
    })()`);
    let scale = null;
    if (scaleResult.error) {
      console.log(`  ✗ 量不到 wrapper/transform — ${scaleResult.error}`);
      failures.push('縮放正確');
    } else {
      scale = scaleResult.scaleX;
      const err = Math.abs(scaleResult.scaleX - scaleResult.expected) / scaleResult.expected;
      const pass = err <= 0.01;
      console.log(
        `  ${pass ? '✓' : '✗'} stageW=${scaleResult.stageW.toFixed(2)} expected(stageW/${CANVAS.w})=${scaleResult.expected.toFixed(6)} actual scaleX=${scaleResult.scaleX.toFixed(6)} error=${(err * 100).toFixed(3)}%`,
      );
      if (!pass) failures.push('縮放正確');
    }
    // 就算縮放檢查失敗也要有個 scale 可用來換算拖曳像素（用量到的 scaleX，量不到就退回
    // stageW/畫布寬 的期望值，兩者在正常情況下应該非常接近；純粹是讓後面兩項檢查還能跑,
    // 不是要掩蓋檢查 1 的失敗——失敗已經記進 failures 了）。
    if (scale === null && !scaleResult.error) scale = scaleResult.scaleX;
    if (scale === null)
      scale = (scaleResult.stageW ?? VIEWPORT.h * (CANVAS.w / CANVAS.h)) / CANVAS.w;

    // ---- 檢查 2 + 3：拖曳 overlay（合成 pointer 事件），途中驗導線、放手後驗位置真的變了 ----
    // 兩項共用同一次連續拖曳（先小幅移動、確認水平置中導線出現，再繼續拖遠、放手），
    // 貼近真實使用者的拖曳手感,也避免各自獨立拖曳時「第一次拖完的殘留位置」影響第二次
    // 判斷「是否還在置中附近」的前提。
    console.log('檢查 2/3：拖曳 overlay（導線 + 落點正確且持久化）');
    const ov = await evalJs(`(() => {
      const el = document.querySelector('[data-ov-id]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        id: el.dataset.ovId,
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
        w: r.width,
        h: r.height,
      };
    })()`);
    if (!ov) {
      console.log('  ✗ DOM 裡沒有任何 [data-ov-id] overlay 可拖（前置條件不成立）');
      failures.push('導線出現', '拖曳落點正確');
    } else {
      const before = await fetchProject();
      const beforeOv = before.doc.tracks.overlays.find((o) => o.id === ov.id);
      const beforePos = beforeOv?.position;
      if (!beforePos) {
        console.log(`  ✗ /api/project 裡找不到 overlay ${ov.id}（前置條件不成立）`);
        failures.push('導線出現', '拖曳落點正確');
      } else {
        // Input.dispatchMouseEvent 用真的滑鼠事件（不是 el.dispatchEvent 那種合成 JS
        // 事件）——Chrome 會照真實硬體輸入路徑轉成 PointerEvent，setPointerCapture 才會
        // 正常生效、後續 mouseMoved 才會即使移出元素邊界也還是送給同一個 overlay。
        await send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: ov.cx,
          y: ov.cy,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        });
        // 第一步移動：把 bbox 中心精確移回畫布水平中心（CANVAS.w/2），而不是
        // 假設 overlay 現在已經在中心附近——這支腳本本身會把 demo 專案的 overlay 位置
        // 往旁邊挪（見檔頭註解），重跑時起點通常已經不在中心，固定的「小幅移動」量
        // 遇到夠遠的起點就再也吸不到，會誤判成導線沒出現。o.position.x 的錨點定義就是
        // bbox 水平中心（見 dragLayer.ts 開頭註解），所以 CANVAS.w/2 - beforePos.x*CANVAS.w
        // 就是「移到正中心」所需的畫布位移，換算成螢幕像素要乘上量到的 scale。
        const centerDeltaCanvas = CANVAS.w / 2 - beforePos.x * CANVAS.w;
        const smallDx = centerDeltaCanvas * scale;
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: ov.cx + smallDx,
          y: ov.cy + 4,
          button: 'left',
          buttons: 1,
        });
        // React 不會在同一次 Runtime.evaluate 內同步 flush；上面是真實輸入事件（不是
        // JS 呼叫），保守起見還是等一輪再讀 DOM，跟 panel-affordance.mjs 的作法一致。
        await sleep(300);
        const guideCount = await evalJs(`(() => {
          // 導線分兩種：data-guide-axis='x'（水平座標的吸附,畫面上是縱線,見 Player.tsx
          // 的 guides.map）與 'y'（垂直安全邊,橫線）;這裡只驗水平置中那條。
          // ⚠️ 用 axis 屬性而不是 style.height === '1920px'——尺寸字串一旦隨畫布改變,
          // 這個 filter 會靜默回 0（看起來像「導線沒出現」的假紅）。
          return document.querySelectorAll('[data-testid="snap-guide"][data-guide-axis="x"]').length;
        })()`);
        const guidePass = guideCount > 0;
        console.log(
          `  ${guidePass ? '✓' : '✗'} 拖近水平中心時出現置中導線（找到 ${guideCount} 條）`,
        );
        if (!guidePass) failures.push('導線出現');

        // 繼續拖遠（離開吸附半徑），放手，讓最終位置是一個「真的移動過」的位置。
        // 用絕對目標（不是相對起點的固定位移量）：這支腳本會真的把 demo 專案的位置寫回去
        // （見檔頭註解），重跑很多次時如果用固定的「+160」位移，起點一旦被前幾次跑到
        // 接近畫布邊緣，clamp 會讓「拖遠後」的位置跟「拖遠前」撞在同一個被夾住的值，
        // 誤判成「位置沒變」。改成依目前 x 落在哪一側,交替瞄準畫布左 1/4 或右 3/4
        // （兩者都離水平置中候選 540 夠遠、不會誤觸吸附,兩個目標本身也不可能相等),
        // 保證「拖曳前」與「拖曳後」的 x 座標永遠不同,不管這支腳本已經被跑過幾次。
        const targetXFrac = beforePos.x < 0.5 ? 0.75 : 0.25;
        // y 的目標不能隨便挑一個「看起來在中間」的數字（原本寫死 0.3 就是）:
        // position.y 的錨點是圖的**上緣**（x 才是水平中心,見 dragLayer.ts 開頭註解),
        // 目標若落在合法區間外,clampAxis 會把它拉回來,而我們就會斷言在一個不可能達到
        // 的落點上（等於斷言一個 bug）。所以從實際量到的 bbox 高度算出合法區間再取點。
        //
        // ⚠️ 2026-08-05 修：這裡原本用 `yHi = max(0, 1 - bboxH/H)`，那是**舊的**夾制
        // 語意（整個元素留在畫布內）。2026-08-04 起規則是「元素中心留在畫布內」，四邊
        // 各可露出一半。舊式子除了測不到新開的那段範圍，還會在 bbox ≥ 畫布高時整個退化成
        // yHi=0 → 兩個「交替」目標都是 0 → 起點本來就是 0 → 斷言「拖到指定落點」變成
        // **恆真**。而 `projects/demo` 的排名卡正好是 1080×1920，也就是說這支腳本平常
        // 跑的就是那個退化分支。
        //
        // 新語意下合法區間是 [-h/2H, 1-h/2H]，寬度**恆為 1**（跟 bbox 多高無關），
        // 所以取 25% / 75% 兩點交替瞄準：距離起點至少 0.25（直式下 480 畫布 px），
        // 離三個垂直吸附候選（中心 / 上安全邊 / 下安全邊，threshold 16 畫布 px）也都
        // 遠在 300px 以上；每跑一次換一邊，重跑不會收斂到同一點。
        const bboxHCanvas = ov.h / scale;
        const half = bboxHCanvas / (2 * CANVAS.h);
        const [yLo, yHi] = [-half, 1 - half];
        const targetYFrac = beforePos.y < (yLo + yHi) / 2 ? yLo + 0.75 : yLo + 0.25;
        // 保險絲：目標一旦離起點太近，下面「落在指定目標上」的斷言就沒有鑑別力了。
        // 上面的算式保證 ≥480px，這行是防止有人改了取點規則卻沒發現它退化。
        if (Math.abs(targetYFrac - beforePos.y) * CANVAS.h < 100) {
          failures.push(
            `y 目標 ${targetYFrac.toFixed(4)} 離起點 ${beforePos.y.toFixed(4)} 太近，` +
              '拖曳斷言會退化成恆真',
          );
        }
        const bigDx = (targetXFrac * CANVAS.w - beforePos.x * CANVAS.w) * scale;
        const bigDy = (targetYFrac * CANVAS.h - beforePos.y * CANVAS.h) * scale;
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: ov.cx + bigDx,
          y: ov.cy + bigDy,
          button: 'left',
          buttons: 1,
        });
        await sleep(150);
        await send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: ov.cx + bigDx,
          y: ov.cy + bigDy,
          button: 'left',
          buttons: 0,
        });
        // 放手後：本地 pending 覆蓋 → sendCommand → server 落盤 → /api/project 反映,
        // 都要時間;500ms 對這種單一 WS 命令綽綽有餘（比 pending 的 1.2s 保險絲短很多,
        // 但正常情況下 echo 應該遠早於保險絲觸發)。
        await sleep(500);
        const after = await fetchProject();
        const afterPos = after.doc.tracks.overlays.find((o) => o.id === ov.id)?.position;
        // 斷言的是「落在**指定的目標**上」,不是「有變」。只驗「有變」的話,錨點慣例
        // 寫反（x 用左緣、y 用中心）、dx/dy 少一個負號、螢幕 px↔畫布 px 的 scale 換算
        // 乘反,每一種都照樣讓座標「變了」——而 x 是圖的水平中心、y 卻是上緣這個不對稱
        // 正是這個專案唯一一次線上事故的成因（見 shared/src/snap.ts 開頭）。
        // 容差 6 畫布 px：合成滑鼠座標會被四捨五入,送出前又 toFixed(4);任何錨點/正負號/
        // 縮放層級的錯誤都是幾十到幾百 px 級,不會躲在這個容差裡。
        const TOL_CANVAS_PX = 6;
        const errX = afterPos ? Math.abs(afterPos.x - targetXFrac) * CANVAS.w : Infinity;
        const errY = afterPos ? Math.abs(afterPos.y - targetYFrac) * CANVAS.h : Infinity;
        const landed = errX <= TOL_CANVAS_PX && errY <= TOL_CANVAS_PX;
        console.log(
          `  ${landed ? '✓' : '✗'} /api/project 裡 overlay ${ov.id} 落在指定目標上：` +
            `before=${JSON.stringify(beforePos)} target={"x":${targetXFrac.toFixed(4)},"y":${targetYFrac.toFixed(4)}} ` +
            `after=${JSON.stringify(afterPos)} 誤差=${errX.toFixed(1)}×${errY.toFixed(1)} 畫布 px`,
        );
        if (!landed) failures.push('拖曳落點正確');
      }

      // ---- 檢查 4：拖曳中 playhead 離開項目的時間窗，不得「盲拖」 ----
      // 這是 jsdom 驗不到的那一類：plan.overlays 依 playhead 過濾，項目一出窗就不在清單裡，
      // 拖曳中的本地覆寫沒東西可套 → 畫面停住不動，但手勢還在跑、放手照樣送出。
      // 使用者最後看到的是 A、文件拿到的是 B（實測差過 250px @1080 空間）。
      // 這裡在真瀏覽器裡用真實輸入事件全程重現：按住 → 用 shift+→ 把 playhead 踩出時間窗
      // → 繼續移動 → 放手，然後比對「畫面上最後顯示的座標」與「/api/project 真的存下的座標」。
      console.log('檢查 4：拖曳中 playhead 離開時間窗（不盲拖）');
      const sel = `[data-ov-id="${ov.id}"]`;
      // shift+→ 一次 10 幀（App.tsx 的快捷鍵），fps 30 → 0.333s；踩到 overlay 消失為止，
      // 先量出「幾步會出窗」（此時沒有在拖曳，量到的是真正的時間窗邊界，與修法無關）。
      const stepPlayhead = async (n) => {
        for (let i = 0; i < Math.abs(n); i++) {
          for (const type of ['rawKeyDown', 'keyUp']) {
            await send('Input.dispatchKeyEvent', {
              type,
              key: n > 0 ? 'ArrowRight' : 'ArrowLeft',
              code: n > 0 ? 'ArrowRight' : 'ArrowLeft',
              windowsVirtualKeyCode: n > 0 ? 39 : 37,
              nativeVirtualKeyCode: n > 0 ? 39 : 37,
              modifiers: 8, // Shift → 一次 10 幀
            });
          }
        }
        await sleep(200); // React 不會在同一次呼叫內同步 flush
      };
      let steps = 0;
      while (steps < 60 && (await evalJs(`!!document.querySelector('${sel}')`))) {
        await stepPlayhead(1);
        steps++;
      }
      if (steps >= 60) {
        console.log(`  ✗ ${ov.id} 踩了 60 步（約 20 秒）還沒出窗，前置條件不成立`);
        failures.push('不盲拖');
      } else {
        await stepPlayhead(-steps); // 回到原本的 playhead
        const box = await evalJs(`(() => {
          const el = document.querySelector('${sel}');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
        })()`);
        // 讀「畫面上顯示的位置」＝ inline style 的 left/top（畫布座標空間內的 px）
        const shown = () =>
          evalJs(`(() => {
            const el = document.querySelector('${sel}');
            return el ? { x: parseFloat(el.style.left) / ${CANVAS.w}, y: parseFloat(el.style.top) / ${CANVAS.h} } : null;
          })()`);
        if (!box) {
          console.log(`  ✗ 回到原 playhead 後 ${ov.id} 不見了，前置條件不成立`);
          failures.push('不盲拖');
        } else {
          await send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: box.cx,
            y: box.cy,
            button: 'left',
            buttons: 1,
            clickCount: 1,
          });
          // 走 **x 軸**：這個 demo overlay 是幾乎滿版高的圖，bbox 高 → y 的合法上限剛好
          // 壓在它目前的 y 上，往下拖是 no-op（clamp 正確地擋住「整張圖掉出畫布」），
          // 拿它當「畫面有沒有跟著手指」的訊號會永遠量到 0。x 沒有這個限制。
          // 往左拖（遠離右邊界）避免撞到 x 的 clamp，位移量夠大也不會被中心吸附吃掉差異。
          // 方向依目前落點決定（往畫布另一側拖），這支腳本每跑一次都會把位置寫回 demo，
          // 固定往同一邊拖遲早會把它頂到 x 的 clamp 邊界、讓「有沒有跟著手指」的差異被夾平。
          const start0 = await shown();
          const dir = (start0?.x ?? 0.5) < 0.5 ? 1 : -1;
          const px = (canvasDx) => box.cx + dir * canvasDx * scale;
          await send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: px(40),
            y: box.cy,
            button: 'left',
            buttons: 1,
          });
          await sleep(200);
          const seenBefore = await shown();

          await stepPlayhead(steps + 2); // 手還按著，playhead 推出時間窗
          const stillThere = await shown();
          const visiblePass = !!stillThere;
          console.log(
            `  ${visiblePass ? '✓' : '✗'} 出窗後被拖的 overlay 仍在畫面上（有回饋，不是盲拖）`,
          );
          if (!visiblePass) failures.push('不盲拖');

          // 繼續拖：畫面必須跟著動（盲拖時這裡會完全不動，或根本讀不到元素）
          await send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: px(300),
            y: box.cy,
            button: 'left',
            buttons: 1,
          });
          await sleep(200);
          const seenLast = await shown();
          const movedPass =
            !!seenLast && !!seenBefore && Math.abs(seenLast.x - seenBefore.x) > 0.01;
          console.log(
            `  ${movedPass ? '✓' : '✗'} 出窗後繼續拖，畫面持續跟著手指：${JSON.stringify(seenBefore)} → ${JSON.stringify(seenLast)}`,
          );
          if (!movedPass) failures.push('不盲拖');

          await send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: px(300),
            y: box.cy,
            button: 'left',
            buttons: 0,
          });
          await sleep(500);
          const persisted = (await fetchProject()).doc.tracks.overlays.find(
            (o) => o.id === ov.id,
          )?.position;
          // 核心斷言：**存進文件的＝畫面最後顯示的**（送出前 toFixed(4)，容差取 0.001）
          const samePass =
            !!persisted &&
            !!seenLast &&
            Math.abs(persisted.x - seenLast.x) < 0.001 &&
            Math.abs(persisted.y - seenLast.y) < 0.001;
          console.log(
            `  ${samePass ? '✓' : '✗'} 存進 doc 的位置＝畫面最後顯示的位置：shown=${JSON.stringify(seenLast)} doc=${JSON.stringify(persisted)}`,
          );
          if (!samePass) failures.push('不盲拖');
        }
      }
    }
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
