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
 *
 * ⚠️ 檢查 2（拖曳 overlay）會真的透過 WS 送 updateOverlay 命令，把 demo 專案裡
 * 第一個在畫面上看得到的 overlay 位置往旁邊挪一點並寫回 projects/demo/doc.json。
 * 這是預期的（demo 專案本來就是拿來被操作的），不是要清乾淨的副作用。
 *
 * 沿用 ui/e2e/panel-affordance.mjs 的 findChrome/connect/send/evalJs 與
 * 失敗蒐集、exit code 慣例；scale 量測手法沿用 Task 13 一次性腳本
 * （caption-scale-check.mjs）已驗證過的做法：錨定 1080×1920 的座標空間 wrapper，
 * 讀它的 parentElement 當 stage 寬，解析 matrix() 而不是字串比對 scale()。
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const APP_URL = process.env.VIDCUT_URL ?? 'http://127.0.0.1:3845/';
const CDP_PORT = Number(process.env.VIDCUT_CDP_PORT ?? 9334);
const [vw, vh] = (process.env.VIDCUT_VIEWPORT ?? '1440x820').split('x').map(Number);
const VIEWPORT = { w: vw, h: vh };

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

    // 等專案真的載完（video + 至少一個畫得出來的 overlay），不是載入中的骨架版面。
    // 預設 playhead 在 0——demo 專案在 t=0 有 overlay 可見（rank1），不用另外操作
    // playhead。若哪天 demo 內容換了導致 t=0 沒有 overlay，這裡會逾時，訊息會指出來。
    let ready = false;
    for (let i = 0; i < 60; i++) {
      ready = await evalJs(
        `!!document.querySelector('video') && !!document.querySelector('[data-ov-id]')`,
      );
      if (ready) break;
      await sleep(250);
    }
    if (!ready) {
      failures.push('專案載入');
      console.log(
        '✗ 專案沒有在 15 秒內載入完成（找不到 <video> 或任何 [data-ov-id] overlay，見上方注解：demo 在 t=0 應該要有 overlay 可見）',
      );
      throw new Error('load-timeout');
    }

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
    // 錨定 1080×1920 的座標空間 wrapper（不是 document.querySelector('video')——Player
    // 同時掛 A/B 兩顆播放用 video，開 blur 填充時還有第三顆帶 transform: scale(1.15) 的
    // 背景模糊 video，量到它會得到一個看似合理但 ~15% 錯的數字，見 CLAUDE.md「UI 驗證的
    // 陷阱」）。wrapper 的 parentElement 就是 Player.tsx 的 ResizeObserver 實際觀測的
    // stage 容器,量它的寬才是 ground truth。
    console.log('檢查 1：縮放正確');
    const scaleResult = await evalJs(`(() => {
      const wrapper = [...document.querySelectorAll('div')].find((d) => {
        const s = getComputedStyle(d);
        return s.width === '1080px' && s.height === '1920px' && s.position === 'absolute';
      });
      if (!wrapper) return { error: 'wrapper div (1080x1920) not found' };
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
      return { stageW, scaleX: parts[0], expected: stageW / 1080 };
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
        `  ${pass ? '✓' : '✗'} stageW=${scaleResult.stageW.toFixed(2)} expected(stageW/1080)=${scaleResult.expected.toFixed(6)} actual scaleX=${scaleResult.scaleX.toFixed(6)} error=${(err * 100).toFixed(3)}%`,
      );
      if (!pass) failures.push('縮放正確');
    }
    // 就算縮放檢查失敗也要有個 scale 可用來換算拖曳像素（用量到的 scaleX，量不到就退回
    // stageW/1080 的期望值，兩者在正常情況下应該非常接近；純粹是讓後面兩項檢查還能跑,
    // 不是要掩蓋檢查 1 的失敗——失敗已經記進 failures 了）。
    if (scale === null && !scaleResult.error) scale = scaleResult.scaleX;
    if (scale === null) scale = (scaleResult.stageW ?? VIEWPORT.h * (1080 / 1920)) / 1080;

    // ---- 檢查 2 + 3：拖曳 overlay（合成 pointer 事件），途中驗導線、放手後驗位置真的變了 ----
    // 兩項共用同一次連續拖曳（先小幅移動、確認水平置中導線出現，再繼續拖遠、放手），
    // 貼近真實使用者的拖曳手感,也避免各自獨立拖曳時「第一次拖完的殘留位置」影響第二次
    // 判斷「是否還在置中附近」的前提。
    console.log('檢查 2/3：拖曳 overlay（導線 + 位置持久化）');
    const ov = await evalJs(`(() => {
      const el = document.querySelector('[data-ov-id]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { id: el.dataset.ovId, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    })()`);
    if (!ov) {
      console.log('  ✗ DOM 裡沒有任何 [data-ov-id] overlay 可拖（前置條件不成立）');
      failures.push('導線出現', '拖曳位置持久化');
    } else {
      const before = await fetchProject();
      const beforeOv = before.doc.tracks.overlays.find((o) => o.id === ov.id);
      const beforePos = beforeOv?.position;
      if (!beforePos) {
        console.log(`  ✗ /api/project 裡找不到 overlay ${ov.id}（前置條件不成立）`);
        failures.push('導線出現', '拖曳位置持久化');
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
        // 第一步移動：把 bbox 中心精確移回畫布水平中心（540，1080 座標系），而不是
        // 假設 overlay 現在已經在中心附近——這支腳本本身會把 demo 專案的 overlay 位置
        // 往旁邊挪（見檔頭註解），重跑時起點通常已經不在中心，固定的「小幅移動」量
        // 遇到夠遠的起點就再也吸不到，會誤判成導線沒出現。o.position.x 的錨點定義就是
        // bbox 水平中心（見 dragLayer.ts 開頭註解），所以 540 - beforePos.x*1080 就是
        // 「移到正中心」所需的畫布位移，換算成螢幕像素要乘上量到的 scale。
        const centerDeltaCanvas = 540 - beforePos.x * 1080;
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
          // 導線是 style.width === '2px'（水平置中,縱線,見 Player.tsx 的 guides.map）
          // 或 style.height === '2px'（垂直安全邊,橫線）;這裡只驗水平置中那條。
          return [...document.querySelectorAll('div')].filter((d) => d.style.width === '2px' && d.style.height === '1920px').length;
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
        const targetYFrac = 0.3; // 遠離上/下安全邊距與垂直置中候選,不會被吸附影響終值
        const bigDx = (targetXFrac * 1080 - beforePos.x * 1080) * scale;
        const bigDy = (targetYFrac * 1920 - beforePos.y * 1920) * scale;
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
        const changed = !!afterPos && (afterPos.x !== beforePos.x || afterPos.y !== beforePos.y);
        console.log(
          `  ${changed ? '✓' : '✗'} /api/project 裡 overlay ${ov.id} 的位置真的變了：before=${JSON.stringify(beforePos)} after=${JSON.stringify(afterPos)}`,
        );
        if (!changed) failures.push('拖曳位置持久化');
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
        // 讀「畫面上顯示的位置」＝ inline style 的 left/top（1080×1920 座標空間內的 px）
        const shown = () =>
          evalJs(`(() => {
            const el = document.querySelector('${sel}');
            return el ? { x: parseFloat(el.style.left) / 1080, y: parseFloat(el.style.top) / 1920 } : null;
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
