/**
 * e2e 腳本共用的畫布尺寸解析：把 `VIDCUT_CANVAS`（preset id）換成 `{ w, h }`。
 *
 * 為什麼是「讀原始碼再正則解析」而不是 import：
 * 這兩支腳本是用**裸 node** 跑的（`package.json` 的 `verify:canvas` / `verify:wysiwyg`
 * 就是 `node ui/e2e/*.mjs`），而 `@vidcut/shared` 的 entry 是 `./src/index.ts` ——
 * 沒有 dist、也沒有 tsx，`import` 一定失敗。
 *
 * 為什麼不照抄一份對照表：抄一份就會漂。preset 是純資料字面值，從
 * `shared/src/canvasPresets.ts` 直接解析出來，改了那邊這裡自動跟上；
 * 格式一旦變得解析不到（或解析結果少了 portrait），就**當場丟例外**，
 * 不會靜默退回一份過期的內建值。
 *
 * ⚠️ 這個 helper 刻意只做「查表」這一件事。CDP 那套 findChrome/connect/send 仍然
 * 三支腳本各自帶一份（見 preview-vs-export.mjs 檔頭的理由），不要順手抽進來。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PRESETS_TS = join(ROOT, 'shared/src/canvasPresets.ts');

/** 解析 `CANVAS_PRESETS` 陣列裡每一筆的 id/width/height。 */
function loadPresets() {
  const src = readFileSync(PRESETS_TS, 'utf8');
  const at = src.indexOf('CANVAS_PRESETS');
  if (at < 0) throw new Error(`${PRESETS_TS} 裡找不到 CANVAS_PRESETS`);
  const re = /\{\s*id:\s*'([a-z0-9-]+)',\s*width:\s*(\d+),\s*height:\s*(\d+)/g;
  const out = new Map();
  let m;
  while ((m = re.exec(src.slice(at)))) {
    out.set(m[1], { w: Number(m[2]), h: Number(m[3]) });
  }
  // portrait 是現狀行為的錨點（1080×1920）。解析不到它就代表這個正則跟原始碼脫節了,
  // 與其拿一份殘缺的表繼續跑（腳本會用錯尺寸算換算,量出一堆假的落差）,不如直接停。
  if (!out.has('portrait')) {
    throw new Error(
      `解析 ${PRESETS_TS} 失敗（找到 ${out.size} 筆,缺 portrait）——` +
        'CANVAS_PRESETS 的字面值格式可能改了,請同步更新 ui/e2e/canvasPreset.mjs 的正則。',
    );
  }
  return out;
}

/**
 * 依 `VIDCUT_CANVAS` 回傳畫布尺寸，預設 `portrait`（＝現狀的 1080×1920）。
 * @param {string | undefined} id preset id；未給時讀 process.env.VIDCUT_CANVAS
 * @returns {{ id: string, w: number, h: number }}
 */
export function resolveCanvas(id = process.env.VIDCUT_CANVAS) {
  const presets = loadPresets();
  const key = id ?? 'portrait';
  const found = presets.get(key);
  if (!found) {
    throw new Error(
      `VIDCUT_CANVAS='${key}' 不是已知的 preset。可用：${[...presets.keys()].join(', ')}`,
    );
  }
  return { id: key, w: found.w, h: found.h };
}
