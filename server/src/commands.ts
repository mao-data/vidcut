import { nanoid } from 'nanoid';
import type {
  AudioItem,
  Command,
  CommandResult,
  MutationSource,
  OverlayItem,
  OverlayText,
  CaptionItem,
  VideoClip,
} from '@vidcut/shared';
import { totalDuration } from '@vidcut/shared';
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
      // 整批中任一句的字卡超出像素預算就整批拒絕、文件完全不動：cardSync 之後會拿
      // 文件裡的每一句去產卡，讓它落盤等於把一顆定時炸彈存進專案（每次載入都會再試一次）。
      for (const cap of cmd.captions) {
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
    case 'setAudio':
      return ok(
        store.mutate(source, 'set audio', (d) => {
          d.tracks.audio = cmd.audio as AudioItem[];
        }),
      );
    case 'setCanvasFit':
      return ok(
        store.mutate(source, `canvas fit: ${cmd.fit}`, (d) => {
          d.canvas.fit = cmd.fit;
        }),
      );
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

function ok(r: { version: number }): CommandResult {
  return { ok: true, version: r.version };
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
  if (nextIn < 0) return { ok: false, error: 'in must be >= 0' };
  if (nextDur < MIN_CLIP_DURATION)
    return { ok: false, error: `duration must be >= ${MIN_CLIP_DURATION}` };
  if (nextIn + nextDur > srcDur + 1e-6) {
    return { ok: false, error: `in+duration (${nextIn + nextDur}) exceeds source ${srcDur}` };
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
 * 任一項不合格就整批拒絕、文件完全不動——這是 setOverlays 的安全邊界，跟
 * addOverlay/updateOverlay 用同一套規則，不因為是「整組替換」就放寬。 */
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
  if (cmd.patch.duration !== undefined && cmd.patch.duration <= 0) {
    return { ok: false, error: 'caption duration must be > 0' };
  }
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

/** 在時間軸絕對時間切開片段（playhead 分割）。切點須嚴格落在片段內部。 */
function splitAt(store: ProjectStore, source: MutationSource, time: number): CommandResult {
  const clips = store.doc.tracks.video;
  const hit = clipAt(clips, time);
  if (!hit) return { ok: false, error: `no clip at ${time}s` };
  const clip = clips[hit.index]!;
  const left = hit.offset;
  const right = clip.duration - hit.offset;
  if (left < MIN_CLIP_DURATION || right < MIN_CLIP_DURATION) {
    return { ok: false, error: `split point too close to clip edge (${left}s / ${right}s)` };
  }
  return ok(
    store.mutate(source, `split ${clip.label ?? clip.id}`, (d) => {
      const c = d.tracks.video[hit.index]!;
      const second: VideoClip = {
        ...c,
        id: nanoid(6),
        in: c.in + left,
        duration: right,
      };
      c.duration = left;
      d.tracks.video.splice(hit.index + 1, 0, second);
    }),
  );
}

/**
 * 刪除 playhead 一側的畫面（CapCut 的 Q / W）。磁性主軌自動閉合。
 * 只影響影片主軌；overlay/字幕/音訊不動（與 CapCut 同語意）。
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
    if (side === 'before') {
      if (e <= time) return; // 整段在左側 → 丟掉
      if (s < time) {
        const cut = time - s; // 片段被切掉的前半
        const rest = c.duration - cut;
        if (rest < MIN_CLIP_DURATION) return;
        kept.push({ ...c, in: c.in + cut, duration: rest });
        return;
      }
      kept.push(c);
    } else {
      if (s >= time) return; // 整段在右側 → 丟掉
      if (e > time) {
        const rest = time - s;
        if (rest < MIN_CLIP_DURATION) return;
        kept.push({ ...c, duration: rest });
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

/** 在 time 處插入一段定格幀（畫面凍結，渲染時抽單幀成靜圖）。 */
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
  const atSource = clip.in + hit.offset; // 要凍結的來源時間點

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
      if (hit.offset < MIN_CLIP_DURATION) {
        // 貼在片段開頭 → 直接插在它前面，不切
        d.tracks.video.splice(hit.index, 0, frozen);
      } else if (clip.duration - hit.offset < MIN_CLIP_DURATION) {
        // 貼在片段結尾 → 插在它後面
        d.tracks.video.splice(hit.index + 1, 0, frozen);
      } else {
        // 中間 → 切成兩段，定格插在中間
        const second: VideoClip = {
          ...clip,
          id: nanoid(6),
          in: clip.in + hit.offset,
          duration: clip.duration - hit.offset,
        };
        c.duration = hit.offset;
        d.tracks.video.splice(hit.index + 1, 0, frozen, second);
      }
    }),
  );
}

/**
 * 把片段的聲音抽成獨立音訊項（片段轉靜音），之後可單獨調音量/淡化/刪除。
 * 音訊項用絕對時間，抽出後不跟隨片段搬動（與 CapCut 同語意）。
 */
function extractAudio(store: ProjectStore, source: MutationSource, clipId: string): CommandResult {
  const clips = store.doc.tracks.video;
  const index = clips.findIndex((c) => c.id === clipId);
  if (index === -1) return { ok: false, error: `clip not found: ${clipId}` };
  const clip = clips[index]!;
  const media = store.doc.media.find((m) => m.id === clip.mediaId);
  if (!media) return { ok: false, error: `media not found: ${clip.mediaId}` };
  if (!media.probe.hasAudio) return { ok: false, error: 'clip has no audio to extract' };
  const start = startsOf(clips)[index]!;

  return ok(
    store.mutate(source, `extract audio from ${clip.label ?? clip.id}`, (d) => {
      d.tracks.audio.push({
        id: nanoid(6),
        mediaId: clip.mediaId,
        start,
        in: clip.in,
        duration: clip.duration,
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
  const nextIn = cmd.patch.in ?? item.in;
  const nextDur = cmd.patch.duration ?? item.duration;
  if (nextIn < 0) return { ok: false, error: 'in must be >= 0' };
  if (nextDur <= 0) return { ok: false, error: 'duration must be > 0' };
  if (media && nextIn + nextDur > media.probe.duration + 1e-6) {
    return { ok: false, error: `in+duration exceeds source ${media.probe.duration}` };
  }
  if (cmd.patch.start !== undefined && cmd.patch.start < 0) {
    return { ok: false, error: 'start must be >= 0' };
  }
  if (cmd.patch.volume !== undefined && (cmd.patch.volume < 0 || cmd.patch.volume > 2)) {
    return { ok: false, error: 'volume must be within 0..2' };
  }
  for (const k of ['fadeIn', 'fadeOut'] as const) {
    const v = cmd.patch[k];
    if (v !== undefined && (v < 0 || v > nextDur)) {
      return { ok: false, error: `${k} must be within 0..duration` };
    }
  }
  return ok(
    store.mutate(source, `edit audio ${item.label ?? item.id}`, (d) => {
      Object.assign(
        d.tracks.audio.find((a) => a.id === cmd.id)!,
        cmd.patch,
      );
    }),
  );
}
