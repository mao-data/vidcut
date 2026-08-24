import { nanoid } from 'nanoid';
import { isAbsolute } from 'node:path';
import type {
  AudioItem,
  Command,
  CommandResult,
  JsonPatch,
  MutationSource,
  OverlayItem,
  OverlayText,
  CaptionItem,
  VideoClip,
} from '@vidcut/shared';
import { totalDuration, clipSourceTime, clipContentDuration } from '@vidcut/shared';
import type { ProjectStore } from './store.js';
import { cardRequestError } from './cardBudget.js';
import { capToCardRequest } from './cardSync.js';
import { overlayTextToCardRequest } from './textOverlays.js';

const MIN_CLIP_DURATION = 0.1;
const DEFAULT_FREEZE_DURATION = 3;

/**
 * overlay 縮放倍率的理智上限。**不是**「畫面上看起來合理」的上限（那是使用者的事），
 * 而是「別把它變成記憶體炸彈」：渲染端會在 overlay 之前插 `scale=iw*s:ih*s`
 * （見 render.ts），一張 1080×1920 的字卡乘以 10 就是 207 Mpx ≈ 0.8 GB 的中間畫格。
 * 正當用途（把小圖示放大、把滿版圖縮小）遠遠用不到 10。
 */
const MAX_OVERLAY_SCALE = 10;

// ---- 數值健檢 ----------------------------------------------------------------
//
// 為什麼要在命令層擋，而不是靠呼叫端自律：`applyCommand` 是「人類 UI 與 MCP 共用的
// 唯一寫入語意來源」（見鐵則），但它以前對數字幾乎不設防。兩個一起發作的性質：
//   1. **NaN 跟任何值比較都是 false**，所以既有的 `if (o.duration <= 0)`、
//      `if (nextIn < 0)` 這類檢查會**放行** NaN——不是「檢查得不夠嚴」，是完全沒作用。
//   2. **`JSON.stringify(NaN)` 是 `null`**，Infinity 也是。所以壞值進到 project.json
//      的樣子是 `{"x": null}`，落盤之後每次載入都壞，而症狀要到 render 時才以
//      「ffmpeg 濾鏡運算式長得莫名其妙」的形式冒出來，離成因十萬八千里。
//
// UI 那側已經有一道保險絲（`ui/src/player/Player.tsx` 的 `finite()`，因為 stageW 還沒
// 量到時 `dx / 0` 會生出 NaN），但那**只保護畫布拖曳這一條路**。WS 通道本身沒有任何
// schema——`server/src/wsHub.ts` 是 `JSON.parse(data) as WsClientMsg` 直接餵進
// applyCommand，所以任何客戶端（舊版 UI、瀏覽器 console、外部腳本）送
// `{"position":{"x":null}}` 都會被原樣寫進文件。MCP 那條路的 zod `z.number()` 本來就
// 擋掉 NaN/null，所以這裡新增的檢查對 MCP 呼叫端是**同語意的**（不會讓原本能過的呼叫
// 變成不能過），補的是 WS 與程式內部呼叫那一段。
type FieldIssue = string | null;

/** 錯誤訊息裡怎麼稱呼這個壞值（NaN/Infinity 直接印，null/undefined 印字面）。 */
function shown(v: unknown): string {
  if (typeof v === 'number') return String(v);
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  return typeof v;
}

/** 必填數值欄位：必須是有限數。 */
function num(label: string, v: unknown): FieldIssue {
  return typeof v === 'number' && Number.isFinite(v)
    ? null
    : `${label} must be a finite number (got ${shown(v)})`;
}

/** 可選數值欄位：沒給（undefined）就放行；給了就得是有限數。 */
function optNum(label: string, v: unknown): FieldIssue {
  return v === undefined ? null : num(label, v);
}

/** 回第一個有問題的欄位（全部合格回 null）。 */
function firstIssue(...issues: FieldIssue[]): FieldIssue {
  return issues.find((e) => e !== null) ?? null;
}

/**
 * derived 檔路徑（proxyPath/filmstripPath/peaksPath）的形狀檢查：必須是**專案內相對路徑**。
 * 這些檔案永遠是伺服器自己轉檔產出、寫在專案資料夾底下（見 ingest.ts 的
 * `join(derivedRel, 'proxy.mp4')` 等），不是使用者指定的外部引用——與
 * `MediaAsset.path` 允許絕對路徑（零複製匯入外部原始檔，見 paths.ts 的
 * `resolveMediaPath`）是不同語意，不要沿用那邊「絕對路徑合法」的規則。
 * 擋 `..` 是為了不讓 derived 路徑逃出專案資料夾（路徑穿越）。
 */
function derivedPathIssue(label: string, v: string | undefined): FieldIssue {
  if (v === undefined) return null;
  if (typeof v !== 'string' || v.length === 0) {
    return `${label} must be a non-empty string (got ${shown(v)})`;
  }
  if (isAbsolute(v)) return `${label} must be project-relative, not absolute (got ${v})`;
  if (v.split(/[/\\]/).includes('..')) {
    return `${label} must not contain ".." (path traversal): ${v}`;
  }
  return null;
}

/**
 * overlay 位置。
 *
 * **x/y 刻意不做範圍檢查**：元素可以部分（甚至整個）掛在畫布外，這是 2026-08-04 起
 * 明講的語意（見 `OverlayItem.position` 的註解與 MCP `add_overlay` 的欄位說明），
 * UI 拖曳的「中心留在畫布內」是 UI 的夾制、不是資料的約束。把 0–1 搬進來會讓
 * 合法的出血排版變成錯誤，那是回歸。這裡只驗**有限性**。
 *
 * scale 是唯一有範圍的：負值在預覽是鏡像（CSS transform）、在成品是整張不合成
 * （render.ts 的 `s > 0` 判斷）——一個貨真價實的「預覽 ≠ 成品」落差，擋在這裡比較好。
 * 0 維持可用（兩邊都是「看不見」，已是明講的行為）。上限見 MAX_OVERLAY_SCALE。
 */
function positionIssue(
  label: string,
  p: OverlayItem['position'] | undefined,
  required: boolean,
): FieldIssue {
  if (p === undefined) return required ? `${label} is required ({x, y, scale})` : null;
  if (p === null || typeof p !== 'object')
    return `${label} must be an object {x, y, scale} (got ${shown(p)})`;
  const bad = firstIssue(
    num(`${label}.x`, p.x),
    num(`${label}.y`, p.y),
    num(`${label}.scale`, p.scale),
  );
  if (bad) return bad;
  if (p.scale < 0 || p.scale > MAX_OVERLAY_SCALE)
    return `${label}.scale must be within 0–${MAX_OVERLAY_SCALE} (got ${p.scale})`;
  return null;
}

function anchorIssue(label: string, a: OverlayItem['anchor']): FieldIssue {
  if (a === undefined) return null;
  if (a === null || typeof a !== 'object')
    return `${label} must be an object {clipId, offset} (got ${shown(a)})`;
  return num(`${label}.offset`, a.offset);
}

function overlayIssue(label: string, o: OverlayItem): FieldIssue {
  return firstIssue(
    optNum(`${label}.start`, o.start),
    // duration: null ＝「到片尾」（JSON 存不了 Infinity），是合法值。
    // ⚠️ 代價講清楚：呼叫端若算出 NaN，序列化後也長成 null，在**這個欄位**會被當成
    // 「到片尾」而不是錯誤——因為兩者在線上完全同形，伺服器沒有辦法分辨。
    // 其餘欄位沒有這個歧義（null 一律是錯），所以只有 duration 有這個盲點。
    o.duration === null ? null : num(`${label}.duration`, o.duration),
    anchorIssue(`${label}.anchor`, o.anchor),
    positionIssue(`${label}.position`, o.position, true),
  );
}

/**
 * 字幕樣式。`fontSize` 這裡不重複驗——`validateCaptionCard` → `cardRequestError`
 * 已經是它的權責歸屬（而且會連帶算像素預算），兩邊都寫只會讓「哪一句錯誤先出現」
 * 變成看不出所以然的巧合。`y` 沒有任何人驗，就是這裡。
 * y 同樣**不夾 0–1**：字幕卡也能被拖到畫面外一點點，只擋非有限值。
 */
function captionStyleIssue(
  label: string,
  s: CaptionItem['style'] | undefined,
  required: boolean,
): FieldIssue {
  if (s === undefined) return required ? `${label} is required` : null;
  if (s === null || typeof s !== 'object') return `${label} must be an object (got ${shown(s)})`;
  return num(`${label}.y`, s.y);
}

/** 逐詞時間戳：壞掉的 start/end 會讓 render 的逐詞字卡視窗算出空的/反向的區間。 */
function tokensIssue(label: string, tokens: CaptionItem['tokens']): FieldIssue {
  if (tokens === undefined) return null;
  if (!Array.isArray(tokens)) return `${label} must be an array (got ${shown(tokens)})`;
  for (const [i, t] of tokens.entries()) {
    const bad = firstIssue(
      num(`${label}[${i}].start`, t?.start),
      num(`${label}[${i}].end`, t?.end),
    );
    if (bad) return bad;
  }
  return null;
}

function captionIssue(label: string, c: CaptionItem): FieldIssue {
  return firstIssue(
    num(`${label}.start`, c.start),
    num(`${label}.duration`, c.duration),
    captionStyleIssue(`${label}.style`, c.style, true),
    tokensIssue(`${label}.tokens`, c.tokens),
  );
}

function audioIssue(label: string, a: AudioItem): FieldIssue {
  return firstIssue(
    num(`${label}.start`, a.start),
    num(`${label}.in`, a.in),
    num(`${label}.duration`, a.duration),
    num(`${label}.volume`, a.volume),
    optNum(`${label}.fadeIn`, a.fadeIn),
    optNum(`${label}.fadeOut`, a.fadeOut),
  );
}

/**
 * 一個命令裡所有數值欄位的健檢入口。回 null 代表數字都合格（不代表命令合法——
 * 各命令自己的語意檢查照跑）。
 *
 * 放在 `applyCommand` 最前面而不是散在各 case 裡，是為了「新增一種編輯操作」時
 * 只有一個地方要補：漏補的話這裡的 switch 會少一個 case，比起在十幾個 case 內部
 * 找漏掉的欄位好追。`removeClip` / `reorderClips` / `setCanvasFit` / `undo` / `redo`
 * 等沒有數值欄位（或數值不進文件）的命令走 default。
 */
function numericError(cmd: Command): string | null {
  switch (cmd.name) {
    case 'updateClip':
      return firstIssue(
        optNum('patch.in', cmd.patch.in),
        optNum('patch.duration', cmd.patch.duration),
        optNum('patch.volume', cmd.patch.volume),
        optNum('patch.leadPad', cmd.patch.leadPad),
      );
    case 'setTimeline':
      return firstIssue(
        ...cmd.clips.flatMap((c, i) => [
          num(`clips[${i}].in`, c.in),
          num(`clips[${i}].duration`, c.duration),
          optNum(`clips[${i}].volume`, c.volume),
          optNum(`clips[${i}].leadPad`, c.leadPad),
        ]),
      );
    case 'addClip':
      return firstIssue(
        num('in', cmd.in),
        num('duration', cmd.duration),
        optNum('leadPad', cmd.leadPad),
      );
    case 'addOverlay':
      return overlayIssue('overlay', cmd.overlay);
    case 'setOverlays':
      return firstIssue(...cmd.overlays.map((o, i) => overlayIssue(`overlays[${i}]`, o)));
    case 'updateOverlay':
      return firstIssue(
        optNum('patch.start', cmd.patch.start),
        cmd.patch.duration === undefined || cmd.patch.duration === null
          ? null
          : num('patch.duration', cmd.patch.duration),
        anchorIssue('patch.anchor', cmd.patch.anchor),
        positionIssue('patch.position', cmd.patch.position, false),
      );
    case 'updateCaption':
      return firstIssue(
        optNum('patch.start', cmd.patch.start),
        optNum('patch.duration', cmd.patch.duration),
        captionStyleIssue('patch.style', cmd.patch.style, false),
        tokensIssue('patch.tokens', cmd.patch.tokens),
      );
    case 'setCaptions':
      return firstIssue(...cmd.captions.map((c, i) => captionIssue(`captions[${i}]`, c)));
    case 'setAudio':
      return firstIssue(...cmd.audio.map((a, i) => audioIssue(`audio[${i}]`, a)));
    case 'updateAudio':
      return firstIssue(
        optNum('patch.start', cmd.patch.start),
        optNum('patch.in', cmd.patch.in),
        optNum('patch.duration', cmd.patch.duration),
        optNum('patch.volume', cmd.patch.volume),
        optNum('patch.fadeIn', cmd.patch.fadeIn),
        optNum('patch.fadeOut', cmd.patch.fadeOut),
      );
    case 'splitAt':
    case 'deleteBefore':
    case 'deleteAfter':
      return num('time', cmd.time);
    case 'freezeFrame':
      return firstIssue(num('time', cmd.time), optNum('duration', cmd.duration));
    default:
      return null;
  }
}

// ---- 項目級規則（set* 與 update* 共用）----------------------------------------
//
// 為什麼要抽出來：這些規則以前在「整組替換」與「改單項」兩處各寫了一次，然後分岔——
// 不是誰忘了驗，是同一條規則有兩份實作，只補一邊就會再分岔一次。實際的落差：
//   set_captions   收 duration <= 0；update_caption 拒（實測 {start:-99, duration:0} 進了文件）
//   set_audio      收 start < 0 與 fadeIn > duration；update_audio 兩個都拒
// start < 0 的音訊項不會報錯也不會不見：render 的 `if (delayMs > 0)` 讓 adelay 整個被
// 跳過，那段聲音靜靜地從 t=0 開始播——症狀離成因很遠，而且成品才聽得出來。
//
// 這裡收的是「這個項目本身合不合法」。跨項目的規則（id 重複、media 存在）留在各自的
// case，因為 set* 與 update* 對它們的要求本來就不同（前者在建立、後者在修改既有項目）。

/** 只覆寫「有給值」的鍵。`{start: undefined}` 不該把既有的 start 洗成 undefined。 */
function merge<T extends object>(base: T, patch: Partial<T>): T {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * 一條字幕本身該滿足的規則（不含字卡像素預算，那是 validateCaptionCard）。
 *
 * `start` **刻意不夾 >= 0**：`start = -0.5, duration = 2` 是合法的「出血」——成品的
 * `enable=between(t\,-0.5\,1.5)` 天然從 t=0 開始顯示、SRT 的 `stamp()` 也有
 * `Math.max(0, …)`，兩邊都正確裁切。這跟 `OverlayItem.position` 明文允許元素掛在畫布外
 * 是同一個立場（見 positionIssue 的註解：把範圍檢查搬進來會讓合法的出血排版變成錯誤）。
 *
 * 擋的是**整段落在 t=0 之前**——那句字幕在成品裡永遠不會出現，不可能是意圖，而且以前
 * 工具會回一句 ok。（音訊沒有這個彈性，`start < 0` 一律擋：render 的
 * `if (delayMs > 0)` 會讓 adelay 整條被跳過，那段聲音**不是被裁掉，是整段從 t=0 播**。）
 */
function captionRuleError(c: CaptionItem): string | null {
  if (c.duration <= 0) return 'duration must be > 0';
  if (c.start + c.duration <= 0) {
    return `ends at t=${c.start + c.duration} (start=${c.start}), entirely before the timeline starts — it would never appear`;
  }
  return null;
}

/**
 * 一個音訊項本身該滿足的規則。`media` 給了才驗來源邊界——update 的目標素材有可能
 * 已經被移除，那不該連調音量都做不到（維持 updateAudio 原本的寬容）。
 */
function audioRuleError(
  a: AudioItem,
  media: { probe: { duration: number } } | undefined,
): string | null {
  if (a.start < 0) return 'start must be >= 0';
  if (a.in < 0) return 'in must be >= 0';
  if (a.duration <= 0) return 'duration must be > 0';
  if (a.volume < 0 || a.volume > 2) return 'volume must be within 0..2';
  for (const k of ['fadeIn', 'fadeOut'] as const) {
    const v = a[k];
    if (v !== undefined && (v < 0 || v > a.duration)) return `${k} must be within 0..duration`;
  }
  if (media && a.in + a.duration > media.probe.duration + 1e-6) {
    return `in+duration exceeds source ${media.probe.duration}`;
  }
  return null;
}

/** 主軌是磁性的：片段起點 = 前面所有片段長度累加。 */
function startsOf(clips: VideoClip[]): number[] {
  const out: number[] = [];
  let t = 0;
  for (const c of clips) {
    out.push(t);
    t += c.duration;
  }
  return out;
}

/** 找出時間軸絕對時間落在哪個片段，回傳索引與片段內偏移。 */
function clipAt(
  clips: VideoClip[],
  time: number,
): { index: number; offset: number; start: number } | null {
  if (time < 0) return null;
  const starts = startsOf(clips);
  for (let i = clips.length - 1; i >= 0; i--) {
    if (time >= starts[i]!) return { index: i, offset: time - starts[i]!, start: starts[i]! };
  }
  return null;
}

/**
 * 人類 UI 與 MCP 工具共用的唯一寫入語意來源（OpenChatCut EditorCore 模式）。
 * 每個命令先驗證，通過才 store.mutate。失敗回 {ok:false,error}，絕不靜默。
 */
export function applyCommand(
  store: ProjectStore,
  source: MutationSource,
  cmd: Command,
): CommandResult {
  // 數值健檢先於一切語意檢查：壞掉的數字是「這個命令根本不該存在」的等級，
  // 而且錯誤訊息要指名欄位（見 numericError）。
  const numErr = numericError(cmd);
  if (numErr) return { ok: false, error: numErr };
  switch (cmd.name) {
    case 'updateClip':
      return updateClip(store, source, cmd);
    case 'reorderClips':
      return reorderClips(store, source, cmd);
    case 'removeClip':
      return removeClip(store, source, cmd);
    case 'addClip':
      return addClip(store, source, cmd);
    case 'setTimeline':
      return setTimeline(store, source, cmd);
    case 'updateOverlay':
      return updateOverlay(store, source, cmd);
    case 'addOverlay':
      return addOverlay(store, source, cmd);
    case 'removeOverlay': {
      if (!store.doc.tracks.overlays.some((o) => o.id === cmd.id)) {
        return { ok: false, error: `overlay not found: ${cmd.id}` };
      }
      return ok(
        store.mutate(source, 'remove overlay', (d) => {
          d.tracks.overlays = d.tracks.overlays.filter((o) => o.id !== cmd.id);
        }),
      );
    }
    case 'updateCaption':
      return updateCaption(store, source, cmd);
    case 'setOverlays':
      return setOverlays(store, source, cmd);
    case 'setCaptions': {
      // 整批中任一句不合格就整批拒絕、文件完全不動：cardSync 之後會拿文件裡的每一句
      // 去產卡，讓它落盤等於把一顆定時炸彈存進專案（每次載入都會再試一次）。
      for (const cap of cmd.captions) {
        const ruleErr = captionRuleError(cap as CaptionItem);
        if (ruleErr) return { ok: false, error: `caption ${cap.id}: ${ruleErr}` };
        const err = validateCaptionCard(cap as CaptionItem, store.doc.canvas.width);
        if (err) return { ok: false, error: err };
      }
      return ok(
        store.mutate(source, 'set captions', (d) => {
          d.tracks.captions = cmd.captions as CaptionItem[];
        }),
      );
    }
    case 'splitAt':
      return splitAt(store, source, cmd.time);
    case 'deleteBefore':
      return deleteSide(store, source, cmd.time, 'before');
    case 'deleteAfter':
      return deleteSide(store, source, cmd.time, 'after');
    case 'freezeFrame':
      return freezeFrame(store, source, cmd.time, cmd.duration ?? DEFAULT_FREEZE_DURATION);
    case 'extractAudio':
      return extractAudio(store, source, cmd.clipId);
    case 'updateAudio':
      return updateAudio(store, source, cmd);
    case 'removeAudio': {
      if (!store.doc.tracks.audio.some((a) => a.id === cmd.id)) {
        return { ok: false, error: `audio not found: ${cmd.id}` };
      }
      return ok(
        store.mutate(source, 'remove audio', (d) => {
          d.tracks.audio = d.tracks.audio.filter((a) => a.id !== cmd.id);
        }),
      );
    }
    case 'setAudio': {
      // 與 addClip 對稱的逐項驗證。空陣列＝清空音訊軌，是合法且被既有測試依賴的用法，
      // 所以驗證放在迴圈裡（空陣列自然不進迴圈），不要在外面加「必須非空」。
      // 項目本身的規則走 audioRuleError——跟 updateAudio 同一份，見該函式的註解。
      for (const a of cmd.audio) {
        const media = store.doc.media.find((m) => m.id === a.mediaId);
        if (!media) return { ok: false, error: `audio ${a.id}: media not found: ${a.mediaId}` };
        const ruleErr = audioRuleError(a, media);
        if (ruleErr) return { ok: false, error: `audio ${a.id}: ${ruleErr}` };
      }
      return ok(
        store.mutate(source, 'set audio', (d) => {
          d.tracks.audio = cmd.audio as AudioItem[];
        }),
      );
    }
    case 'setCanvasFit':
      return ok(
        store.mutate(source, `canvas fit: ${cmd.fit}`, (d) => {
          d.canvas.fit = cmd.fit;
        }),
      );
    case 'registerMedia': {
      const a = cmd.asset;
      if (!a || typeof a !== 'object') return { ok: false, error: 'asset is required' };
      if (!a.id || !a.path) return { ok: false, error: 'asset needs a non-empty id and path' };
      // id 是 nanoid，撞號幾乎不可能——但這是唯一寫 doc.media 的地方，重複的 id 會讓
      // 後面每一個 `media.find(m => m.id === ...)` 靜靜地拿到錯的那一筆。
      if (store.doc.media.some((m) => m.id === a.id)) {
        return { ok: false, error: `media id already exists: ${a.id}` };
      }
      return ok(
        store.mutate(source, `import ${a.path}`, (d) => {
          d.media.push(a);
        }),
      );
    }
    // ⚠️ 內部命令,刻意不進 MCP 工具面(鐵則三的顯式豁免)：這個命令是背景 ingest
    // pipeline（Plan 8 的 A1 filmstrip/peaks、A2 proxy 階段）寫回 derived 檔路徑的
    // 唯一管道,呼叫端固定是 server 內部的 ingest 流程(Task 3,`applyCommand('human', ...)`),
    // 不是人或 AI 在編輯時會下的指令——AI 沒有正當理由去指定「這支素材的 proxy 檔
    // 存在這裡」，那個路徑是伺服器跑完轉檔才知道的產物，不是使用者意圖。與
    // registerMedia 不同的是 registerMedia 有 import_media 這個聚合工具間接觸達
    // （見 mcp-docs-sync.test.ts 的 MCP_EXEMPT_COMMANDS），這個命令連間接路徑都沒有
    // ——background 階段完成後直接呼叫 applyCommand，不經過任何 MCP 工具。
    // 不要「補上」對應的 registerTool：這不是漏做第三步，是刻意在第二步停下。
    case 'updateMediaDerived': {
      const media = store.doc.media.find((m) => m.id === cmd.mediaId);
      if (!media) return { ok: false, error: `media not found: ${cmd.mediaId}` };
      const p = cmd.patch;
      const pathErr =
        derivedPathIssue('proxyPath', p.proxyPath) ??
        derivedPathIssue('filmstripPath', p.filmstripPath) ??
        derivedPathIssue('peaksPath', p.peaksPath);
      if (pathErr) return { ok: false, error: pathErr };
      if (p.filmstripTiles !== undefined) {
        if (!Number.isInteger(p.filmstripTiles) || p.filmstripTiles <= 0) {
          return {
            ok: false,
            error: `filmstripTiles must be a positive integer (got ${shown(p.filmstripTiles)})`,
          };
        }
      }
      return ok(
        store.mutate(
          source,
          `update media derived: ${cmd.mediaId}`,
          (d) => {
            const m = d.media.find((x) => x.id === cmd.mediaId)!;
            if (p.proxyPath !== undefined) m.proxyPath = p.proxyPath;
            if (p.filmstripPath !== undefined) m.filmstripPath = p.filmstripPath;
            if (p.filmstripTiles !== undefined) m.filmstripTiles = p.filmstripTiles;
            if (p.peaksPath !== undefined) m.peaksPath = p.peaksPath;
          },
          // 系統對既有素材補記的衍生事實，不是這輪審核想撤銷的編輯意圖——見
          // HistoryEntry.excludeFromRevert 與 revertSince 的註解（Plan 8 review round 1）。
          { excludeFromRevert: true },
        ),
      );
    }
    case 'setCover': {
      if (!cmd.path) return { ok: false, error: 'cover path must not be empty' };
      return ok(
        store.mutate(source, 'set cover', (d) => {
          d.render.coverPath = cmd.path;
        }),
      );
    }
    case 'setPublish': {
      if (!cmd.info.dir) return { ok: false, error: 'publish dir must not be empty' };
      if (cmd.info.platforms.length === 0)
        return { ok: false, error: 'publish platforms must not be empty' };
      return ok(
        store.mutate(source, 'publish package', (d) => {
          d.render.publish = cmd.info;
        }),
      );
    }
    case 'undo': {
      const r = store.undo(source, cmd.steps ?? 1);
      return r ? { ok: true, version: r.version } : { ok: false, error: 'nothing to undo' };
    }
    case 'redo': {
      const r = store.redo(source, cmd.steps ?? 1);
      return r ? { ok: true, version: r.version } : { ok: false, error: 'nothing to redo' };
    }
    default: {
      const _exhaustive: never = cmd;
      return { ok: false, error: `unknown command: ${JSON.stringify(_exhaustive)}` };
    }
  }
}

/**
 * 把 `store.mutate` 的結果收成 CommandResult。`changed` 來自 immer 實際產生的 patch 數：
 * 零個 ＝ 這個命令什麼都沒改（`patch: {}`、送了跟現值相同的座標、schema 把打錯的鍵
 * strip 掉之後剩下空 patch…）。見 CommandResult 的註解。
 */
function ok(r: { version: number; patches: JsonPatch[] }): CommandResult {
  return { ok: true, version: r.version, changed: r.patches.length > 0 };
}

function updateClip(
  store: ProjectStore,
  source: MutationSource,
  cmd: Extract<Command, { name: 'updateClip' }>,
): CommandResult {
  const clip = store.doc.tracks.video.find((c) => c.id === cmd.clipId);
  if (!clip) return { ok: false, error: `clip not found: ${cmd.clipId}` };
  const media = store.doc.media.find((m) => m.id === clip.mediaId);
  const srcDur = media?.probe.duration ?? Infinity;

  const nextIn = cmd.patch.in ?? clip.in;
  const nextDur = cmd.patch.duration ?? clip.duration;
  const nextPad = cmd.patch.leadPad ?? clip.leadPad ?? 0;
  const nextContentDur = nextDur - nextPad;
  if (nextIn < 0) return { ok: false, error: 'in must be >= 0' };
  if (nextPad < 0) return { ok: false, error: 'leadPad must be >= 0' };
  if (nextContentDur < MIN_CLIP_DURATION)
    return {
      ok: false,
      error: `content duration (duration − leadPad = ${nextContentDur}) must be >= ${MIN_CLIP_DURATION}`,
    };
  // 無 leadPad（pad=0）時這條就是舊式子 `nextIn + nextDur <= srcDur`——換式子不是回歸，
  // 是把「內容長度」換成「時間軸長度」的正確算法：黑墊段不佔來源時長，不該被算進來源邊界。
  if (nextIn + nextContentDur > srcDur + 1e-6) {
    return {
      ok: false,
      error: `in+content duration (${nextIn + nextContentDur}) exceeds source ${srcDur}`,
    };
  }
  if (cmd.patch.volume !== undefined && (cmd.patch.volume < 0 || cmd.patch.volume > 2)) {
    return { ok: false, error: 'volume must be within 0..2' };
  }

  return ok(
    store.mutate(source, `edit ${clip.label ?? clip.id}`, (d) => {
      const c = d.tracks.video.find((x) => x.id === cmd.clipId)!;
      if (cmd.patch.in !== undefined) c.in = cmd.patch.in;
      if (cmd.patch.duration !== undefined) c.duration = cmd.patch.duration;
      if (cmd.patch.volume !== undefined) c.volume = cmd.patch.volume;
      if (cmd.patch.label !== undefined) c.label = cmd.patch.label;
      // 終審 Info-1：收斂到 addClip/setTimeline/splitAt/deleteBefore 共用的省略式慣例
      // ——leadPad<=0 就 delete 鍵，不落盤顯式 `leadPad: 0`。patch 語意不變：省略
      // `cmd.patch.leadPad`（undefined）仍是「不動」；顯式送 0 是「清除黑墊」，
      // 落盤後 `leadPad` 鍵消失，讀取端 `?? 0` 與省略時逐位元組相同。
      if (cmd.patch.leadPad !== undefined) {
        if (cmd.patch.leadPad > 0) c.leadPad = cmd.patch.leadPad;
        else delete c.leadPad;
      }
    }),
  );
}

function reorderClips(
  store: ProjectStore,
  source: MutationSource,
  cmd: Extract<Command, { name: 'reorderClips' }>,
): CommandResult {
  const current = store.doc.tracks.video.map((c) => c.id);
  if (
    cmd.order.length !== current.length ||
    new Set(cmd.order).size !== cmd.order.length ||
    !cmd.order.every((id) => current.includes(id))
  ) {
    return { ok: false, error: 'order must be a permutation of existing clip ids' };
  }
  return ok(
    store.mutate(source, 'reorder clips', (d) => {
      const byId = new Map(d.tracks.video.map((c) => [c.id, c]));
      d.tracks.video = cmd.order.map((id) => byId.get(id)!);
    }),
  );
}

function removeClip(
  store: ProjectStore,
  source: MutationSource,
  cmd: Extract<Command, { name: 'removeClip' }>,
): CommandResult {
  if (!store.doc.tracks.video.some((c) => c.id === cmd.clipId)) {
    return { ok: false, error: `clip not found: ${cmd.clipId}` };
  }
  return ok(
    store.mutate(source, `remove ${cmd.clipId}`, (d) => {
      d.tracks.video = d.tracks.video.filter((c) => c.id !== cmd.clipId);
    }),
  );
}

function addClip(
  store: ProjectStore,
  source: MutationSource,
  cmd: Extract<Command, { name: 'addClip' }>,
): CommandResult {
  const media = store.doc.media.find((m) => m.id === cmd.mediaId);
  if (!media) return { ok: false, error: `media not found: ${cmd.mediaId}` };
  if (media.probe.hasVideo === false) {
    return { ok: false, error: `${cmd.mediaId} is audio-only — put it on the audio track` };
  }
  if (cmd.in < 0) return { ok: false, error: 'clip in must be >= 0' };
  const leadPad = cmd.leadPad ?? 0;
  if (leadPad < 0) return { ok: false, error: 'leadPad must be >= 0' };
  const contentDur = cmd.duration - leadPad;
  if (contentDur < MIN_CLIP_DURATION) {
    return {
      ok: false,
      error: `content duration (duration − leadPad = ${contentDur}) must be >= ${MIN_CLIP_DURATION}`,
    };
  }
  if (cmd.in + contentDur > media.probe.duration + 1e-6) {
    return { ok: false, error: `clip out of bounds for ${cmd.mediaId}` };
  }
  return ok(
    store.mutate(source, `add clip ${cmd.label ?? cmd.mediaId}`, (d) => {
      d.tracks.video.push({
        id: nanoid(6),
        mediaId: cmd.mediaId,
        in: cmd.in,
        duration: cmd.duration,
        volume: 1,
        ...(cmd.label ? { label: cmd.label } : {}),
        ...(cmd.leadPad ? { leadPad: cmd.leadPad } : {}),
      });
    }),
  );
}

/**
 * 整組替換影片主軌。逐項驗證後整批套用——任一項不合格就整批拒絕、文件完全不動
 * （與 setOverlays／setCaptions／setAudio 同一個立場）。
 *
 * id：帶了就沿用（錨定的 overlay 因此活得下來），沒帶就給一個 nanoid。
 * **不再用 `clip_${索引}_${mediaId}` 推導**——理由見 TimelineClipSpec 的註解，簡言之
 * 那個決定性的名字在重排之後會指到另一個片段，比變成孤兒更難發現。
 */
function setTimeline(
  store: ProjectStore,
  source: MutationSource,
  cmd: Extract<Command, { name: 'setTimeline' }>,
): CommandResult {
  const seen = new Set<string>();
  for (const c of cmd.clips) {
    const media = store.doc.media.find((m) => m.id === c.mediaId);
    if (!media) return { ok: false, error: `unknown mediaId ${c.mediaId}` };
    if (media.probe.hasVideo === false) {
      return { ok: false, error: `${c.mediaId} is audio-only — put it on the audio track` };
    }
    if (c.in < 0 || c.duration <= 0) {
      return { ok: false, error: `clip out of bounds for ${c.mediaId}` };
    }
    // setTimeline 是整組替換：沒帶 leadPad 就是 0（不沿用舊值——與其他欄位同語意，見
    // TimelineClipSpec.leadPad 的註解）。
    const leadPad = c.leadPad ?? 0;
    if (leadPad < 0) return { ok: false, error: `leadPad must be >= 0 for ${c.mediaId}` };
    const contentDur = c.duration - leadPad;
    if (contentDur < MIN_CLIP_DURATION) {
      return {
        ok: false,
        error: `content duration (duration − leadPad = ${contentDur}) must be >= ${MIN_CLIP_DURATION} for ${c.mediaId}`,
      };
    }
    if (c.in + contentDur > media.probe.duration + 1e-6) {
      return { ok: false, error: `clip out of bounds for ${c.mediaId}` };
    }
    if (c.volume !== undefined && (c.volume < 0 || c.volume > 2)) {
      return { ok: false, error: 'volume must be within 0..2' };
    }
    if (c.id !== undefined) {
      // 重複的 id 會讓後面每一個 `video.find(c => c.id === ...)` 靜靜地拿到錯的那一筆，
      // 錨定的 overlay 也會跟錯片段。
      if (seen.has(c.id)) return { ok: false, error: `duplicate clip id: ${c.id}` };
      seen.add(c.id);
    }
  }
  return ok(
    store.mutate(source, 'set timeline', (d) => {
      d.tracks.video = cmd.clips.map((c) => ({
        id: c.id ?? nanoid(6),
        mediaId: c.mediaId,
        in: c.in,
        duration: c.duration,
        volume: c.volume ?? 1,
        ...(c.label ? { label: c.label } : {}),
        ...(c.leadPad ? { leadPad: c.leadPad } : {}),
        ...(c.meta ? { meta: c.meta } : {}),
      }));
    }),
  );
}

/**
 * 驗證單一 overlay 的 text 規格是否合法、且已由 resolveTextCommand 前置填好 imagePath。
 * addOverlay／updateOverlay／setOverlays 三處共用同一套規則與錯誤訊息——這是命令層的
 * 安全邊界：即使呼叫端（例如某個 MCP 工具）忘了跑前置，text 換了但 imagePath 沒填的
 * overlay 也不會被 mutate 進文件（空字串 imagePath 到 render 時會被當成專案目錄本身餵給
 * ffmpeg，錯誤會出現在很遠的地方且難以理解）。
 */
function validateOverlayTextCard(
  text: OverlayText,
  imagePath: string | undefined,
  canvasWidth: number,
): string | null {
  if (text.text.trim() === '') return 'overlay text must not be empty';
  if (text.fontSize <= 0) return 'fontSize must be > 0';
  // 像素預算要先於 imagePath 檢查：超出預算時 resolveTextCommand 會刻意不產卡，
  // imagePath 因此還是空的——先檢查 imagePath 會回一句誤導的「(server error)」，
  // 而真正的原因是這張卡太大。順序決定使用者看到哪一句。
  const budgetErr = cardRequestError(overlayTextToCardRequest(text, canvasWidth));
  if (budgetErr) return `overlay text card rejected: ${budgetErr}`;
  if (imagePath === undefined || imagePath === '') {
    return 'text overlay card not generated (server error)';
  }
  return null;
}

/** 字幕的字卡也吃同一份像素預算（cardSync 會拿它去產卡）。回 null 代表可以寫進文件。 */
function validateCaptionCard(cap: CaptionItem, canvasWidth: number): string | null {
  const err = cardRequestError(capToCardRequest(cap, canvasWidth));
  return err ? `caption ${cap.id} rejected: ${err}` : null;
}

function addOverlay(
  store: ProjectStore,
  source: MutationSource,
  cmd: Extract<Command, { name: 'addOverlay' }>,
): CommandResult {
  const o = cmd.overlay;
  if (store.doc.tracks.overlays.some((x) => x.id === o.id)) {
    return { ok: false, error: `overlay id already exists: ${o.id}` };
  }
  if (o.duration !== null && o.duration <= 0) {
    return { ok: false, error: 'overlay duration must be > 0 or null' };
  }
  if (o.anchor === undefined && o.start === undefined) {
    return { ok: false, error: 'overlay needs start or anchor' };
  }
  if (o.anchor && !store.doc.tracks.video.some((c) => c.id === o.anchor!.clipId)) {
    return { ok: false, error: `anchor clip not found: ${o.anchor.clipId}` };
  }
  if (o.text) {
    const textErr = validateOverlayTextCard(o.text, o.imagePath, store.doc.canvas.width);
    if (textErr) return { ok: false, error: textErr };
  }
  return ok(
    store.mutate(source, `add overlay ${o.imagePath.split('/').pop()}`, (d) => {
      d.tracks.overlays.push(o);
    }),
  );
}

function updateOverlay(
  store: ProjectStore,
  source: MutationSource,
  cmd: Extract<Command, { name: 'updateOverlay' }>,
): CommandResult {
  const target = store.doc.tracks.overlays.find((o) => o.id === cmd.id);
  if (!target) {
    return { ok: false, error: `overlay not found: ${cmd.id}` };
  }
  if (cmd.patch.duration !== undefined && cmd.patch.duration !== null && cmd.patch.duration <= 0) {
    return { ok: false, error: 'overlay duration must be > 0 or null' };
  }
  if (cmd.patch.anchor !== undefined) {
    if (!store.doc.tracks.video.some((c) => c.id === cmd.patch.anchor!.clipId)) {
      return { ok: false, error: `anchor clip not found: ${cmd.patch.anchor.clipId}` };
    }
    if (cmd.patch.start !== undefined) {
      return { ok: false, error: 'start and anchor are mutually exclusive' };
    }
  }
  if (cmd.patch.text) {
    // 只有「本來就是文字 overlay」（已有 text 欄位）才能用 patch.text 改字。
    // 對純圖 overlay（例如外部腳本產的排名徽章 assets/rank_ov_0.png）送 text，
    // 以前會靜默把它變成一張產生出來的文字卡、覆蓋掉使用者的 imagePath——
    // 一次無心的呼叫就毀掉素材參照，只能靠 undo 救。要轉型請 removeOverlay + addOverlay。
    if (!target.text) {
      return {
        ok: false,
        error:
          `overlay ${cmd.id} is not a text overlay (no text field); ` +
          'refusing to convert an image overlay into a text card. ' +
          'Use removeOverlay + addOverlay if conversion is really intended.',
      };
    }
    // patch.text 一定要伴隨一個已 resolve 的 imagePath——沒有這個鍵（呼叫端跳過了
    // resolveTextCommand 這道前置）跟給空字串一樣危險：都會讓 text 换了、imagePath
    // 還指著舊卡，畫面與文字對不上。兩種情況都要擋。
    const textErr = validateOverlayTextCard(
      cmd.patch.text,
      cmd.patch.imagePath,
      store.doc.canvas.width,
    );
    if (textErr) return { ok: false, error: textErr };
  }
  return ok(
    store.mutate(source, `edit overlay`, (d) => {
      const o = d.tracks.overlays.find((x) => x.id === cmd.id)!;
      // start／anchor 互斥：兩種定位不能同時存在（overlayWindow 會偏袒 anchor，
      // 留著會出現「設了 start 看似成功實際無效」的隱性陷阱）
      if (cmd.patch.start !== undefined) {
        o.start = cmd.patch.start;
        delete o.anchor;
      }
      if (cmd.patch.anchor !== undefined) {
        o.anchor = cmd.patch.anchor;
        delete o.start;
      }
      if (cmd.patch.duration !== undefined) o.duration = cmd.patch.duration;
      if (cmd.patch.position !== undefined) o.position = cmd.patch.position;
      if (cmd.patch.text !== undefined) o.text = cmd.patch.text;
      if (cmd.patch.imagePath !== undefined) o.imagePath = cmd.patch.imagePath;
    }),
  );
}

/** 整組替換 overlay 軌：逐一驗證每個 overlay 的 text/imagePath（見 validateOverlayTextCard），
 * 任一項不合格就整批拒絕、文件完全不動。**但這只是 addOverlay 那套規則的一部分**——
 * setOverlays 沒有驗 addOverlay 另外驗的四件事：①「既無 start 也無 anchor」
 * ②「anchor.clipId 指向不存在的片段」③「duration <= 0」④「同一批裡 id 重複」。
 * 四種寫壞的 overlay 目前都會靜默落盤、`overlayWindow()` 回 null，預覽與成品都不顯示，
 * 而這個工具回的是成功。`mcp.ts` 的 `set_overlays` 工具描述已如實寫出這個落差；
 * 補齊驗證（`overlayRuleError`）屬行為變更，留在 `docs/ROADMAP.md`「MCP 面補完分支」一節
 * （DOC-AUDIT 的 F1）給專案擁有者裁決。 */
function setOverlays(
  store: ProjectStore,
  source: MutationSource,
  cmd: Extract<Command, { name: 'setOverlays' }>,
): CommandResult {
  for (const o of cmd.overlays) {
    if (o.text) {
      const textErr = validateOverlayTextCard(o.text, o.imagePath, store.doc.canvas.width);
      if (textErr) return { ok: false, error: textErr };
    }
  }
  return ok(
    store.mutate(source, 'set overlays', (d) => {
      d.tracks.overlays = cmd.overlays as OverlayItem[];
    }),
  );
}

function updateCaption(
  store: ProjectStore,
  source: MutationSource,
  cmd: Extract<Command, { name: 'updateCaption' }>,
): CommandResult {
  const cur = store.doc.tracks.captions.find((c) => c.id === cmd.id);
  if (!cur) {
    return { ok: false, error: `caption not found: ${cmd.id}` };
  }
  // 改完之後的樣子要滿足跟 setCaptions 同一份規則（見 captionRuleError）。
  const ruleErr = captionRuleError(merge<CaptionItem>(cur, cmd.patch));
  if (ruleErr) return { ok: false, error: `caption ${cmd.id}: ${ruleErr}` };
  // 會影響字卡外觀的三個欄位任一有動，就用「改完後的樣子」跑一次像素預算
  // （cardSync 之後就是拿文件裡的這一句去產卡）。start/duration 不影響排版，不必驗。
  if (cmd.patch.text !== undefined || cmd.patch.style !== undefined || cmd.patch.tokens) {
    const next: CaptionItem = {
      ...cur,
      ...(cmd.patch.text !== undefined ? { text: cmd.patch.text } : {}),
      ...(cmd.patch.style !== undefined ? { style: cmd.patch.style } : {}),
      ...(cmd.patch.tokens?.length ? { tokens: cmd.patch.tokens } : {}),
    };
    const err = validateCaptionCard(next, store.doc.canvas.width);
    if (err) return { ok: false, error: err };
  }

  // 平移（drag）與修邊（trim）的判別，決定 tokens 要不要跟著動。
  //
  // tokens 存的是**時間軸絕對秒數**（見 shared 的 CaptionToken），不是相對句首的偏移，
  // 所以整句被拖到別的時間點時，每個詞的時刻都必須跟著移同樣的量；不移的話預覽依新
  // start 顯示、匯出的逐詞字卡卻還在舊時間出現，兩邊差整整一個 delta。
  //
  // 但「start 變了」不等於「整句被拖走了」。時間軸字幕卡的左把手是 **trim-in**：
  // 右緣釘住不動，start 往後、duration 等量變短（Timeline.tsx 的 edge:'in' 送
  // {start, duration}）。那是在改「這句顯示多久」，沒有任何一個字被唸出來的時刻改變——
  // 跟著平移反而會把整條 karaoke 從語音上扯開（實測 start 10→10.5 / duration 3→2.5 會把
  // 詞推到 10.7–13.3，最後一個詞的 end 13.3 已經超出這句的 end 13，render.ts 的
  // renderCaptionCards 會把它的視窗夾掉一半高亮）。右把手 trim-out 只送 duration，
  // 本來就不會走到這裡；但左把手證明了「只看 start」是不夠的。
  //
  // 判別規則：**兩端位移相同才算平移**（Δend == Δstart）。因為
  // Δend − Δstart = Δduration，等價於「duration 沒變」——用 duration 相等來判斷，
  // 而不是實際去減 (start+duration)，可避免浮點誤差把純平移誤判成微幅修邊。
  //   拖曳   {start:+d, duration:不變}        → Δduration = 0 → 平移，tokens 跟著動
  //   trim-in {start:+d, duration:−d}         → Δduration ≠ 0 → 修邊，tokens 不動
  //   trim-out {duration:−d}                  → 沒給 start   → 修邊，tokens 不動
  const nextDuration = cmd.patch.duration ?? cur.duration;
  const delta = cmd.patch.start !== undefined ? cmd.patch.start - cur.start : 0;
  const isTranslation = delta !== 0 && nextDuration === cur.duration;

  return ok(
    store.mutate(source, `edit caption`, (d) => {
      const c = d.tracks.captions.find((x) => x.id === cmd.id)!;
      if (cmd.patch.text !== undefined) c.text = cmd.patch.text;
      if (cmd.patch.start !== undefined) c.start = cmd.patch.start;
      if (cmd.patch.duration !== undefined) c.duration = cmd.patch.duration;
      if (cmd.patch.style !== undefined) c.style = cmd.patch.style;
      if (cmd.patch.tokens !== undefined) {
        // 空陣列＝清除逐詞時間戳。JSON 傳不了 undefined（鍵會整個消失），
        // 所以「清除」必須有一個能被序列化的表示法。
        // 呼叫端明確給的 tokens 就是最終答案，下面的平移必須跳過它
        //（否則同一次呼叫又給 tokens 又改 start 會位移兩倍）。
        if (cmd.patch.tokens.length === 0) delete c.tokens;
        else c.tokens = cmd.patch.tokens;
      } else if (isTranslation && c.tokens) {
        for (const t of c.tokens) {
          t.start += delta;
          t.end += delta;
        }
      }
    }),
  );
}

/**
 * 在時間軸絕對時間切開片段（playhead 分割）。切點須嚴格落在片段內部。
 *
 * 有 leadPad 時，切點還不能落在黑墊內——左半若切在黑墊內會變成一支「沒有內容」的
 * clip（純黑墊，不合法，見 VideoClip.leadPad 的裁決）。無 leadPad（pad=0）時
 * `offset < leadPad + MIN` 就是 `offset < MIN`，與舊式子逐位元組相同。
 */
function splitAt(store: ProjectStore, source: MutationSource, time: number): CommandResult {
  const clips = store.doc.tracks.video;
  const hit = clipAt(clips, time);
  if (!hit) return { ok: false, error: `no clip at ${time}s` };
  const clip = clips[hit.index]!;
  const pad = clip.leadPad ?? 0;
  const left = hit.offset;
  const right = clip.duration - hit.offset;
  if (left < pad + MIN_CLIP_DURATION) {
    return { ok: false, error: `split point is inside the black lead (${left}s < ${pad}s pad)` };
  }
  if (right < MIN_CLIP_DURATION) {
    return { ok: false, error: `split point too close to clip edge (${left}s / ${right}s)` };
  }
  return ok(
    store.mutate(source, `split ${clip.label ?? clip.id}`, (d) => {
      const c = d.tracks.video[hit.index]!;
      // 左半：保留原本的黑墊（在切點之前，切點必然已經過了黑墊）；
      // 右半：黑墊清 0——它從「原 clip 黑墊結束後」的來源時間接著畫，沒有自己的黑墊。
      // 無 leadPad 時 `delete second.leadPad` 是 no-op（本來就沒有這個鍵），逐位元組不變。
      const second: VideoClip = {
        ...c,
        id: nanoid(6),
        in: c.in + (left - pad),
        duration: right,
      };
      delete second.leadPad;
      c.duration = left;
      d.tracks.video.splice(hit.index + 1, 0, second);
    }),
  );
}

/**
 * 刪除 playhead 一側的畫面（CapCut 的 Q / W）。磁性主軌自動閉合。
 * 只影響影片主軌；overlay/字幕/音訊不動（與 CapCut 同語意）。
 *
 * leadPad 語意（無 leadPad 的 clip 全部落在「切點在內容」分支，式子與舊版逐位元組相同）：
 * - deleteBefore 切點落在黑墊內：只削黑墊本身（`leadPad -= cut`、`duration -= cut`），
 *   內容完全不動（in 不變）——切掉的是「還沒開始的黑」，不是內容。
 * - deleteBefore 切點落在內容內：黑墊整段被切掉（黑墊在內容之前），`leadPad = 0`，
 *   來源起點用 `clipSourceTime` 映射（不是手算 `in + cut`）。殘餘長度改用**內容**殘餘
 *   跟 MIN_CLIP_DURATION 比。
 * - deleteAfter 切點落在黑墊內：左半只剩黑墊、沒有任何內容——整支必須刪掉
 *   （無內容 clip 不合法）。
 * - deleteAfter 切點落在內容內：`duration` 截斷到切點，`leadPad` 保留不變，
 *   內容殘餘（`rest − pad`）< MIN 就整支刪。
 */
function deleteSide(
  store: ProjectStore,
  source: MutationSource,
  time: number,
  side: 'before' | 'after',
): CommandResult {
  const clips = store.doc.tracks.video;
  const total = totalDuration(store.doc);
  if (clips.length === 0) return { ok: false, error: 'timeline is empty' };
  if (side === 'before' && time <= 0) return { ok: false, error: 'nothing before 0' };
  if (side === 'after' && time >= total) return { ok: false, error: 'nothing after the end' };
  if (side === 'before' && time >= total) return { ok: false, error: 'would delete everything' };
  if (side === 'after' && time <= 0) return { ok: false, error: 'would delete everything' };

  const starts = startsOf(clips);
  const kept: VideoClip[] = [];
  clips.forEach((c, i) => {
    const s = starts[i]!;
    const e = s + c.duration;
    const pad = c.leadPad ?? 0;
    if (side === 'before') {
      if (e <= time) return; // 整段在左側 → 丟掉
      if (s < time) {
        const cut = time - s; // 片段被切掉的前半（clip 內偏移）
        if (cut < pad) {
          // 切點在黑墊內：只削黑墊，內容完全不動。
          const nextPad = pad - cut;
          const nextDur = c.duration - cut;
          kept.push({ ...c, duration: nextDur, ...(nextPad > 0 ? { leadPad: nextPad } : {}) });
          return;
        }
        // 切點在內容內：黑墊整段被切掉（黑墊必然在內容之前）。
        const nextIn = clipSourceTime(c, cut)!; // cut >= pad，必定有值
        const nextDur = c.duration - cut; // leadPad 歸零後 duration === 內容長度
        if (nextDur < MIN_CLIP_DURATION) return;
        const next = { ...c, in: nextIn, duration: nextDur };
        delete next.leadPad;
        kept.push(next);
        return;
      }
      kept.push(c);
    } else {
      if (s >= time) return; // 整段在右側 → 丟掉
      if (e > time) {
        const rest = time - s; // 保留到切點的長度（clip 內偏移，含黑墊）
        if (rest <= pad) return; // 切點在黑墊內：左半沒有任何內容 → 整支刪
        const contentRest = rest - pad;
        if (contentRest < MIN_CLIP_DURATION) return;
        kept.push({ ...c, duration: rest }); // leadPad 不變：黑墊仍在開頭，內容被截短
        return;
      }
      kept.push(c);
    }
  });
  if (kept.length === 0) return { ok: false, error: 'would delete everything' };
  return ok(
    store.mutate(
      source,
      side === 'before' ? 'delete before playhead' : 'delete after playhead',
      (d) => {
        d.tracks.video = kept;
      },
    ),
  );
}

/**
 * 在 time 處插入一段定格幀（畫面凍結，渲染時抽單幀成靜圖）。
 * time 落在黑墊內 → 拒絕（黑墊沒有對應的來源畫面可以凍結，措辭同 splitAt）。
 *
 * 終審 Important-1：只擋「切點在黑墊內」（`atSource === null`）還不夠——中段分支會把
 * 左半保留原 `leadPad`、`duration` 設成 `hit.offset`，若 `hit.offset` 落在
 * `[pad, pad+MIN)`，左半內容長 `hit.offset - pad` 會 < MIN_CLIP_DURATION（甚至為 0，
 * 純黑墊、零內容），卻沒有守門擋下——之後任何 updateClip 都會被 :567 的內容長驗證
 * 擋下，變成改不動的死 clip。修法：把「貼在開頭、不切」分支的進入條件從
 * `hit.offset < MIN` 擴充成 `hit.offset < pad + MIN`——語意上也合理，左半內容還沒
 * 累積到 MIN，定格就該插在整支片段之前，不留下一個近乎空的左半。
 * 無 leadPad（pad=0）時 `pad + MIN === MIN`，與舊式子逐位元組相同。
 */
function freezeFrame(
  store: ProjectStore,
  source: MutationSource,
  time: number,
  duration: number,
): CommandResult {
  if (duration < MIN_CLIP_DURATION) return { ok: false, error: 'freeze duration too short' };
  const clips = store.doc.tracks.video;
  const hit = clipAt(clips, time);
  if (!hit) return { ok: false, error: `no clip at ${time}s` };
  const clip = clips[hit.index]!;
  const pad = clip.leadPad ?? 0;
  const atSource = clipSourceTime(clip, hit.offset); // 要凍結的來源時間點
  if (atSource === null) {
    return {
      ok: false,
      error: `freeze point is inside the black lead (${hit.offset}s < ${pad}s pad)`,
    };
  }

  return ok(
    store.mutate(source, `freeze frame @${time.toFixed(2)}s`, (d) => {
      const frozen: VideoClip = {
        id: nanoid(6),
        mediaId: clip.mediaId,
        in: atSource,
        duration,
        volume: 0, // 定格段無聲
        frozen: true,
        label: `❄ ${clip.label ?? clip.id}`,
      };
      const c = d.tracks.video[hit.index]!;
      if (hit.offset < pad + MIN_CLIP_DURATION) {
        // 貼在片段開頭 → 直接插在它前面，不切。含黑墊情形：左半內容還不到 MIN
        // （終審 Important-1），與其產生一支近乎空的左半，不如視同「內容還沒開始」。
        d.tracks.video.splice(hit.index, 0, frozen);
      } else if (clip.duration - hit.offset < MIN_CLIP_DURATION) {
        // 貼在片段結尾 → 插在它後面
        d.tracks.video.splice(hit.index + 1, 0, frozen);
      } else {
        // 中間 → 切成兩段，定格插在中間。黑墊（若有）整段留在前半——同 splitAt，
        // 後半的來源起點用 clipSourceTime 映射、leadPad 清 0。左半內容長已由上面的
        // `hit.offset < pad + MIN` 分支排除過短情形，這裡必定 ≥ MIN。
        const second: VideoClip = {
          ...clip,
          id: nanoid(6),
          in: atSource,
          duration: clip.duration - hit.offset,
        };
        delete second.leadPad;
        c.duration = hit.offset;
        d.tracks.video.splice(hit.index + 1, 0, frozen, second);
      }
    }),
  );
}

/**
 * 把片段的聲音抽成獨立音訊項（片段轉靜音），之後可單獨調音量/淡化/刪除。
 * 音訊項用絕對時間，抽出後不跟隨片段搬動（與 CapCut 同語意）。
 *
 * 黑墊段本來就無聲，不屬於抽出範圍：`start` 往後移 `leadPad`、`duration` 用內容長度
 * （`clipContentDuration`）——無 leadPad 時 `leadPad=0`，兩者都與舊式子逐位元組相同。
 */
function extractAudio(store: ProjectStore, source: MutationSource, clipId: string): CommandResult {
  const clips = store.doc.tracks.video;
  const index = clips.findIndex((c) => c.id === clipId);
  if (index === -1) return { ok: false, error: `clip not found: ${clipId}` };
  const clip = clips[index]!;
  const media = store.doc.media.find((m) => m.id === clip.mediaId);
  if (!media) return { ok: false, error: `media not found: ${clip.mediaId}` };
  if (!media.probe.hasAudio) return { ok: false, error: 'clip has no audio to extract' };
  const clipStart = startsOf(clips)[index]!;
  const pad = clip.leadPad ?? 0;

  return ok(
    store.mutate(source, `extract audio from ${clip.label ?? clip.id}`, (d) => {
      d.tracks.audio.push({
        id: nanoid(6),
        mediaId: clip.mediaId,
        start: clipStart + pad,
        in: clip.in,
        duration: clipContentDuration(clip),
        volume: clip.volume || 1,
        label: `🔊 ${clip.label ?? clip.id}`,
      });
      d.tracks.video[index]!.volume = 0;
    }),
  );
}

function updateAudio(
  store: ProjectStore,
  source: MutationSource,
  cmd: Extract<Command, { name: 'updateAudio' }>,
): CommandResult {
  const item = store.doc.tracks.audio.find((a) => a.id === cmd.id);
  if (!item) return { ok: false, error: `audio not found: ${cmd.id}` };
  const media = store.doc.media.find((m) => m.id === item.mediaId);
  // 用「改完之後的樣子」跑規則，跟 setAudio 是同一份（見 audioRuleError）。
  // 這樣既有欄位與 patch 欄位的交互（例如只縮短 duration 卻讓既有的 fadeOut 超出）
  // 也會被涵蓋——分開寫的版本只驗 patch 帶到的那幾個欄位。
  const ruleErr = audioRuleError(merge<AudioItem>(item, cmd.patch), media);
  if (ruleErr) return { ok: false, error: ruleErr };
  return ok(
    store.mutate(source, `edit audio ${item.label ?? item.id}`, (d) => {
      Object.assign(
        d.tracks.audio.find((a) => a.id === cmd.id)!,
        cmd.patch,
      );
    }),
  );
}
