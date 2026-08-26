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
 * **畫布比例**吃 `VIDCUT_CANVAS`（preset id，預設 portrait）：
 * `VIDCUT_CANVAS=landscape npm run verify:wysiwyg`。腳本會把臨時專案本身設成那個比例
 * （`applyCanvas()` 送 `setCanvas` 命令），素材、所有座標換算與 `exportInk` 期望值
 * 全部跟著走；視窗尺寸的預設值也跟著換（直式 1200×1400、橫式 1800×1100，見 VIEWPORT）。
 *
 * ⚠️ 這支腳本**現在應該是全綠的**（六個 case）。任何一項轉紅都是真的回歸：
 * 字幕那項紅＝量測本身壞了（兩邊同一張 PNG、同一個位置），先修腳本不要動斷言；
 * overlay 四項紅＝幾何落差回來了，先看 `measure/` 裡的 PNG。
 *
 * CDP 那段（findChrome/connect/send/evalJs 與 failures/exit code 慣例）是照抄
 * ui/e2e/canvas-direct.mjs 的——刻意不抽共用模組：抽了就得改 canvas-direct.mjs，
 * 而驗證它沒壞唯一的辦法是跑 `verify:canvas`，那支會寫回 projects/demo。
 * 等哪天有人要同時動這兩支再抽。
 */
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { resolveCanvas } from './canvasPreset.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.VIDCUT_WYSIWYG_PORT ?? 3999);
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.VIDCUT_CDP_PORT ?? 9336);
const PROJECT_DIR = process.env.VIDCUT_WYSIWYG_DIR ?? join(tmpdir(), 'vidcut-wysiwyg-fixture');
/** 兩邊量到的畫面都留一份 PNG——數字對不上時，能直接開圖看是「位置錯」還是「量錯東西」。 */
const ART_DIR = join(PROJECT_DIR, 'measure');
/**
 * 畫布尺寸＋fps。尺寸吃 `VIDCUT_CANVAS`（preset id，預設 portrait＝1080×1920，
 * 逐項等於參數化之前的行為），從 `shared/src/canvasPresets.ts` 解析，見 canvasPreset.mjs。
 *
 * 這個值有兩個消費端，缺一不可：
 * 1. fixture 素材與所有座標換算（本檔各處）
 * 2. **臨時專案本身的畫布**——`populateProject()` 會送一次 `setCanvas` 命令（見那裡）。
 *    專案的預設是 1080×1920（`shared/src/types.ts` 的 `emptyDoc`），不送就是「素材是
 *    橫式、專案還是直式」，量出來的每一個數字都是假的。
 *
 * 下面 CASES 的 `exportInk` 期望值**全部從這個 CANVAS 推導**（不是硬編畫布 px），
 * 所以換 preset 時期望值跟著走，不必為每個比例各抄一組數字。
 */
const CANVAS = { ...resolveCanvas(), fps: 30 };

/**
 * 瀏覽器視埠。`VIDCUT_VIEWPORT` 可覆寫，但**預設值跟著畫布比例走**。
 *
 * 為什麼不能一個尺寸打天下：stage 是 `height:100% + maxWidth:100% + aspectRatio`
 * （見 `Player.tsx`），所以 `stage 寬 = min(容器寬, 容器高 × 畫布比)`。直式的
 * 1200×1400 卡在**容器高**那一項（實測 stage 607.5px＝容器高 1080 × 9/16）。
 * 同一個視埠拿去跑 16:9 時，`容器高 × 16/9 = 1920` 遠大於容器寬，改由**容器寬**
 * 封頂（1200 的視窗扣掉左右面板只剩約 850），而畫布寬變成 1920 → 每一影像 px
 * 要換算 2.26 畫布 px，量測精度直接掉一半。`MIN_STAGE_W` 那條線（stage < 400px 時
 * 本底雜訊 5.1px > 容差 4px）就是為這類情況存在的。
 *
 * 規則：直式（h ≥ w）維持 1200×1400 **逐位元組不變**；橫式與方形改用**寬視窗**
 * 1800×1100——實測橫式 stage 量到 **1386.7px**（1 影像 px ≈ 1.38 畫布 px，比直式的
 * 1.78 還密），遠高於 400 的下限。橫式主要靠**寬度**撐，高度只要別讓
 * `容器高 × 16/9` 反過來變成瓶頸即可。
 */
const DEFAULT_VIEWPORT = CANVAS.h >= CANVAS.w ? '1200x1400' : '1800x1100';
const [vw, vh] = (process.env.VIDCUT_VIEWPORT ?? DEFAULT_VIEWPORT).split('x').map(Number);
const VIEWPORT = { w: vw, h: vh };

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

/**
 * `TOL_PX` 這個常數只有在 stage 夠大時才成立。截圖是用 `clip.scale = 1080/stage寬`
 * 重新光柵化的，stage 越小、版面被 CSS `scale()` 壓得越扁，換算回 1080 空間時每一點
 * 佈局捨入都被放大得越多——實測 stage 寬 89px 時本底雜訊 5.1px，**程式碼沒動也全紅**。
 * 那種紅完全沒有診斷價值，只會訓練人忽略這支腳本。
 *
 * 所以不放寬容差（放寬等於削弱 gate），改成擋在門口：stage 小於這個寬度就直接說
 * 「你的視窗太小」。預設視窗 1200×1400 下 stage 寬約 630px，餘裕很大；只有刻意用
 * `VIDCUT_VIEWPORT` 設一個很小的值才碰得到。
 */
const MIN_STAGE_W = 400;

/** 單發 CDP 的逾時（見 send 的註解：沒有它，卡住的瀏覽器會讓整支腳本永遠 pending）。 */
const CDP_TIMEOUT_MS = Number(process.env.VIDCUT_CDP_TIMEOUT_MS ?? 30_000);

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

/**
 * 成品影片的實際畫面尺寸。
 *
 * ⚠️ **不能靠「解碼長度 = w×h×3」來確認尺寸**：1080×1920 與 1920×1080 的 rgb24 長度
 * **完全相同**（都是 6220800 bytes），轉置的畫面會整個通過那道檢查。實際踩過：
 * `VIDCUT_CANVAS=landscape` 但沒有把專案本身設成橫式時，render 照直式輸出，前三個
 * case 的長度檢查全過，程式把直式幀當成橫式幀解讀，量出一堆物理上不可能的墨跡外框
 * （ov_wrap 量到 w=1920、h=120），看起來像「換行沒實作」——那是假象。所以尺寸要用
 * ffprobe 真的問一次，開場就對帳。
 */
async function probeSize(mp4) {
  const out = await runProc('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0',
    mp4,
  ]);
  const [w, h] = out.toString().trim().split(',').map(Number);
  return { w, h };
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

/**
 * 把臨時專案的畫布設成 `CANVAS`。走 `/ws` 的 `{type:'command'}` → `applyCommand`
 * ——跟 UI 同一條路（專案狀態變更一律走命令層是這個 repo 的鐵則）。
 *
 * 為什麼不是 MCP：`setCanvas` 目前**沒有對應的 MCP 工具**（工具面是 Plan 的後續任務）。
 * 為什麼不直接寫 `project.json`：繞過命令層等於跳過 preset 白名單、字卡預算安全網與
 * 重烤接線，量到的就不是使用者真的會拿到的那個專案。
 *
 * portrait 時這是 no-op（命令層自己會早退，version 不前進），但仍然照送——
 * 少一條分支，也順便讓「命令被拒」在任何比例下都會當場炸掉。
 */
async function applyCanvas() {
  const wsUrl = `ws://127.0.0.1:${PORT}/ws`;
  const sock = new WebSocket(wsUrl);
  try {
    await new Promise((res, rej) => {
      sock.on('open', res);
      sock.on('error', rej);
    });
    let rejected = null;
    sock.on('message', (d) => {
      try {
        const m = JSON.parse(d.toString());
        if (m.type === 'commandError' && m.reqId === 'wysiwyg-canvas') rejected = m.error;
      } catch {
        // 非 JSON 訊息忽略
      }
    });
    sock.send(
      JSON.stringify({
        // ⚠️ 命令的判別欄位是 `name` 不是 `type`（`shared/src/types.ts` 的 `Command`）；
        // 外層 WS 訊息才是 `type`。寫錯的話 server 回 `unknown command:`。
        type: 'command',
        cmd: { name: 'setCanvas', width: CANVAS.w, height: CANVAS.h },
        reqId: 'wysiwyg-canvas',
      }),
    );
    // 命令是非同步套用的，輪詢到 /api/project 真的變成新尺寸為止——沒有這段的話，
    // 後面 import_media / set_timeline 會跟 setCanvas 賽跑。
    for (let i = 0; i < 60; i++) {
      if (rejected) throw new Error(`setCanvas 被拒：${rejected}`);
      const doc = (await (await fetch(`${BASE}/api/project`)).json()).doc;
      if (doc?.canvas?.width === CANVAS.w && doc?.canvas?.height === CANVAS.h) return;
      await sleep(250);
    }
    throw new Error(`setCanvas ${CANVAS.w}×${CANVAS.h} 在 15 秒內沒有生效`);
  } finally {
    sock.close();
  }
}

// ---------------------------------------------------------------- fixture

/** 素材長度＝case 數（每個 case 各佔 1 秒、互不重疊）。加 case 記得一起加。 */
const FIXTURE_SECONDS = 6;

/** fixture 用的兩個字級（`populateProject()` 建 overlay 時用同樣的值）。 */
const FONT_SIZE = 96; // ov_scale1 / ov_scale05 / ov_offtop / ov_offcentre 與字幕
const WRAP_FONT_SIZE = 64; // ov_wrap（刻意小一級，才折得出多行）
/** ov_wrap 的 maxWidth 比例（`populateProject()` 送的值）。 */
const WRAP_MAX_WIDTH = 0.7;

/**
 * 字卡的行高。**複刻的是產品端的式子**（`server/src/cardBudget.ts` 的 `estimateCard`：
 * `line_h = size + max(6, size // 5)`），不是抄一個量出來的數字——這樣改字級或改行高
 * 公式時期望值會自己跟上。64px → 76、96px → 115。
 */
const lineH = (size) => size + Math.max(6, Math.floor(size / 5));

/**
 * ov_scale1 這一批（字級 96、單行、未被裁）的墨跡外框，實測值。
 *
 * ⚠️ 這是**唯一**一組實測常數，其餘期望值全部從它與畫布尺寸推導。它為什麼可以是
 * 絕對數字：墨跡尺寸只跟「字型 + 字級 + 那串文字」有關，**跟畫布多大完全無關**
 * （字卡是先照字級畫好、再擺到畫布上的）。實測直式 444×74、橫式 444×74，逐項相同。
 * 真的哪天不同了（換字型表、換光柵器），那是應該被看見的變化，不該被推導公式吸收掉。
 */
const INK_96 = { w: 444, h: 74 };
/**
 * 字級 64、**單行**的墨跡高度，實測值（理由同 `INK_96`：只跟字型/字級有關，與畫布無關）。
 *
 * 怎麼量出來的：`inkH(N 行) = line_h × (N-1) + 單行墨跡高`——墨跡高不是 `line_h × N`，
 * 因為最後一行底下沒有行距、上下也沒有卡片留白。直式量到 3 行 h=212 → 212 - 76×2 = 60；
 * 橫式量到 2 行 h=136 → 136 - 76×1 = 60。**兩個比例各自倒推出同一個 60**，
 * 這個模型不是湊出來的。
 */
const INK_LINE_64 = 60;

/** 字級 64 的文字折成 `n` 行時，墨跡外框應有的高度（見 `INK_LINE_64` 的推導）。 */
const wrapInkHeight = (n) => lineH(WRAP_FONT_SIZE) * (n - 1) + INK_LINE_64;
/**
 * 字卡上緣到墨跡上緣的距離（字級 96）。從兩個實測值倒推：ov_scale1 的 y=0.2 在直式下
 * 卡片上緣落在 1920×0.2=384，量到的墨跡 y0=399 → 15。（`text_card.py` 的 `yStart`
 * 是 `stroke_w + 4`：strokeW = max(2, 96//16) = 6 → 10，再加上字型 ascender 到墨跡
 * 頂端的空隙，合起來 15。這裡直接用倒推值，不重算字型內部的量。）
 */
const INK_TOP_PAD_96 = 15;

/**
 * ov_offtop 的擺法：卡片上緣要落在畫布上方 **57.6px**（＝直式的 y=-0.03，這個 case
 * 從 2026-08-04 起就是這個值）。
 *
 * ⚠️ 存進專案的是 `position.y`（比例），但「被裁掉多少」是**絕對 px** 的事。
 * 固定比例的話橫式（畫布高 1080）只會被裁掉 32px，74px 高的墨跡露出 56px——
 * 「有沒有被裁」這件事就幾乎驗不到了。固定 px、換算成比例存，才能讓這個 case
 * 在每個比例下**裁掉的量一樣多**，斷言強度也一樣。
 *
 * 取到小數第六位是為了讓直式**逐位元組落在 -0.03**（`-57.6/1920` 的浮點結果是
 * `-0.030000000000000002`，直接存進去等於改了既有專案檔的值）。
 */
const OFFTOP_CARD_TOP_PX = -57.6;
const offtopY = (canvas) => Number((OFFTOP_CARD_TOP_PX / canvas.h).toFixed(6));

/** ov_offcentre 的 `position.x`——本檔唯一 x ≠ 0.5 的項目（見那個 case 的長註解）。 */
const OFFCENTRE_X = 0.25;

/**
 * 專門為了「量得準」而設計的素材：純深灰滿版、與畫布同尺寸的影片（沒有 testsrc2 的
 * 花紋，亮度門檻才切得乾淨）、白字深描邊（墨跡＝白色字身，跟背景差 200+ luma）、
 * 六個項目各佔一段互不重疊的時間窗（同一幀只有一個東西，墨跡外框＝那個項目的外框，
 * 不必做連通區域分割這種會自己引入誤差的事）。多行那一項的墨跡外框是**整塊文字**
 * 的外框（不是單行），折行位置一分岔外框就會變——正是我們要抓的東西。
 *
 * ⚠️ **`exportInk` 的期望值一律寫成「從畫布尺寸推導的語意」，不得硬編畫布 px。**
 * 每個 case 的 `exportInk` 都是一個吃 `CANVAS` 的函式，回傳 `{ min, max, why }`。
 * 理由：這些條件的語意（「至少兩行」「不超過可用寬」「被上緣裁掉」「明顯偏左」）
 * 在每個比例下都一樣，只有換算出來的數字不同。為第二種比例抄第二組數字的話，
 * 第三種 preset（square / portrait-4-5）就得抄第三組——那條路只會越走越糟。
 */
const CASES = [
  {
    key: 'overlay-scale1',
    title: 'overlay（position.scale = 1）',
    frame: 15, // t = 0.5s
    note: '若寬比 ≈0.9：Player.tsx 的 overlay <img> 又被加上寬度夾制（曾是 maxWidth: 1080*0.9），render.ts 是原生尺寸合成',
  },
  {
    key: 'overlay-scale05',
    title: 'overlay（position.scale = 0.5）',
    frame: 45, // t = 1.5s
    note: '預覽端吃 CSS scale(0.5)；render.ts 要在 overlay 之前插 scale=iw*s:ih*s（2026-08-04 才補上，別又被拿掉）',
  },
  {
    key: 'caption',
    title: '字幕（無逐詞高亮）',
    frame: 75, // t = 2.5s
    note: '兩邊同一張 PNG、同一個位置——這一項綠才代表量測本身是準的',
  },
  {
    key: 'overlay-wrap',
    title: '文字 overlay（長文字自動換行，maxWidth 0.7）',
    frame: 105, // t = 3.5s
    /**
     * 這一項的「預覽 vs 成品」比對本身抓不到「換行沒實作」——文字 overlay 兩邊吃的是
     * 同一個 imagePath、同一張 PNG，不折行也會兩邊一樣地不折行。所以額外釘住成品側的
     * 墨跡形狀。**兩個條件都是語意，不是量出來的數字**：
     *
     * - `min.h = wrapInkHeight(2)`：「**至少折成兩行**」。字級 64 → 76×1 + 60 = 136，
     *   跟畫布無關（行高與單行墨跡高都只看字級）。
     *   ⚠️ 這裡刻意寫「兩行」而不是「三行」：折成幾行**取決於可用寬**（直式 756px
     *   折 3 行、量到 212；橫式 1344px 折 2 行、量到 136），寫死行數就等於把直式的
     *   數字偽裝成語意。這個 case 要驗的是「有沒有折」，兩行就已經證明有折了。
     * - `max.w = 畫布寬 × maxWidth`：「不超過可用寬」。1080 → 756、1920 → 1344。
     *
     * 換行一旦被拿掉，這段文字會排成單行約 2600px 寬：直式下被 1080 的畫布邊緣裁掉
     * → 高度掉到一行（60，遠低於 136）、寬度貼滿 1080（> 756），兩個條件同時破。
     * 橫式（可用寬 1344）下單行 2600px 一樣塞不下、一樣會被 1920 的畫布邊緣裁掉，
     * 兩個條件同樣同時破——這一項在兩個比例下都有效。
     */
    exportInk: (canvas) => ({
      min: { h: wrapInkHeight(2) },
      max: { w: Math.round(canvas.w * WRAP_MAX_WIDTH) },
      why:
        '這代表這段文字根本沒有折行（單行被畫布邊緣裁掉），' +
        '下面的「預覽 vs 成品」比對抓不到這件事——兩邊吃的是同一張 PNG。',
    }),
    note:
      '自動換行（2026-08-04）：maxWidth 以前是死欄位，長文字不折行、被畫布邊緣裁掉。' +
      '這一項紅通常代表折行位置在預覽與成品之間分岔——先看兩張 measure/*.png 的行數',
  },
  {
    key: 'overlay-offtop',
    title: 'overlay 掛在畫布上緣外（position.y 為負，被上緣裁掉）',
    frame: 135, // t = 4.5s
    /**
     * 為什麼是**上緣**（而不是下/左/右）：`5537a43` 把拖曳夾制從「整個元素留在畫布內」
     * 改成「元素中心留在畫布內」之後，**`position.y` 才第一次可能是負值**——x 那條
     * 在改之前就已經可以露出一半（錨點本來就是水平中心），y 卻被夾在 [0, 1-h/H]。
     * 也就是說「餵給 ffmpeg 一個負的 y」是這次新開的狀態空間，而它當時只有**手動**
     * 驗過一次（1920 畫布、200px 高的圖、y=-0.05 → 成品只剩 104px、從上緣裁掉，
     * 與預覽 stage 的 `overflow: hidden` 一致），沒有任何自動化守著。這個 case 補的就是它。
     *
     * 下緣/右緣**刻意不重複**：那兩邊的座標仍是正值（只是大於畫布尺寸），
     * 兩側都是同一條「超出就裁掉」的路徑，而每多一個 case 就是多一秒素材、
     * 多一次真 render 與一輪瀏覽器逐幀前進。
     * 左上角那種「一次吃兩個負座標」的擺法**評估後放棄**：stage 有 `borderRadius: 10`，
     * 預覽的四個角是圓角裁切、成品是方角，圓角半徑換算回畫布座標約 17px（大於容差 4），
     * 角落的墨跡會因為這個純視覺差異被判紅——那是假警報，不是座標的落差。
     * 所以這一項水平置中（x=0.5），墨跡離左右圓角很遠。
     *
     * exportInk：釘住成品側**真的被裁到**。同一段文字、同一個字級在 ov_scale1 那項量到的
     * 是 444×74（未被裁）；卡片上緣在畫布上方 57.6px（見 `OFFTOP_CARD_TOP_PX`），墨跡
     * 上緣還在卡片內 15px（`INK_TOP_PAD_96`）→ 露出的高度 = 74 - (57.6 - 15) ≈ 31.4，
     * 上緣貼齊 y0=0。渲染端要是哪天補了一手「保險用」的 `Math.max(0, H*y)`，墨跡會整個
     * 回到畫面內（y0>0、h 回到 74），這裡就會當場失敗——而「預覽 vs 成品」那段比對也會
     * 跟著紅，因為預覽端沒有那道夾制。
     *
     * **兩個條件都是語意**：`y0 ≤ 0`＝上緣貼齊；`h ≤ 露出高度 + 4`＝真的少了一截
     * （+4 是留給亮度門檻在斜坡上切位的量測餘裕，與 `TOL_PX` 同級）。因為
     * `OFFTOP_CARD_TOP_PX` 是絕對 px，這組數字在每個比例下都一樣（31.4 → 上限 35），
     * 斷言強度不隨畫布高度縮水。
     */
    exportInk: () => {
      const visible = INK_96.h - (-OFFTOP_CARD_TOP_PX - INK_TOP_PAD_96);
      return {
        max: { y0: 0, h: Math.ceil(visible + TOL_PX) },
        why:
          `成品應該被畫布上緣裁掉（墨跡上緣貼齊 y0=0、高度約 ${visible.toFixed(1)}px，` +
          `明顯小於未裁切的 ${INK_96.h}px）。沒被裁到通常代表渲染端把負的 y 夾成 0 了` +
          '（預覽端不會夾，那就是新的「預覽≠成品」）。',
      };
    },
    note:
      '掛在上緣外的 overlay（2026-08-04，夾制改成「中心留在畫布內」之後 y 才可能為負）：' +
      '預覽靠 stage 的 overflow:hidden 裁、成品靠 ffmpeg overlay 的負座標裁。' +
      '這一項紅代表兩邊的裁切位置對不上——先看 measure/ 裡兩張圖各露出多少字身',
  },
  {
    key: 'overlay-offcentre',
    title: 'overlay 水平不置中（position.x = 0.25）',
    frame: 165, // t = 5.5s
    /**
     * **水平軸的唯一覆蓋**（2026-08-05 補）。在這之前每一個 case 的 x 都是 0.5，而墨跡
     * 對中線是左右對稱的——實測把渲染端的 x 映射整個鏡射（`x → 1-x`）之後五項照樣全綠。
     * 也就是說這支腳本當時證明的是「垂直幾何對得上」，水平方向一個字都沒有驗到，
     * 而 `x=(W*x)-(w/2)` 那條式子（含 scale 之後 `w` 讀的是縮放後的寬）正是最容易寫錯的地方。
     *
     * x=0.25 是刻意挑的：鏡射會把它送到 0.75，兩者在畫布上差半個畫布寬（直式 540px、
     * 橫式 960px），遠大於容差；而墨跡（≈444px 寬）以畫布寬的四分之一為中心，
     * 直式橫跨 48–492、橫式橫跨 258–702，離左邊那顆 borderRadius 10（換算回畫布座標
     * 約 17px）夠遠，不會踩到 ov_offtop 註解裡記過的圓角假警報。
     *
     * exportInk：釘住成品側真的偏左。**語意是「落在四分之一處那一側，不是畫布中央」**，
     * 門檻取「四分之一處的左緣」與「置中的左緣」的中點——超過它就代表已經偏向中央了。
     * 直式：期望 48、置中 318 → 門檻 183；橫式：期望 258、置中 738 → 門檻 498。
     * 沒有這道的話，「x 被忽略、永遠置中」這種退化實作會讓兩邊一致地錯
     * （預覽端也讀同一個值就更巧合了），比對抓不到。
     */
    exportInk: (canvas) => {
      const wantX0 = canvas.w * OFFCENTRE_X - INK_96.w / 2;
      const centredX0 = canvas.w * 0.5 - INK_96.w / 2;
      return {
        max: { x0: Math.round((wantX0 + centredX0) / 2) },
        why:
          `成品的墨跡應該明顯偏左（x=${OFFCENTRE_X} → 左緣約 ${wantX0.toFixed(0)}px，` +
          `置中會是 ${centredX0.toFixed(0)}px）。落在畫布中央代表渲染端把 position.x ` +
          '忽略了，而「預覽 vs 成品」的比對對「兩邊一致地錯」是盲的。',
      };
    },
    note:
      '水平定位（2026-08-05 補的唯一 x≠0.5 case）：render.ts 的 x=(W*x)-(w/2) 與預覽端的 ' +
      'left + translate(-50%,0) 必須落在同一點。這一項單獨紅＝水平換算分岔了',
  },
];

async function buildFixture() {
  rmSync(PROJECT_DIR, { recursive: true, force: true });
  mkdirSync(ART_DIR, { recursive: true });
  // 純色滿版、與畫布同尺寸：scale/pad 是恆等，成品像素＝合成結果，中間沒有縮放。
  await runProc('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x181818:s=${CANVAS.w}x${CANVAS.h}:d=${FIXTURE_SECONDS}:r=${CANVAS.fps}`,
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
    throw new Error(
      'Server font table is empty (python3/Pillow missing?) — no cards, nothing to compare',
    );
  const family = fonts[0].family;

  // 畫布要**先**設好：字卡是內容定址的（畫布寬進 cardKey），先加 overlay 再換畫布
  // 等於多烤一輪、還要靠重烤接線收尾。這裡的順序讓每張卡從一開始就是新寬度的。
  await applyCanvas();

  const imported = await mcp('import_media', { relPath: 'bg.mp4', label: 'bg' });
  const mediaId = imported.data.mediaId;
  await mcp('set_timeline', { clips: [{ mediaId, in: 0, duration: FIXTURE_SECONDS }] });

  const text = {
    text: 'WYSIWYG',
    fontFamily: family,
    fontSize: FONT_SIZE,
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
  // 換行 case：一段中英混排、在 maxWidth 0.7 之下必然折成多行的長文字（可用寬
  // ＝畫布寬 × 0.7，直式 756px、橫式 1344px；這段文字排成單行約 2600px，兩者都放不下）。
  // 這是本檔唯一的多行 / CJK case——2026-08-04 之前「沒有多行也沒有 CJK」是這支腳本
  // 自己寫在檔尾的已知限制，而 maxWidth 當時是死欄位（長文字直接被畫布邊緣裁掉）。
  await mcp('add_overlay', {
    overlay: {
      id: 'ov_wrap',
      text: {
        text: '這是一段會自動換行的長標題 with mixed Latin words 一起測折行',
        fontFamily: family,
        fontSize: WRAP_FONT_SIZE,
        fill: '#ffffff',
        stroke: '#000000',
        maxWidth: WRAP_MAX_WIDTH,
      },
      start: 3,
      duration: 1,
      position: { x: 0.5, y: 0.2, scale: 1 },
    },
  });
  // 掛在畫布上緣外：position.y 為負（`5537a43` 把夾制改成「中心留在畫布內」之後才可能）。
  // 文字/字級與 ov_scale1 完全相同，所以「未被裁時是 444×74」是已知的對照值——
  // 這一項量到的高度明顯小於 74 才代表真的被上緣裁掉了。
  // ⚠️ y 是**算出來的**（見 `offtopY`）：固定比例的話橫式只會被裁掉一半的量，
  // 這個 case 的斷言強度會隨畫布變矮而縮水。直式仍然算出 -0.03（與參數化之前同值）。
  await mcp('add_overlay', {
    overlay: {
      id: 'ov_offtop',
      text,
      start: 4,
      duration: 1,
      position: { x: 0.5, y: offtopY(CANVAS), scale: 1 },
    },
  });
  // 水平不置中：本檔唯一 x ≠ 0.5 的項目。文字/字級與 ov_scale1 相同（未裁時 444×74），
  // 所以左緣的期望值算得出來：畫布寬×0.25 - 444/2（直式 48、橫式 258）。
  // 見 CASES 裡 overlay-offcentre 的長註解。
  await mcp('add_overlay', {
    overlay: {
      id: 'ov_offcentre',
      text,
      start: 5,
      duration: 1,
      position: { x: OFFCENTRE_X, y: 0.2, scale: 1 },
    },
  });
  await mcp('set_captions', {
    captions: [
      {
        id: 'cap_plain',
        text: 'CAPTION',
        start: 2,
        duration: 1,
        style: {
          fontFamily: family,
          fontSize: FONT_SIZE,
          fill: '#ffffff',
          stroke: '#000000',
          y: 0.6,
        },
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

/**
 * 「`ui/dist` 是不是比原始碼舊」——回傳第一個比 dist 新的檔案，全部都舊就回 null。
 *
 * 這道檢查不是潔癖。伺服器服務的是 build 產物，所以忘記 build 的時候這支腳本量的是
 * **上一版的 UI**：實測把預覽端的字幕 y 整個打歪（690px 的落差）之後不 build 再跑，
 * 五項全綠、exit 0——一個能讓已知缺陷通過的 gate，比沒有 gate 更危險，因為它會被當成
 * 「我驗過了」。CI 上不會踩到（每次都乾淨 build），本機開發正是最常忘記的場合。
 *
 * `shared/` 也要看：它被 bundle 進 UI 的 build 產物（吸附、karaoke clip 都在那裡）。
 * 用 mtime 而不是內容雜湊：夠準、零成本，代價只是「碰過但沒改內容」會誤報一次，
 * 而那個誤報的解法（重 build）本來就無害。
 */
function stalestSource() {
  const distAt = Math.max(...walkFiles(join(ROOT, 'ui/dist')).map((p) => statSync(p).mtimeMs), 0);
  const sources = [
    ...walkFiles(join(ROOT, 'ui/src')),
    ...walkFiles(join(ROOT, 'shared/src')),
    join(ROOT, 'ui/index.html'),
    join(ROOT, 'ui/vite.config.ts'),
    join(ROOT, 'ui/package.json'),
  ].filter((p) => existsSync(p) && !p.endsWith('.test.ts') && !p.endsWith('.test.tsx'));
  for (const p of sources) {
    if (statSync(p).mtimeMs > distAt) return { path: p.slice(ROOT.length + 1), at: distAt };
  }
  return null;
}

function walkFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}

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
  const stale = stalestSource();
  if (stale) {
    console.error(`✗ ui/dist 比原始碼舊：${stale.path} 改過了但沒重 build。`);
    console.error(`  伺服器服務的是 ui/dist，這樣跑等於在驗證**上一版**的 UI——`);
    console.error(`  六項會全綠，但那個綠什麼都不代表。先跑 \`npm run build -w @vidcut/ui\`。`);
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
    // 尺寸對帳（見 probeSize 的註解：轉置的畫面騙得過長度檢查）。
    const size = await probeSize(mp4);
    if (size.w !== CANVAS.w || size.h !== CANVAS.h) {
      throw new Error(
        `成品是 ${size.w}×${size.h}，預期 ${CANVAS.w}×${CANVAS.h}（畫布 preset ${CANVAS.id}）` +
          '——專案的畫布跟腳本以為的不一樣，後面每一個座標換算都會是假的。',
      );
    }

    const exportInk = {};
    for (const c of CASES) {
      exportInk[c.key] = inkBBox(await exportFrame(mp4, c.frame));
      if (!exportInk[c.key]) {
        throw new Error(`成品第 ${c.frame} 幀完全沒有墨跡（${c.title}）——fixture 或渲染壞了`);
      }
      // 成品側的形狀約束（只有給了 exportInk 的 case 才檢查）。存在的理由是：有些回歸
      // **兩邊會一起壞**（文字 overlay 的預覽與成品吃同一張 PNG；渲染端夾了負座標而
      // 預覽端也夾了的話同理），那時「預覽 vs 成品」的比對照樣是綠的。這道檢查釘的是
      // 「成品本身應該長什麼樣」，跟兩邊比對互補。
      // `c.exportInk` 是**吃 CANVAS 的函式**（不是常值物件）——期望值一律從畫布尺寸
      // 推導，見 CASES 上方的說明。
      if (c.exportInk) {
        const want = c.exportInk(CANVAS);
        const b = exportInk[c.key];
        const bad = [];
        for (const [k, v] of Object.entries(want.min ?? {})) {
          if (b[k] < v) bad.push(`${k}=${b[k]} 應 ≥ ${v}`);
        }
        for (const [k, v] of Object.entries(want.max ?? {})) {
          if (b[k] > v) bad.push(`${k}=${b[k]} 應 ≤ ${v}`);
        }
        if (bad.length) {
          throw new Error(
            `${c.title}：成品的墨跡外框 ${fmtBox(b)} 不符合預期形狀（${bad.join('、')}）。` +
              want.why,
          );
        }
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
    /**
     * 每一發 CDP 都帶 timeout。沒有 timeout 的話，任何一個沒回覆的呼叫（headless Chrome
     * 偶爾會在 Page.navigate / captureScreenshot 上卡住）會讓整支腳本**永遠 pending**
     * ——不是紅、不是綠，是掛著。當 gate 用的時候那是最糟的失敗模式：CI 上就是一格
     * 轉圈到逾時被砍，本機則是你以為還在跑。實際觀察過一次 `verify:panels` 掛了九分鐘。
     * 逾時就 reject，錯誤訊息帶方法名，一眼看得出卡在哪一步。
     */
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

    /**
     * 工具列的 timecode——獨立驗證 playhead 真的在我們以為的時間。
     * Plan 13 Task 3（裁決 5c）把格式從舊制 `m:ss.s / m:ss.s` 改成與 DragBadge
     * 一致：<60s 是一位小數的 `Ns`，>=60s 才是 `m:ss`（見 Toolbar.tsx 的 `fmt`）。
     * 這支腳本量的六個 case 全部 <60s，所以只需認得 `Ns / Ns` 這個分支；正則同步
     * 改過（舊正則永遠比對不到，讀出來一律 null，直到這次才被抓到——見
     * Plan 13 Task 4 report 的說明：這是 Task 3 遺留、Task 4 順手修的一行）。
     */
    const readTimecode = () =>
      evalJs(`(() => {
        const el = [...document.querySelectorAll('span')].find((s) =>
          /^\\d+\\.\\d+s\\s*\\/\\s*\\d+\\.\\d+s$/.test(s.textContent.trim()));
        return el ? el.textContent.trim().split('/')[0].trim() : null;
      })()`);

    const stageRect = async () =>
      evalJs(`(() => {
        // 錨定座標空間 wrapper，不是 document.querySelector('video')
        // ——Player 同時掛 A/B 兩顆 video，blur 填充時還有第三顆帶 scale(1.15) 的背景層。
        // ⚠️ 用 data-testid，**不要**回頭比對 '1080px'/'1920px'：畫布尺寸一變,
        // 字串比對不是變紅、是找不到元素直接掛掉。
        const wrapper = document.querySelector('[data-testid="canvas-layer"]');
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
      if (!st) throw new Error('找不到 [data-testid=canvas-layer] 座標空間 wrapper');
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

    // 容差是常數，量測精度卻隨 stage 大小變——太小就先擋下來（見 MIN_STAGE_W）。
    {
      const st0 = await stageRect();
      if (!st0) throw new Error('找不到 [data-testid=canvas-layer] 座標空間 wrapper');
      if (st0.w < MIN_STAGE_W) {
        throw new Error(
          `stage 只有 ${st0.w.toFixed(1)}px 寬（下限 ${MIN_STAGE_W}）——視窗 ` +
            `${VIEWPORT.w}×${VIEWPORT.h} 太小。這個尺寸下量測本底雜訊會超過容差 ` +
            `${TOL_PX}px，跑出來的紅是量測誤差不是回歸。把 VIDCUT_VIEWPORT 調大再跑。`,
        );
      }
      console.log(
        `stage 寬 ${st0.w.toFixed(1)}px（1 影像 px ≈ ${(CANVAS.w / st0.w).toFixed(2)} 畫布 px）`,
      );
    }

    const previewInkByCase = {};
    let atFrame = 0;
    for (const c of CASES) {
      await stepFrames(c.frame - atFrame);
      atFrame = c.frame;
      const tc = await readTimecode();
      // Toolbar.tsx 的 fmt()：<60s 用一位小數的 `Ns`（0.5 → "0.5s"，Plan 13 Task 3 裁決 5c）
      const wantTc = `${(c.frame / CANVAS.fps).toFixed(1)}s`;
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
    console.log(`\n量測換算（截圖 → ${CANVAS.w}×${CANVAS.h} 畫布座標）：\n${notes.join('\n')}`);
    console.log(`\n墨跡外框比對（單位：${CANVAS.w}×${CANVAS.h} 畫布 px，容差 ±${TOL_PX}）`);
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
        '  （五項本來全綠；字幕那項若也紅，先懷疑量測本身而不是渲染）',
    );
    process.exit(1);
  }
  console.log('\n✓ 全部通過：預覽與成品的墨跡外框在容差內一致');
}

await main();
