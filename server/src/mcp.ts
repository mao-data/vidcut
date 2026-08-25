import { readFile } from 'node:fs/promises';
import { isAbsolute, basename, join } from 'node:path';
import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type {
  AudioItem,
  HistoryBrief,
  OverlayItem,
  CaptionItem,
  PublishInfo,
  PublishMeta,
  PublishPlatform,
} from '@vidcut/shared';
import {
  totalDuration,
  outputDuration,
  overlayWindow,
  buildCaptionPages,
  DEFAULT_CAPTION_STYLE,
} from '@vidcut/shared';
import { transcribe } from './asr.js';
import type { ProjectStore } from './store.js';
import type { EditorContext } from './editorContext.js';
import type { ReviewManager } from './reviews.js';
import type { TextCardService } from './textCards.js';
import type { LibraryStore } from './libraryStore.js';
import { addToLibrary, prepareFromLibrary, discardPrepared } from './libraryIngest.js';
import { CHAT_MAX_LEN, type ChatStore } from './chatStore.js';
import { aiWrite, isStale } from './aiWrite.js';
import { prepareMedia, enqueueDerivedStages } from './ingest.js';
import { extractFrame } from './frame.js';
import { renderCoverImage, render } from './render.js';
import { listSource } from './sourceFolder.js';
import { resolveMediaPath } from './paths.js';
import { resolveTextCommand } from './textOverlays.js';
import { CARD_LIMITS } from './cardBudget.js';
import { emitAgentActivity, nextCallId } from './agentActivity.js';
import { buildPublishPackage, UPLOAD_URLS } from './publish.js';

export interface McpDeps {
  store: ProjectStore;
  projectDir: string;
  editorContext: EditorContext;
  reviews: ReviewManager;
  /** 給 get_frame 組媒體 URL 用（如 http://127.0.0.1:3845） */
  baseUrl: string;
  /** add_overlay/update_overlay 帶 text 時用來產字卡（見 resolveTextCommand 前置） */
  textCards: TextCardService;
  /**
   * 與監修者的對話記錄（`post_chat` / `get_chat`）。**不是編輯路徑**——
   * 它不進 doc、不進版本/歷史/undo，見 `chatStore.ts` 檔頭。
   */
  chat: ChatStore;
  /** 跨專案素材庫（spec 2026-08-21）。索引損毀降級時為 undefined，素材庫工具回錯誤。 */
  library?: LibraryStore;
}

/** 應用層失敗：標 isError 讓模型能明確辨識（訊息本身與成功路徑同格式）。 */
function err(s: string) {
  return { content: [{ type: 'text' as const, text: s }], isError: true };
}

function result(structured: Record<string, unknown>, summary: string) {
  return { content: [{ type: 'text' as const, text: summary }], structuredContent: structured };
}

/**
 * 失敗但仍要把 structured payload 交回去。目前只有 auto_caption 用得到：辨識已經跑完
 * （分鐘級的 whisper），寫入才失敗——把算好的 captions 一起回去，呼叫端改用
 * set_captions 就好，不必再燒一次 whisper。但**一定要標 isError**：它以前走的是
 * `result()`，寫入失敗時回的是成功形狀，錯誤只藏在摘要文字的開頭，
 * 任何靠 isError 判斷的客戶端都會把它當成功。
 */
function errResult(structured: Record<string, unknown>, summary: string) {
  return { ...result(structured, summary), isError: true };
}

/**
 * 回覆內嵌 JPEG 影像 block。遠端 client（如 Claude Desktop）抓不到本機
 * 127.0.0.1 的 URL，畫面必須直接放進回覆；URL/路徑仍留在 structured 給本機 client。
 */
async function imageReply(absPath: string, structured: Record<string, unknown>, summary: string) {
  const data = (await readFile(absPath)).toString('base64');
  return {
    content: [
      { type: 'text' as const, text: summary },
      { type: 'image' as const, data, mimeType: 'image/jpeg' },
    ],
    structuredContent: structured,
  };
}

/**
 * 專案裁剪視圖（避免超過 client 輸出上限）。
 *
 * `total` 回報 outputDuration（Plan 13 裁決 7），不是主軌總長：任何軌道
 * （caption/audio/具體時長 overlay）延伸超出主軌都會撐大它，超出的區間在畫面上
 * 是黑尾（render.ts 用 tpad 補黑、frame.ts 對這段時間回黑幀，見 shared/src/timeline.ts
 * 的 outputDuration 文件）。跟主軌總長不同時，get_project 的文字摘要會帶一句附註
 * （見下方呼叫端），讓 AI 不必自己去算兩者的差。
 */
function projectSummary(store: ProjectStore) {
  const d = store.doc;
  return {
    version: store.version,
    name: d.name,
    canvas: d.canvas,
    total: outputDuration(d),
    review: d.review,
    media: d.media.map((m) => ({
      id: m.id,
      label: m.label,
      duration: m.probe.duration,
      hasAudio: m.probe.hasAudio,
    })),
    clips: d.tracks.video.map((c) => ({
      id: c.id,
      mediaId: c.mediaId,
      in: c.in,
      duration: c.duration,
      label: c.label,
      // 選填欄位無意義值（這裡是 leadPad===0，即「沒有黑墊」）不主動帶進摘要，
      // 免得每個 clip 都多一個恆為 0 的噪音欄位——只有真的有黑墊時才曝光。
      ...(c.leadPad ? { leadPad: c.leadPad } : {}),
    })),
    overlays: d.tracks.overlays.length,
    captions: d.tracks.captions.map((c) => ({
      id: c.id,
      text: c.text,
      start: c.start,
      duration: c.duration,
    })),
    audio: d.tracks.audio.length,
  };
}

/**
 * ---- 輸出 schema ----------------------------------------------------------
 *
 * 以前 31 個工具**一個都沒有** outputSchema，其中十幾個卻回 structuredContent——
 * client 拿不到形狀就無從驗證，模型也只能從回覆文字裡猜欄位名。
 *
 * 兩件事要記住：
 * 1. SDK 只在**非 isError** 的回覆上驗（見 validateToolOutput），所以 `err()` 那條路
 *    不受影響；但成功路徑一旦宣告就**必須**帶 structuredContent，否則直接 InvalidParams。
 *    這也是 writeReply／clipTrackReply 改成一律回 structuredContent 的原因。
 * 2. ⚠️ **宣告要完整，不能只列「保證有的欄位」**。伺服器端用 zod 驗（預設 strip，多的鍵
 *    不會失敗），但送給 client 的是轉出來的 JSON Schema，而那份帶著
 *    `additionalProperties: false`——client 會因為多出來的鍵**直接拒收整個回覆**。
 *    實測：probeOutput 漏宣告 `rotation` → `data/probe must NOT have additional properties`。
 *    不想逐欄列的地方用 `z.unknown()`（轉出來是無約束的 `{}`），不要用「少列幾個」。
 */

/** 所有寫入類工具的共同輸出。changed:false ＝ 命令合法但沒有任何欄位改變。 */
const writeOutput = {
  version: z.number().describe('version after the write'),
  changed: z.boolean().optional().describe('false = no-op; not a single field changed'),
};

/** 會動到主軌片段的工具：多回一份「這次弄斷了哪些錨點」。 */
const clipTrackOutput = {
  ...writeOutput,
  orphanedOverlays: z
    .array(z.string())
    .describe(
      'ids of overlays whose anchor points at a clip that no longer exists; they show up in neither the preview nor the export',
    ),
};

/** ProbeInfo 的完整鏡像——少一個欄位 client 就會拒收（見上面第 2 點）。 */
const probeOutput = z
  .object({
    duration: z.number(),
    width: z.number(),
    height: z.number(),
    fps: z.number(),
    hasAudio: z.boolean(),
    rotation: z.number(),
    hasVideo: z.boolean().optional().describe('false = audio-only media'),
    audioChannels: z.number().optional(),
    codec: z.string().optional(),
    pixFmt: z.string().optional(),
    container: z.string().optional(),
    keyframeIntervalSec: z.number().optional(),
  })
  .describe('ffprobe result');

const historyEntryOutput = z.object({
  version: z.number(),
  label: z.string(),
  source: z.enum(['ai', 'human']),
  ts: z.string(),
});

const captionTokenOutput = z.object({ text: z.string(), start: z.number(), end: z.number() });

const transcriptWordOutput = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
});

/**
 * `.strict()` 不是裝飾：zod 預設會**靜默丟掉**未知的鍵，所以
 * `patch: { start: 2 }`（clip 沒有 start 欄位，那是 overlay/caption 才有的）會被
 * 剝成空 patch → applyCommand 產生零個 immer patch → 工具回一句 `ok, version=<沒動>`。
 * 呼叫端得到的是「成功」，文件卻什麼都沒變，而且連個警告都沒有。
 * 本檔其餘的 patch/item schema（overlay、caption、audio）本來就都是 strict，
 * 只有 clip 與 audio 的 patch 漏掉——這裡補齊。
 */
const clipPatchSchema = z
  .object({
    in: z.number().optional(),
    duration: z.number().optional(),
    volume: z.number().min(0).max(2).optional(),
    label: z.string().optional(),
    leadPad: z
      .number()
      .optional()
      .describe(
        "Seconds of black, silent lead before the clip's content — duration is unchanged and already includes " +
          'it (content length = duration − leadPad); omit to leave the current value alone. Content must still be ' +
          '>= 0.1s and in + (duration − leadPad) must not exceed the source length.',
      ),
  })
  .strict();

const overlayTextSchema = z
  .object({
    text: z.string().min(1),
    fontFamily: z.string(),
    // 上限與 cardBudget 同源：字卡的高度＝行數×字級，兩者都會被像素預算擋下，
    // 但在 schema 就擋掉「明顯填錯」的值，錯誤訊息比走到命令層再回一句拒絕更早也更清楚。
    fontSize: z.number().positive().max(CARD_LIMITS.fontSizeMax),
    fill: z.string(),
    stroke: z.string().optional(),
    maxWidth: z
      .number()
      .min(CARD_LIMITS.maxWidthFracMin)
      .max(CARD_LIMITS.maxWidthFracMax)
      .optional()
      .describe(
        'Auto-wrap width, as a fraction of the canvas width (0.1–1); default 0.9. ' +
          'Text past this width **wraps automatically**: CJK breaks per character, Latin breaks at spaces (never ' +
          'inside a word), and a literal \\n in the string always forces a break; a single unbreakable run (a URL, ' +
          'say) is hard-split per character. ' +
          'Smaller = narrower and more lines, so the card gets taller (a card is always full canvas width; its ' +
          'height grows with the line count). ' +
          "⚠️ Line count feeds the card's pixel budget, and this side cannot measure glyph widths, so it can only " +
          'take an upper bound (the tighter of "every character on its own line" and "every character at most 3 em ' +
          'wide") — which means very long text may be rejected (the error states the estimated size); shorten the ' +
          'text or reduce fontSize.',
      ),
  })
  .strict();

const overlaySchema = z
  .object({
    id: z.string(),
    imagePath: z
      .string()
      .optional()
      .describe(
        'image overlays only: the path of a PNG produced elsewhere. Do not set it for text overlays (see text).',
      ),
    text: overlayTextSchema
      .optional()
      .describe(
        'An editable text overlay: the server rasterizes the card and fills in imagePath, and later wording changes ' +
          'are just a new text. Give exactly one of text and imagePath — with text, omit imagePath (anything you ' +
          'send is replaced by the path the server computes); with imagePath it is an image overlay (a PNG produced ' +
          'elsewhere, whose text is not editable).',
      ),
    anchor: z.object({ clipId: z.string(), offset: z.number() }).optional(),
    start: z.number().optional(),
    duration: z.number().nullable(),
    position: z
      .object({ x: z.number(), y: z.number(), scale: z.number() })
      .describe(
        "Relative to the canvas. Note the asymmetry: x is the image's **horizontal centre**, y is its **top edge**. " +
          'A full-bleed vertical image wants {x:0.5, y:0, scale:1} (y:0.5 would push it off the bottom half). ' +
          'x/y are not limited to 0–1: an overlay may hang partly off the canvas (negative y = off the top edge), ' +
          'and the part that hangs off is clipped identically in export and preview. Only finiteness is validated, ' +
          'not range, so extreme values simply make the element invisible. ' +
          'Dragging in the UI is clamped to "the centre stays on canvas" = at most half off each side. ' +
          "scale is a multiplier (1 = the image's native size) applied about the top-centre point, so the x/y anchor " +
          'stays put, and export and preview scale identically. ' +
          'scale is limited to 0–10: negative values are rejected (the preview would mirror while the export would ' +
          'drop the image entirely — a real preview-vs-export split), and huge values blow up memory in ffmpeg. ' +
          'scale=0 is still accepted (invisible in both).',
      ),
  })
  .strict()
  // text 與 imagePath 恰好給一個。以前 imagePath 必填、文字 overlay 得傳空字串佔位，
  // 但那個空字串正是 commands.ts 的 validateOverlayTextCard 視為「前置沒跑」的毒藥哨兵
  // ——文件教人傳的值等於驗證層視為致命錯誤的值，只靠 resolveTextCommand 夾在中間換掉才安全。
  // 現在改成省略，並把「兩個都給/都不給」變成明確錯誤（以前是靜默丟棄呼叫端給的路徑）。
  .superRefine((o, ctx) => {
    if (o.text) {
      if (o.imagePath !== undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['imagePath'],
          message:
            'Do not set imagePath on a text overlay — the server fills it in after rasterizing the card. ' +
            '(The old interface wanted an empty-string placeholder; now omit the field entirely.)',
        });
    } else if (o.imagePath === undefined || o.imagePath === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['imagePath'],
        message:
          'Give either text (a text overlay, rasterized by the server) or a non-empty imagePath (an image overlay).',
      });
    }
  });

/**
 * 收斂回儲存型別的必填 imagePath 形狀。文字 overlay 這裡先填空字串佔位，由
 * resolveTextCommand 前置覆寫成真正的字卡路徑；萬一前置沒跑，commands.ts 的
 * validateOverlayTextCard 會擋下空字串（空路徑到 render 會變成把專案目錄餵給 ffmpeg）。
 */
function toOverlayItem(o: z.infer<typeof overlaySchema>): OverlayItem {
  return { ...o, imagePath: o.imagePath ?? '' } as OverlayItem;
}

const captionStyleSchema = z.object({
  fontFamily: z.string(),
  // 以前這裡完全沒有驗證：fontSize: 20000 會被寫進文件，之後每次 cardSync 都拿它去
  // 產一張幾 GB 的字卡（單一 worker 是序列化的，等於把字卡佇列鎖死）。
  fontSize: z.number().positive().max(CARD_LIMITS.fontSizeMax),
  fill: z.string(),
  stroke: z.string().optional(),
  y: z.number(),
  highlight: z
    .string()
    .optional()
    .describe(
      'per-word highlight colour: with tokens present, words already spoken are drawn in it',
    ),
});

const captionTokensSchema = z
  .array(z.object({ text: z.string(), start: z.number(), end: z.number() }))
  .describe(
    'per-word timestamps in absolute timeline seconds. When present, rendering does the karaoke per-word highlight.',
  );

const captionSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    start: z.number(),
    duration: z.number(),
    style: captionStyleSchema,
    tokens: captionTokensSchema.optional(),
  })
  .strict();

const audioSchema = z
  .object({
    id: z.string(),
    mediaId: z.string(),
    start: z.number(),
    in: z.number(),
    duration: z.number(),
    volume: z.number().min(0).max(2),
    fadeIn: z
      .number()
      .min(0)
      .optional()
      .describe("fade-in seconds; must not exceed this item's duration"),
    fadeOut: z
      .number()
      .min(0)
      .optional()
      .describe("fade-out seconds; must not exceed this item's duration"),
    ducking: z
      .boolean()
      .optional()
      .describe("true = duck the video's own audio to a quarter while this item plays"),
    label: z.string().optional(),
  })
  .strict();

const timelineClipSchema = z.object({
  id: z
    .string()
    .optional()
    .describe(
      'Passing an existing clipId means "this is still the same clip", so overlays anchored to it do not break; ' +
        'omitting it means a new clip and the server assigns a new id. When reordering the whole track, pass the ' +
        'original ids back to keep the anchors.',
    ),
  mediaId: z.string(),
  in: z.number(),
  duration: z.number(),
  label: z.string().optional(),
  volume: z.number().min(0).max(2).optional(),
  leadPad: z
    .number()
    .optional()
    .describe(
      "Seconds of black, silent lead before the clip's content — duration is unchanged and already includes it " +
        '(content length = duration − leadPad); omitting it means 0, same as every other field here (set_timeline ' +
        'is a whole-track replace, so it never carries an old value forward).',
    ),
  meta: z.record(z.unknown()).optional(),
});

/** transcribe 內嵌回傳的詞數上限：超過只回前段＋wordsTruncated，全量在 jsonPath 檔案裡。 */
const MAX_WORDS_INLINE = 1000;

/** list_source 內嵌回傳的檔案數上限：素材夾可能有上千支檔，整包回去會灌爆 AI 的 context。 */
const MAX_FILES_INLINE = 200;

/**
 * transcribe 內嵌回傳的整份逐字稿字元上限。`MAX_WORDS_INLINE` 以前只截 `words`，
 * 而 `text`（把所有詞接起來的那一整串）原封不動——一支長片的逐字稿可以是幾萬字，
 * 那道詞數上限等於被繞過去了。全量一樣在 jsonPath 的檔案裡。
 */
const MAX_TEXT_INLINE = 6000;

/**
 * auto_caption 內嵌回傳的字幕數上限。以前完全沒有上限：一支長片可以回幾百句，
 * 每句還帶著逐詞 tokens。寫入成功時文件裡就有全量（get_project 讀得到），
 * 寫入失敗時重跑一次就好——沒有理由把整包塞進回覆。
 */
const MAX_CAPTIONS_INLINE = 100;

/**
 * `changed === false` 要講出來。命令合法、也套用了，但一個欄位都沒動（version 因此
 * 停在原地）——以前這種情形回的字串跟真正改到東西時**一字不差**，模型沒有任何辦法
 * 察覺自己的編輯沒生效。不當成錯誤：送一個跟現值相同的 position 本來就是合法呼叫。
 */
function writeResultText(r: {
  ok: boolean;
  version?: number;
  error?: string;
  changed?: boolean;
}): string {
  if (!r.ok) return `error: ${r.error}`;
  return r.changed === false
    ? `ok (no-op: the command was valid but no field changed), version=${r.version}`
    : `ok, version=${r.version}`;
}

/**
 * 寫入類工具的統一回覆：成功帶 structuredContent、失敗回 isError。
 *
 * 成功時**一定要**有 structuredContent——宣告了 outputSchema 之後這是 SDK 的硬性要求
 * （見 validateToolOutput：非 isError 且沒有 structuredContent 直接丟 InvalidParams）。
 * 順帶讓 version 與 changed 變成**資料**而不是要從文字裡挖的字串。
 */
function writeReply(r: { ok: boolean; version?: number; error?: string; changed?: boolean }) {
  return r.ok
    ? result({ version: r.version, changed: r.changed ?? true }, writeResultText(r))
    : err(writeResultText(r));
}

/**
 * 錨點指向不存在 clip 的 overlay。`overlayWindow` 對這些回 null ＝**渲染整個跳過、
 * 預覽也不顯示**，而做這件事的工具本身是成功的，所以不講就沒有人會知道。
 *
 * 會弄斷錨點的操作：set_timeline（整組換掉，clip id 全新）、remove_clip、
 * timeline_op 的 deleteBefore/deleteAfter（磁性軌閉合時整段片段會消失）。
 * 實測同素材、同順序重送一次 set_timeline，4 個 overlay 就斷了 2 個。
 */
function orphanedAnchors(store: ProjectStore): string[] {
  return store.doc.tracks.overlays
    .filter((o) => o.anchor && !overlayWindow(store.doc, o))
    .map((o) => o.id);
}

/**
 * 會動到主軌片段的寫入工具的回覆：成功時附上「這次弄斷了哪些錨點」。
 *
 * **回報而不是拒絕**：整組重排在有錨點的專案上本來就是正當操作，擋掉等於讓
 * set_timeline 在任何上過圖的專案裡都不能用。但一定要說出來，否則使用者只會發現
 * 「有幾張圖不見了」而完全找不到原因。
 */
function clipTrackReply(
  store: ProjectStore,
  r: { ok: boolean; version?: number; error?: string; changed?: boolean },
) {
  if (!r.ok) return err(writeResultText(r));
  const orphaned = orphanedAnchors(store);
  // orphanedOverlays **一律**回傳（沒有就是空陣列）：宣告了 outputSchema 之後形狀不能
  // 時有時無，而「這次沒弄斷任何錨點」本身也是有用的資訊。
  const structured = { version: r.version, changed: r.changed ?? true, orphanedOverlays: orphaned };
  if (orphaned.length === 0) return result(structured, writeResultText(r));
  return result(
    structured,
    `${writeResultText(r)}\n⚠️ ${orphaned.length} overlay(s) anchor to a clip that no longer exists: ` +
      `${orphaned.join(', ')} — they show up in neither the preview nor the export. ` +
      'Point them at a new anchor with update_overlay, or switch them to an absolute start.',
  );
}

/** 建立註冊好全部工具的 McpServer（每個 HTTP 請求建一個，closure 共享 deps）。 */
export function createMcpServer(deps: McpDeps): McpServer {
  const { store, projectDir, editorContext, reviews, baseUrl, textCards, chat, library } = deps;
  const server = new McpServer(
    { name: 'vidcut', version: '0.1.0' },
    {
      instructions:
        'vidcut is a timeline editor for vertical short video (1080×1920). Typical flow: ' +
        'list_source to see what is in a footage folder (dir must be absolute; imported flags what is already in) → ' +
        'import_media one file at a time (absolute paths outside the project are fine — nothing is copied) → ' +
        "There is also a cross-project asset library holding the user's reusable media (logos, intros, BGM): " +
        'list_library searches it, import_from_library brings an asset into this project (look first, then take), ' +
        'add_to_library saves a local file (path) or an already-imported media (mediaId) there for future projects — ' +
        'give a descriptive label and tags. update_library_asset renames/retags one already there. ' +
        'Library writes bypass review locks and are not undoable; ' +
        'import_from_library itself is a project write and obeys both. → ' +
        'set_timeline for the initial cut, or add_clip to append to the end of the main track (leaves existing clips alone) → ' +
        'timeline_op for rough cutting (split/deleteBefore/deleteAfter/freeze) → ' +
        'set_overlays / set_captions for text (for talking-head footage just use auto_caption: captions plus per-word highlight in one call) → ' +
        'set_audio for voiceover or BGM (ducking lowers the original audio automatically) → ' +
        'request_review to have the user confirm in the browser → adjust per get_feedback → render.' +
        'Audio-only media (mp3/wav…) can only go on the audio track; add_clip and set_timeline reject it.' +
        "To pull one clip's own audio out and adjust its volume/fades separately, use extract_audio " +
        '(the clip is muted and its sound becomes a standalone audio item).' +
        "render's subtitles defaults to burn (captions burned into the picture); use embed to let viewers toggle them, " +
        'or sidecar (a separate .srt) for platforms that auto-translate subtitles — every mode except burn leaves the picture clean.' +
        'The exported length (get_project total) is whichever track reaches furthest, not just the main track — ' +
        'captions, audio or overlays that run past the main track extend the export, with the picture past the ' +
        'main track rendered black while that content still plays.' +
        'A clip can also carry leadPad: seconds of black, silent lead before its content, included in duration ' +
        '(content length = duration − leadPad) — update_clip / set_timeline / add_clip all take it, and get_frame ' +
        'returns a plain black frame for a time inside the pad, the same as the black tail past the main track.' +
        'After render, export_publish_package turns the finished video into a manual-upload package ' +
        '(output/publish/<stamp>/: video + cover + .srt + one metadata text file per platform + manifest with ' +
        'upload URLs and duration/size warnings) — write the platform captions/hashtags yourself and pass them in. ' +
        'Platforms: tiktok / youtube / instagram / facebook; per-platform kind (short|video) picks the warning ' +
        'thresholds — pass video for long-form YouTube/Facebook uploads. ' +
        'No social platform API is involved, the user uploads by hand.' +
        'For landscape footage on a vertical canvas, set_canvas_fit blur looks better than black bars.' +
        'There are two kinds of overlay, and text and imagePath are mutually exclusive — give exactly one: ' +
        'for text overlays use add_overlay/update_overlay/set_overlays with text (the server rasterizes the card and ' +
        'maintains imagePath for you — do not set it yourself; to change the wording just send new text); ' +
        'for image overlays give imagePath and no text (a PNG produced elsewhere; its text is not editable) — ' +
        'sending update_overlay + text to an image overlay is rejected (it will not silently become a text card); ' +
        'to convert one, remove_overlay then add_overlay.' +
        'set_timeline assigns a **new clipId** to every clip, so overlays anchored to the old clips break ' +
        '(the reply lists which ones; broken anchors show up in neither the preview nor the export) — to keep the ' +
        'anchors, pass the original ids back in clips. To only append, use add_clip; to only change the order, use ' +
        'reorder_clips (order takes the full clipId permutation, keeps the ids themselves, and does not touch anchors). ' +
        "timeline_op's deleteBefore/deleteAfter behave the same way, and they **only move the main track**: captions " +
        'and audio use absolute time, so once the picture shifts left they fall out of sync — fix them yourself with ' +
        'update_caption / update_audio. remove_clip breaks anchors exactly like deleteBefore/deleteAfter, and its ' +
        'reply lists the affected overlays too.' +
        "When update_caption shifts a whole caption (start changes, duration does not), that caption's tokens " +
        '(per-word timestamps, in absolute timeline seconds) shift with it; trimming (changing duration) leaves the ' +
        'word times alone.' +
        'Text overlays and captions **wrap automatically**: by default at 90% of the canvas width (text overlays can ' +
        'tune this with maxWidth), CJK breaks per character, Latin breaks at spaces, and a literal \\n in the string ' +
        'forces a break — you do not have to work out where to break.' +
        'If the text is long enough or the font large enough that the card would exceed the pixel budget, the write is ' +
        'rejected (the error states the estimated size; the line count is an upper bound, so real wrapping is usually ' +
        'much smaller).' +
        'get_editor_context reads the user\'s current selection and playhead (useful when they say "this bit"); ' +
        'get_frame shows the canvas at a given time (the reply embeds a JPEG); transcribe returns the transcript ' +
        '(word timestamps are timeline seconds) for picking segments or laying out captions yourself.' +
        'For small edits use the fine-grained tools (update_clip / update_caption / update_overlay / add_overlay / ' +
        'remove_overlay / remove_audio) rather than resending a whole set_*. ' +
        'Pass ifVersion on writes to avoid clobbering an edit the user just made; note that background media ' +
        'ingest (filmstrip/peaks/proxy finishing after import_media returns) can also bump the version on its own ' +
        '— that does not count as a user edit, so a stale rejection means someone (or something) else really did ' +
        'change the document meanwhile, not just that the version moved. ' +
        'writes are rejected while a review is in progress (import_media, set_cover and render included — they are ' +
        'writes too), and if the review is rejected, changes made since it was requested are rolled back in one go ' +
        '— except derived-file bookkeeping (filmstrip/peaks/proxy fields finishing in the background), which is not ' +
        'an edit and survives the rollback.' +
        'A write that replies "no-op" means the command was valid but no field actually changed — usually the values ' +
        'sent match the current state.' +
        'The patch for update_clip / update_caption / update_overlay / update_audio is matched strictly: a misspelled ' +
        'field name returns a schema error rather than becoming a no-op.' +
        'post_chat and get_chat are a talk channel with the person reviewing your work — the messages appear in the ' +
        'Chat tab of the editor and the user can reply there. It is **not an editing path**: chat changes nothing in ' +
        'the project, does not bump the version, and is not undoable, so keep doing the actual work with the editing ' +
        'tools above. Use post_chat to explain what you did or ask a question the edit itself cannot answer, and ' +
        'get_chat to read what the user told you (call it when you start, and again after a request_review round). ' +
        'For a decision you must block on, request_review is still the tool — post_chat does not wait for a reply.',
    },
  );

  /**
   * ── AI 進行中訊號的攔截層（spec 2026-08-14 agent-presence §3.1）─────────────────
   *
   * 把 `server.registerTool` 換掉，讓底下**每一個** registerTool 呼叫都自動走這裡：
   * handler 進入前廣播 start、離開後廣播 end。31 個工具一次涵蓋，不必逐一改 handler
   * （逐一改的版本就是「新增工具的人一定會忘記加」的那種設計）。
   *
   * 三條硬性約束：
   *
   * 1. **只攔執行，絕不碰工具面。** `name` 與 `config`（description / inputSchema /
   *    outputSchema / annotations）原封不動往下傳，被包起來的只有 callback。
   *    `server/test/mcp-surface-snapshot.test.ts` 逐位元組守著這件事——它紅了就是
   *    這層漏出去了，**不准 `-u`**。
   * 2. **`finally` 而不是「回傳後才發」。** handler 拋錯時 end 一樣要發出去，否則
   *    一次失敗的 transcribe 會讓 UI 永遠卡在 working（server 沒死、ws 沒斷，
   *    那條天然自癒的路走不到）。例外照原樣往外拋，這層不吞、不改。
   * 3. **回傳值原樣透傳。** 這層對結果零介入。
   *
   * `callId` 由 `agentActivity.ts` 的模組級計數器發——`mountMcp` 每個 HTTP 請求
   * 都 createMcpServer 一次，計數器綁在這個 closure 上會每請求歸零。
   */
  const registerTool = server.registerTool.bind(server) as typeof server.registerTool;
  server.registerTool = ((
    name: string,
    config: Parameters<typeof registerTool>[1],
    cb: (...args: unknown[]) => unknown,
  ) =>
    registerTool(name, config, (async (...args: unknown[]) => {
      const callId = nextCallId();
      emitAgentActivity({ phase: 'start', tool: name, callId });
      try {
        return await cb(...args);
      } finally {
        emitAgentActivity({ phase: 'end', tool: name, callId });
      }
    }) as Parameters<typeof registerTool>[2])) as typeof server.registerTool;

  // ---- 讀取 ----
  server.registerTool(
    'get_project',
    {
      description:
        'Trimmed overview of the project (clips/captions/media/version/review); full:true returns the whole JSON. ' +
        '⚠️ In the trimmed form, overlays and audio are **counts** (numbers), not arrays — for overlay/audio-item ' +
        'ids, positions or anchors, use full:true.',
      outputSchema: {
        version: z.number(),
        // 兩種形狀共用一個宣告：full:true 回 doc，否則回裁剪總覽。
        // zod 是 strip 不是 strict，所以「多回的欄位」不會讓驗證失敗；
        // 這裡列的是**保證有**的部分。
        doc: z.unknown().optional().describe('the full project JSON, when full:true'),
        name: z.string().optional(),
        canvas: z.unknown().optional(),
        total: z
          .number()
          .optional()
          .describe(
            'output duration in seconds — the length render will produce, which is the furthest ' +
              'any track reaches (captions/audio/overlays can extend past the main track; that extra ' +
              'time is a black tail in the picture). Equal to the main track length when nothing extends past it.',
          ),
        review: z.unknown().nullable().optional(),
        media: z.array(z.unknown()).optional(),
        clips: z.array(z.unknown()).optional(),
        overlays: z.number().optional().describe('**count** of overlays, not an array'),
        captions: z.array(z.unknown()).optional(),
        audio: z.number().optional().describe('**count** of audio items, not an array'),
      },
      inputSchema: { full: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ full }) => {
      if (full)
        return result(
          { version: store.version, doc: store.doc } as Record<string, unknown>,
          'full project',
        );
      const s = projectSummary(store);
      const mainTotal = totalDuration(store.doc);
      // s.total 是 outputDuration；超出主軌總長的部分是黑尾（畫面補黑，caption/
      // overlay/audio 仍照常合成）。相等時（絕大多數專案）完全不提，行為位元組級不變。
      const tailNote =
        s.total > mainTotal
          ? ` (video ${mainTotal.toFixed(1)}s + ${(s.total - mainTotal).toFixed(1)}s black tail)`
          : '';
      return result(
        s as unknown as Record<string, unknown>,
        `v${s.version}: ${s.clips.length} clips, total ${s.total.toFixed(1)}s${tailNote}`,
      );
    },
  );

  server.registerTool(
    'get_history',
    {
      description:
        'Recent change log (version/label/source/ts). limit defaults to 30, max 200 (the history retention cap).',
      outputSchema: { history: z.array(historyEntryOutput) },
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(0)
          .max(200)
          .optional()
          .describe('how many recent entries; default 30'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      // `slice(-n)` 對 n=0 是 `slice(-0)` ＝ `slice(0)` ＝ **整個陣列**，所以
      // `limit: 0` 以前會回全部（最多 200 筆）而不是零筆——語意正好相反。
      // 負數同樣詭異（`slice(3)` 是「砍掉最舊的 3 筆」）。先夾成非負整數再分流。
      const n = Math.max(0, Math.floor(limit ?? 30));
      const h = (n === 0 ? [] : store.history().slice(-n)).map((e): HistoryBrief => ({
        version: e.version,
        label: e.label,
        source: e.source,
        ts: e.ts,
      }));
      return result({ history: h }, `${h.length} entries`);
    },
  );

  server.registerTool(
    'get_feedback',
    {
      description:
        'Summary of human changes since the given version — how the AI reads back what the user adjusted.',
      outputSchema: {
        sinceVersion: z.number(),
        currentVersion: z.number(),
        humanChanges: z.array(z.object({ version: z.number(), label: z.string(), ts: z.string() })),
      },
      inputSchema: { sinceVersion: z.number() },
      annotations: { readOnlyHint: true },
    },
    async ({ sinceVersion }) => {
      // Plan 8 final review F3：排除 excludeFromRevert（background ingest 的
      // updateMediaDerived）——那不是使用者的編輯意圖，見 reviews.ts 同一處註解。
      const changes = store
        .history()
        .filter((h) => h.version > sinceVersion && h.source === 'human' && !h.excludeFromRevert)
        .map((h) => ({ version: h.version, label: h.label, ts: h.ts }));
      return result(
        { sinceVersion, currentVersion: store.version, humanChanges: changes },
        `${changes.length} human changes since v${sinceVersion}`,
      );
    },
  );

  server.registerTool(
    'get_editor_context',
    {
      description:
        "The user's current selection in the UI, playhead position, and dragged time range.",
      outputSchema: {
        selection: z
          .object({ kind: z.enum(['clip', 'overlay', 'caption', 'audio']), id: z.string() })
          .nullable(),
        playhead: z.number(),
        range: z.object({ start: z.number(), end: z.number() }).nullable(),
      },
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const c = editorContext.get();
      return result(
        c as unknown as Record<string, unknown>,
        `playhead=${c.playhead.toFixed(2)}s selection=${c.selection?.id ?? 'none'}`,
      );
    },
  );

  // ---- 與監修者的對話（**不是編輯路徑**）----
  // 三步鐵則的第三步：這兩隻工具沒有對應的 `Command` variant，因為聊天不改專案狀態
  // （見 chatStore.ts 檔頭）。它們共用 UI 左欄 Chat 分頁的同一份記錄，人的訊息從
  // WS 的 `sendChatMessage` 進來，兩邊都經 ChatStore 廣播給所有連線。
  const chatMessageOutput = z.object({
    id: z.string(),
    author: z.enum(['user', 'ai']),
    text: z.string(),
    ts: z.string().describe('ISO 8601 timestamp'),
  });

  server.registerTool(
    'get_chat',
    {
      description:
        'Read the conversation with the person reviewing your work (both sides, oldest first). ' +
        'Call it when you start and after each review round to pick up anything they typed in the ' +
        "editor's Chat tab. Read-only, and unrelated to project state — chat carries no edits.",
      outputSchema: { messages: z.array(chatMessageOutput) },
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('return only the most recent N messages; default all'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const all = chat.messages();
      // `slice(-0)` 是 `slice(0)` ＝ **整個陣列**，語意與 limit:0 正好相反——
      // get_history 踩過同一個坑，這裡先分流。
      const n = limit === undefined ? undefined : Math.max(0, Math.floor(limit));
      const messages = n === undefined ? [...all] : n === 0 ? [] : all.slice(-n);
      return result({ messages }, `${messages.length} message(s)`);
    },
  );

  server.registerTool(
    'post_chat',
    {
      description:
        'Say something to the person reviewing your work — it shows up in the Chat tab of the editor and they can ' +
        'reply there. Use it to explain what you changed or to ask a question the edit cannot answer. ' +
        '**Not an editing tool**: it changes nothing in the project, does not bump the version, and cannot be undone; ' +
        'keep making edits with the editing tools. It also does not block — when you need an answer before ' +
        'continuing, use request_review instead.',
      outputSchema: { ok: z.boolean(), message: chatMessageOutput },
      inputSchema: { text: z.string().describe('the message; blank messages are rejected') },
      annotations: { readOnlyHint: false },
    },
    async ({ text }) => {
      const trimmed = text.trim().slice(0, CHAT_MAX_LEN);
      if (trimmed.length === 0) return err('post_chat: text is empty');
      const message = chat.append('ai', trimmed);
      return result({ ok: true, message }, `posted: ${message.text}`);
    },
  );

  server.registerTool(
    'get_frame',
    {
      description:
        "Extract the frame at a given time as JPEG — the AI's eyes. Clip picture only: overlays, captions and the " +
        'blur background are NOT composited in; to check those, render or ask the user to look at the UI preview. ' +
        'Does not change project state, but does write a JPEG under derived/frames/ (re-extracted on every call, ' +
        'not cached). time is clamped to [0, output duration] — output duration is the furthest any track reaches ' +
        '(see get_project total), which can extend past the main track when captions/audio/overlays run longer. ' +
        'A time past the main track but within output duration returns a plain black frame (no overlays/captions ' +
        'composited there either) instead of an error; only a genuinely empty main track (no clips and nothing ' +
        "extending output duration) still returns an error. A time inside a clip's leadPad (its black, silent lead) " +
        'also returns a plain black frame, same as the black tail past the main track. ⚠️ get_frame succeeding at a ' +
        'given time does not mean render will succeed there — render additionally requires at least one clip on the ' +
        'main track.',
      outputSchema: {
        url: z
          .string()
          .describe(
            'openable directly by a local client; remote clients should use the embedded JPEG',
          ),
        path: z.string().describe('relative to the project folder'),
      },
      inputSchema: { time: z.number() },
      annotations: { readOnlyHint: true },
    },
    async ({ time }) => {
      const rel = await extractFrame(projectDir, store.doc, time);
      if (!rel) return err(`no active clip at ${time}s`);
      return imageReply(
        join(projectDir, rel),
        { url: `${baseUrl}/media/${rel}`, path: rel },
        `${baseUrl}/media/${rel}`,
      );
    },
  );

  // ---- 匯入 / 排片 ----
  server.registerTool(
    'list_source',
    {
      description:
        'List importable files in a footage folder (no recursion, hidden files excluded, whitelisted extensions only). ' +
        "dir must be absolute. imported flags whether the file is already in this project's doc.media. " +
        `Above ${MAX_FILES_INLINE} entries only the first are embedded, with truncated set.`,
      outputSchema: {
        dir: z.string(),
        total: z.number().describe('total matching files (may exceed the length of files)'),
        files: z.array(
          z.object({
            name: z.string(),
            size: z.number(),
            mtime: z.number().describe('epoch ms'),
            imported: z.boolean(),
          }),
        ),
        truncated: z.boolean().optional(),
      },
      inputSchema: { dir: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ dir }) => {
      try {
        const all = await listSource(dir, store.doc.media, projectDir);
        const truncated = all.files.length > MAX_FILES_INLINE;
        const files = truncated ? all.files.slice(0, MAX_FILES_INLINE) : all.files;
        return result(
          { dir, files, total: all.files.length, ...(truncated ? { truncated: true } : {}) },
          `${all.files.length} file(s) in ${dir}` +
            (truncated ? `, only the first ${MAX_FILES_INLINE} embedded` : ''),
        );
      } catch (e) {
        return err(`list_source failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'import_media',
    {
      description:
        'Register a media file. relPath may be relative to the project, or an absolute path outside it ' +
        '(referenced in place — nothing is copied). Returns as soon as the media is usable (probed and registered) ' +
        '— preview, get_frame, and render already work off the original file at this point. The proxy, filmstrip ' +
        'thumbnail strip, and audio peaks keep upgrading in the background afterward and do not block this call or ' +
        'any subsequent tool. Audio-only files (mp3/wav…) can be imported directly: they are usable on the audio ' +
        'track (set_audio) only, and only get peaks in the background (no proxy/filmstrip — there is no video ' +
        'stream to derive them from).',
      outputSchema: {
        mediaId: z.string(),
        probe: probeOutput,
        alreadyImported: z
          .boolean()
          .optional()
          .describe('true = this file was already imported; the existing id is reused'),
        version: z.number().optional().describe('present only when something was actually added'),
      },
      inputSchema: {
        relPath: z.string(),
        label: z.string().optional(),
        meta: z.record(z.unknown()).optional(),
        ifVersion: z.number().optional(),
      },
    },
    async ({ relPath, label, meta, ifVersion }) => {
      // 早期守衛：這個工具以前直接 store.mutate，兩層都沒走，所以**審核進行中照樣能把
      // 素材塞進專案**（實測 11 → 12 筆）。真正的守衛在下面的 aiWrite；這裡先擋一次
      // 純粹是為了在 review 進行中時完全不碰檔案系統（不跑那次註定寫不進去的 probe）。
      // 過期判定與 aiWrite 共用同一支 isStale（Plan 8 final review F2）：background
      // ingest 的 updateMediaDerived 推進 store.version 不算使用者動過文件，否則
      // import_media 自己也會在這裡誤判成「使用者剛改過」而白白拒絕。
      if (store.doc.review !== null) return err('error: a review is in progress');
      if (ifVersion !== undefined && isStale(store, ifVersion))
        return err(`error: stale (ifVersion=${ifVersion}, current=${store.version})`);
      try {
        // Plan 8：prepareMedia 現在只做 A0（probe + 組裸 asset），秒級。
        const prepared = await prepareMedia(store, projectDir, relPath, { label, meta });
        if ('existingId' in prepared) {
          const m = store.doc.media.find((x) => x.id === prepared.existingId)!;
          return result(
            { mediaId: m.id, probe: m.probe, alreadyImported: true },
            `${relPath} was already imported; reusing ${m.id} (${m.probe.duration.toFixed(1)}s)`,
          );
        }
        const w = aiWrite(store, { name: 'registerMedia', asset: prepared.asset }, ifVersion);
        if (!w.ok) return err(writeResultText(w));
        const m = prepared.asset;
        // A1（filmstrip+peaks）/A2（proxy）丟進背景佇列，不等待——與 ingestMedia
        // 共用同一條模組級序列佇列（見 ingest.ts 的 enqueueDerivedStages 註解）。
        const abs = resolveMediaPath(projectDir, relPath);
        enqueueDerivedStages(store, projectDir, m.id, abs, m.probe);
        return result(
          { mediaId: m.id, probe: m.probe, version: w.version },
          `imported ${relPath} as ${m.id} (${m.probe.duration.toFixed(1)}s)`,
        );
      } catch (e) {
        return err(`import failed: ${(e as Error).message}`);
      }
    },
  );

  /** 素材庫工具共用的前置：庫沒載入（索引損毀降級）時給出可行動的錯誤。 */
  const needLibrary = () =>
    library
      ? null
      : err('error: the asset library is unavailable on this server (corrupt library.json?)');

  server.registerTool(
    'list_library',
    {
      description:
        "Search the user's cross-project asset library (reusable logos, intros, BGM…). query matches label+tags " +
        '(case-insensitive substring), tag matches exactly. Look before you take: check here first, then ' +
        'import_from_library. broken=true means the file is missing on disk and cannot be imported.',
      outputSchema: {
        assets: z.array(
          z.object({
            id: z.string(),
            kind: z.string(),
            label: z.string(),
            tags: z.array(z.string()),
            origin: z.object({ type: z.string(), note: z.string().optional() }),
            duration: z.number(),
            hasVideo: z.boolean(),
            hasAudio: z.boolean(),
            broken: z.boolean(),
          }),
        ),
        total: z.number().describe('total matches (may exceed the length of assets)'),
        truncated: z.boolean().optional(),
      },
      inputSchema: {
        query: z.string().optional(),
        tag: z.string().optional(),
        kind: z.enum(['media']).optional(),
        limit: z.number().int().min(1).max(50).optional().describe('default 20'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, tag, kind, limit }) => {
      const gate = needLibrary();
      if (gate) return gate;
      // 這個工作區常態多 session 同開：讀入口先 reload 才看得到別的 session 剛入庫的 asset
      await library!.reload();
      const all = library!.list({ query, tag, kind });
      const n = limit ?? 20;
      const assets = all.slice(0, n).map((a) => ({
        id: a.id,
        kind: a.kind,
        label: a.label,
        tags: a.tags,
        origin: a.origin,
        duration: a.probe.duration,
        hasVideo: a.probe.hasVideo ?? true,
        hasAudio: a.probe.hasAudio,
        broken: a.broken,
      }));
      return result(
        { assets, total: all.length, ...(all.length > n ? { truncated: true } : {}) },
        `${all.length} asset(s)` + (all.length > n ? `, first ${n} embedded` : ''),
      );
    },
  );

  server.registerTool(
    'add_to_library',
    {
      description:
        "Save media into the user's cross-project library for reuse in future projects. Give exactly one of " +
        'path (absolute path on this machine) or mediaId (media already in this project). The file is **copied** ' +
        'into the library (content-addressed; adding the same content twice is a no-op returning the existing ' +
        'asset). Give a descriptive label and tags so the library stays findable — that is how list_library and ' +
        'the user will recognise it later. This is a library write, not a project edit: no undo, no review lock.',
      outputSchema: {
        assetId: z.string(),
        existing: z
          .boolean()
          .describe('true = same content was already in the library; that asset is returned'),
        label: z.string(),
      },
      inputSchema: {
        path: z.string().optional().describe('absolute path of a local media file'),
        mediaId: z.string().optional().describe('id of a media already imported into this project'),
        label: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ path, mediaId, label, tags }) => {
      const gate = needLibrary();
      if (gate) return gate;
      if ((path === undefined) === (mediaId === undefined)) {
        return err('error: give exactly one of path or mediaId');
      }
      try {
        let abs: string;
        let origin: { type: 'project' | 'source'; note?: string };
        let fallbackLabel: string | undefined;
        if (mediaId !== undefined) {
          const m = store.doc.media.find((x) => x.id === mediaId);
          if (!m) return err(`error: no media ${mediaId} in this project`);
          abs = resolveMediaPath(projectDir, m.path);
          origin = { type: 'project', note: store.doc.name };
          fallbackLabel = m.label ?? basename(m.path);
        } else {
          if (!isAbsolute(path!)) return err('error: path must be absolute');
          abs = path!;
          origin = { type: 'source', note: path! };
        }
        const r = await addToLibrary(library!, abs, {
          label: label ?? fallbackLabel,
          tags,
          origin,
        });
        return result(
          { assetId: r.asset.id, existing: r.existing, label: r.asset.label },
          r.existing
            ? `already in the library as ${r.asset.id} ("${r.asset.label}")`
            : `saved to the library as ${r.asset.id} ("${r.asset.label}")`,
        );
      } catch (e) {
        return err(`add_to_library failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'import_from_library',
    {
      description:
        'Import a library asset into this project: its derivatives are copied in (no re-processing) and the file ' +
        'is referenced in place from the library (content-addressed, so the reference never breaks). Check with ' +
        'list_library first — look and take are two steps. Returns a mediaId. addToTimeline appends it to the end ' +
        'of the main track (audio-only assets are refused there — use set_audio instead, the import itself still ' +
        'succeeds). This writes the project: review locks and ifVersion apply.',
      outputSchema: {
        mediaId: z.string(),
        alreadyImported: z.boolean().optional(),
        addedToTimeline: z.boolean().optional(),
        version: z.number().optional(),
      },
      inputSchema: {
        assetId: z.string(),
        addToTimeline: z.boolean().optional(),
        ifVersion: z.number().optional(),
      },
    },
    async ({ assetId, addToTimeline, ifVersion }) => {
      const gate = needLibrary();
      if (gate) return gate;
      // 早期守衛同 import_media：derived 複製前就擋，不做白工
      if (store.doc.review !== null) return err('error: a review is in progress');
      if (ifVersion !== undefined && ifVersion !== store.version)
        return err(`error: stale (ifVersion=${ifVersion}, current=${store.version})`);
      try {
        const prepared = await prepareFromLibrary(store, projectDir, library!, assetId);
        let mediaId: string;
        let version: number | undefined;
        let already = false;
        if ('existingId' in prepared) {
          mediaId = prepared.existingId;
          already = true;
        } else {
          const w = aiWrite(store, { name: 'registerMedia', asset: prepared.asset }, ifVersion);
          if (!w.ok) {
            // 登記失敗：prepareFromLibrary 已經把 derived/<id>/ cp 進專案了，不清會留孤兒目錄
            await discardPrepared(projectDir, prepared.asset);
            return err(writeResultText(w));
          }
          mediaId = prepared.asset.id;
          version = w.version;
        }
        let addedToTimeline = false;
        let note = '';
        if (addToTimeline) {
          const m = store.doc.media.find((x) => x.id === mediaId)!;
          const w = aiWrite(store, {
            name: 'addClip',
            mediaId,
            in: 0,
            duration: m.probe.duration,
            label: m.label,
          });
          if (w.ok) {
            addedToTimeline = true;
            version = w.version;
          } else {
            note = ` (not added to the timeline: ${w.error})`;
          }
        }
        return result(
          {
            mediaId,
            ...(already ? { alreadyImported: true } : {}),
            ...(addToTimeline ? { addedToTimeline } : {}),
            ...(version !== undefined ? { version } : {}),
          },
          (already
            ? `${assetId} was already in this project as ${mediaId}`
            : `imported ${assetId} as ${mediaId}`) + note,
        );
      } catch (e) {
        return err(`import_from_library failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'update_library_asset',
    {
      description:
        'Rename or retag a library asset (label/tags are what list_library searches). Library write: no undo, ' +
        'no review lock. Give at least one of label, tags.',
      outputSchema: { assetId: z.string(), label: z.string(), tags: z.array(z.string()) },
      inputSchema: {
        assetId: z.string(),
        label: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ assetId, label, tags }) => {
      const gate = needLibrary();
      if (gate) return gate;
      if (label === undefined && tags === undefined) return err('error: give label and/or tags');
      try {
        const a = await library!.updateAsset(assetId, { label, tags });
        return result(
          { assetId: a.id, label: a.label, tags: a.tags },
          `updated ${a.id}: "${a.label}" [${a.tags.join(', ')}]`,
        );
      } catch (e) {
        return err(`update_library_asset failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'set_timeline',
    {
      description:
        'Set the whole video main track (the initial cut). clips are in playback order. ' +
        '⚠️ Every item gets a **new clipId**, so overlays anchored to the old clips (anchor.clipId) break — ' +
        'a broken overlay shows up in neither the preview nor the export, and the reply lists which ones. ' +
        'To keep the anchors, include the original id on each item (get_project gives you them); ' +
        'to only append, use add_clip, which leaves existing clips alone. ' +
        'Every item is validated and **one bad item rejects the whole batch, leaving the document untouched**: ' +
        'mediaId must exist, audio-only media is refused (use set_audio for BGM/voiceover), in >= 0 and duration > 0, ' +
        'in+duration must not exceed the source length, volume within 0–2, and ids you supply must not repeat. ' +
        "leadPad puts a black, silent lead before the clip's content — duration already includes it, so content " +
        'length = duration − leadPad, and that content length must still be >= 0.1s with in + content length not ' +
        'exceeding the source length. Omitting leadPad means 0 for every item — this is a whole-track replace, so ' +
        "an existing clip's pad is not carried forward unless you resend it.",
      outputSchema: clipTrackOutput,
      inputSchema: { clips: z.array(timelineClipSchema), ifVersion: z.number().optional() },
    },
    async ({ clips, ifVersion }) =>
      clipTrackReply(store, aiWrite(store, { name: 'setTimeline', clips }, ifVersion)),
  );

  server.registerTool(
    'add_clip',
    {
      description:
        'Append already-imported media to the end of the main track (existing clips are untouched — good for adding ' +
        'one file at a time). Audio-only media is rejected: use set_audio for BGM/voiceover. Returns the new clipId. ' +
        "leadPad puts a black, silent lead before the clip's content — duration already includes it, so content " +
        'length = duration − leadPad, and that content length must still be >= 0.1s with in + content length not ' +
        'exceeding the source length; omit for no pad (0).',
      outputSchema: { clipId: z.string(), version: z.number() },
      inputSchema: {
        mediaId: z.string(),
        in: z.number(),
        duration: z.number(),
        label: z.string().optional(),
        leadPad: z
          .number()
          .optional()
          .describe(
            "Seconds of black, silent lead before the clip's content; omit for no pad (0). See the tool " +
              'description for how it interacts with duration and the source-length bound.',
          ),
        ifVersion: z.number().optional(),
      },
    },
    async ({ mediaId, in: clipIn, duration, label, leadPad, ifVersion }) => {
      const cmd = { name: 'addClip', mediaId, in: clipIn, duration, label, leadPad } as const;
      const r = aiWrite(store, cmd, ifVersion);
      if (!r.ok) return err(writeResultText(r));
      // addClip 的語意就是 append，所以新 clip 必為尾端那一個。
      const clipId = store.doc.tracks.video.at(-1)!.id;
      return result({ clipId, version: r.version }, `ok, clipId=${clipId}, version=${r.version}`);
    },
  );

  // ---- 編輯（經 aiWrite 守衛 → 命令層）----
  server.registerTool(
    'update_clip',
    {
      description:
        "Change one clip's in/duration/volume/label/leadPad (its position in the main track is untouched). " +
        'Bounds are checked against the **post-patch** shape: in >= 0, duration >= 0.1s, ' +
        'in + (duration − leadPad) must not exceed the source length, volume within 0–2. ' +
        "leadPad puts a black, silent lead before the clip's content — duration is unchanged and already includes " +
        'it, so content length = duration − leadPad, which must still be >= 0.1s with in + content length not ' +
        'exceeding the source length; omitting leadPad in the patch leaves the current value alone (unlike ' +
        'set_timeline, this is a partial patch, not a whole-track replace). ' +
        '⚠️ The main track is magnetic, so changing duration shifts every clip after it, while captions and audio use ' +
        'absolute time and do NOT move with it — fix them yourself with update_caption / update_audio.',
      outputSchema: writeOutput,
      inputSchema: {
        clipId: z.string(),
        patch: clipPatchSchema,
        ifVersion: z.number().optional(),
      },
    },
    async ({ clipId, patch, ifVersion }) =>
      writeReply(aiWrite(store, { name: 'updateClip', clipId, patch }, ifVersion)),
  );

  server.registerTool(
    'reorder_clips',
    {
      description: 'Reorder the main-track clips (order is a permutation of clipIds).',
      outputSchema: writeOutput,
      inputSchema: { order: z.array(z.string()), ifVersion: z.number().optional() },
    },
    async ({ order, ifVersion }) =>
      writeReply(aiWrite(store, { name: 'reorderClips', order }, ifVersion)),
  );

  server.registerTool(
    'remove_clip',
    {
      description:
        'Remove one clip (the magnetic main track closes the gap, so every later clip shifts left). ' +
        'Overlays anchored to it break and the reply lists which ones; captions and audio use absolute time and do ' +
        'NOT shift left with the picture — fix them yourself with update_caption / update_audio.',
      outputSchema: clipTrackOutput,
      inputSchema: { clipId: z.string(), ifVersion: z.number().optional() },
    },
    async ({ clipId, ifVersion }) =>
      clipTrackReply(store, aiWrite(store, { name: 'removeClip', clipId }, ifVersion)),
  );

  server.registerTool(
    'set_overlays',
    {
      description:
        'Replace the whole overlay track (every existing overlay is replaced; an empty array clears it). ' +
        'Each item must give exactly one of text and imagePath: items with text get a card rasterized and ' +
        'imagePath filled in automatically (do not set it yourself); image-only items give a real imagePath. ' +
        'Each item is also meant to satisfy: at least one of start and anchor, anchor.clipId pointing at an existing ' +
        'clip, duration > 0 or null (= until the end), and non-repeating ids. ' +
        '⚠️ **Those four are NOT enforced on this whole-track-replace path** (add_overlay is where they are checked) — ' +
        'a bad item reports no error, it simply never appears in the preview or the export. Add overlays one at a ' +
        'time with add_overlay to get the checks. ' +
        'When both are given, anchor overrides start; neither this path nor add_overlay blocks that — only ' +
        'update_overlay does. A card over the pixel budget does reject the whole batch.',
      outputSchema: writeOutput,
      inputSchema: { overlays: z.array(overlaySchema), ifVersion: z.number().optional() },
    },
    async ({ overlays, ifVersion }) => {
      try {
        const cmd = await resolveTextCommand(textCards, store, {
          name: 'setOverlays',
          overlays: overlays.map(toOverlayItem),
        });
        return writeReply(aiWrite(store, cmd, ifVersion));
      } catch (e) {
        return err(`text card generation failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'set_captions',
    {
      description:
        'Replace the whole caption track (every existing caption is replaced; an empty array clears it). start and ' +
        'tokens are absolute timeline seconds. Every caption is validated and **one bad caption rejects the whole ' +
        'batch, leaving the document untouched**: duration must be > 0, a caption must not fall entirely before t=0, ' +
        'and its card must not exceed the pixel budget (text too long or fontSize too large — the error states the ' +
        'estimated size). To touch a single caption, use update_caption.',
      outputSchema: writeOutput,
      inputSchema: { captions: z.array(captionSchema), ifVersion: z.number().optional() },
    },
    async ({ captions, ifVersion }) =>
      writeReply(
        aiWrite(store, { name: 'setCaptions', captions: captions as CaptionItem[] }, ifVersion),
      ),
  );

  // ---- 細粒度編輯（小修不必整組重送；全部支援 ifVersion）----
  server.registerTool(
    'update_caption',
    {
      description:
        'Change one caption only (text/start/duration/style/tokens). Use this for small edits instead of resending ' +
        'the whole set_captions. style replaces wholesale when provided; tokens: [] clears the per-word timestamps. ' +
        '⚠️ For a caption that has tokens, changing text requires sending tokens **in the same call** (either [] or a ' +
        'set that matches the new wording). Sending text alone changes nothing on screen — the card is laid out from ' +
        'tokens and never looks at text — and the write **succeeds**: the version advances, the reply is not "no-op", ' +
        'and nothing in it reveals the problem. See the note on patch.text. ' +
        'tokens (per-word timestamps) hold absolute timeline seconds, and the server shifts them for you only on a ' +
        'whole-caption move: start alone (or start with duration unchanged) means the caption moves to another point ' +
        "in time, and every word's start/end shifts by the same delta — no need to recompute them. Trimming leaves " +
        'word times completely alone: duration alone (shorten the tail), or start and duration together with duration ' +
        'changing (shorten the head: the right edge stays, start moves later). That is editing "how long this caption ' +
        'is shown", not "when each word is spoken". ' +
        'If the same call also supplies tokens, yours win and no shifting is applied.',
      outputSchema: writeOutput,
      inputSchema: {
        id: z.string(),
        patch: z
          .object({
            text: z
              .string()
              .optional()
              .describe(
                '⚠️ **When this caption has tokens, changing text alone changes nothing on screen**: the card is laid ' +
                  'out from tokens and ignores text entirely. The text really is written to the document and the ' +
                  'version really does advance, so the reply is indistinguishable from a real edit (not "no-op", no ' +
                  'error) — only the picture stays put. When changing the wording, also send `tokens: []` to clear ' +
                  'the old word boundaries, which no longer match the new text; to keep the per-word highlight, ' +
                  'supply a set of tokens that matches it.',
              ),
            start: z.number().optional(),
            duration: z.number().optional(),
            style: captionStyleSchema.optional(),
            tokens: captionTokensSchema.optional(),
          })
          .strict(),
        ifVersion: z.number().optional(),
      },
    },
    async ({ id, patch, ifVersion }) =>
      writeReply(aiWrite(store, { name: 'updateCaption', id, patch }, ifVersion)),
  );

  server.registerTool(
    'update_overlay',
    {
      description:
        'Change one overlay only (start/anchor/duration/position/text). start and anchor are mutually exclusive here: ' +
        'whichever you send is the positioning it switches to. ' +
        "To change a text overlay's wording or style, send new text (the server re-rasterizes the card and updates " +
        'imagePath — you neither need to nor should set imagePath yourself).',
      outputSchema: writeOutput,
      inputSchema: {
        id: z.string(),
        patch: z
          .object({
            start: z.number().optional(),
            anchor: z.object({ clipId: z.string(), offset: z.number() }).optional(),
            duration: z.number().nullable().optional(),
            position: z
              .object({ x: z.number(), y: z.number(), scale: z.number() })
              .optional()
              .describe(
                // 這段必須跟上面 overlaySchema 的 position describe 講同一件事——
                // 它是 update_overlay 自己內嵌的一份，改了那邊沒改這邊，AI 讀到的就是舊語意。
                'Replaced wholesale (there is no per-field patch semantics here). x is the horizontal centre, y is ' +
                  'the top edge — they are not symmetric. x/y are not limited to 0–1: an overlay may hang partly off ' +
                  'the canvas (negative y = off the top edge), and the part that hangs off is clipped identically in ' +
                  'both the export and the preview. scale is a multiplier about the top-centre point, identical in ' +
                  'export and preview; it is limited to 0–10 and negative values are rejected (the preview would ' +
                  'mirror while the export would drop the image entirely); scale=0 is invisible in both.',
              ),
            text: overlayTextSchema
              .optional()
              .describe(
                'Change the wording or style: the server re-rasterizes the card and updates imagePath. Only valid ' +
                  'on an item that was already a text overlay (created with text); sending text to an image overlay ' +
                  'is rejected — it will not be converted into a text card and its imagePath is not overwritten. ' +
                  'To convert one, remove_overlay then add_overlay.',
              ),
          })
          .strict(),
        ifVersion: z.number().optional(),
      },
    },
    async ({ id, patch, ifVersion }) => {
      try {
        const cmd = await resolveTextCommand(textCards, store, {
          name: 'updateOverlay',
          id,
          patch: patch as Partial<OverlayItem>,
        });
        return writeReply(aiWrite(store, cmd, ifVersion));
      } catch (e) {
        return err(`text card generation failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'add_overlay',
    {
      description:
        'Add a single overlay (the others are untouched). Give exactly one of text and imagePath: a text overlay ' +
        'carries text (the server rasterizes the card and maintains imagePath — do not set it yourself); an image ' +
        'overlay gives a real imagePath. ' +
        'Checked here: the id must not collide with an existing overlay, **at least one** of start and anchor must be ' +
        'given, anchor.clipId must point at an existing clip, and duration must be > 0 or null (= until the end). ' +
        '⚠️ Giving both start and anchor is **not an error**, but anchor overrides start and start silently does ' +
        'nothing — of the three paths only update_overlay blocks that combination. ' +
        'An anchored overlay follows its clip; one positioned by absolute start does not.',
      outputSchema: writeOutput,
      inputSchema: { overlay: overlaySchema, ifVersion: z.number().optional() },
    },
    async ({ overlay, ifVersion }) => {
      try {
        const cmd = await resolveTextCommand(textCards, store, {
          name: 'addOverlay',
          overlay: toOverlayItem(overlay),
        });
        return writeReply(aiWrite(store, cmd, ifVersion));
      } catch (e) {
        return err(`text card generation failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'remove_overlay',
    {
      description: 'Remove one overlay.',
      outputSchema: writeOutput,
      inputSchema: { id: z.string(), ifVersion: z.number().optional() },
    },
    async ({ id, ifVersion }) =>
      writeReply(aiWrite(store, { name: 'removeOverlay', id }, ifVersion)),
  );

  server.registerTool(
    'remove_audio',
    {
      description: 'Remove one audio item.',
      outputSchema: writeOutput,
      inputSchema: { id: z.string(), ifVersion: z.number().optional() },
    },
    async ({ id, ifVersion }) => writeReply(aiWrite(store, { name: 'removeAudio', id }, ifVersion)),
  );

  server.registerTool(
    'undo',
    {
      description:
        'Undo the last N edits (cursor-style: call it repeatedly to keep walking back). ' +
        '**Only changes to the tracks and the canvas are undoable** — rendering, reviews, the cover (set_cover) and ' +
        'importing media (import_media) never enter the undo stack and cannot be undone. If fewer than N are ' +
        'available it undoes what there is; only an empty stack is an error. ' +
        '⚠️ The undo stack is **shared between the human and the AI** — what you undo may be an adjustment the user ' +
        'just made. When unsure, check the source of the recent entries with get_history first.',
      outputSchema: writeOutput,
      inputSchema: {
        steps: z.number().int().min(1).optional().describe('how many edits to undo; default 1'),
        ifVersion: z.number().optional(),
      },
    },
    async ({ steps, ifVersion }) => writeReply(aiWrite(store, { name: 'undo', steps }, ifVersion)),
  );

  server.registerTool(
    'redo',
    {
      description:
        'Redo the last N undone edits (the inverse of undo). Making a new edit clears what could be redone. ' +
        'The stack is shared with the human — same caveat as undo.',
      outputSchema: writeOutput,
      inputSchema: {
        steps: z.number().int().min(1).optional().describe('how many edits to redo; default 1'),
        ifVersion: z.number().optional(),
      },
    },
    async ({ steps, ifVersion }) => writeReply(aiWrite(store, { name: 'redo', steps }, ifVersion)),
  );

  // ---- 逐字稿與自動字幕 ----

  server.registerTool(
    'transcribe',
    {
      description:
        'Run speech recognition (whisper.cpp) over the whole timeline and return per-word timestamps. ' +
        'Times are absolute timeline seconds, usable directly as caption times — no source-time conversion needed. ' +
        '⚠️ What is fed to recognition is **not** the final mix: for maximum accuracy, clip volume, audio-item volume, ' +
        'fades and ducking are all ignored — dialogue inside a muted clip (including the original clip after ' +
        'extract_audio) is still transcribed. Frozen clips and media without an audio track are padded with silence, ' +
        'so the times still line up. It fails when the timeline has no audio at all. ' +
        '**Does not change project state**, but it does mix the whole timeline (ffmpeg) and then run whisper — a ' +
        'minutes-long operation — and it writes derived/asr.wav and derived/asr.json (the latter is the jsonPath it ' +
        'returns). ' +
        `To go straight to captions, use auto_caption. Above ${MAX_WORDS_INLINE} words, ` +
        `or a transcript longer than ${MAX_TEXT_INLINE} characters, only the start is embedded and truncated is set; ` +
        'the full result is at jsonPath.',
      outputSchema: {
        language: z.string(),
        wordCount: z.number().describe('total number of words (may exceed the length of words)'),
        words: z.array(transcriptWordOutput).describe('times are absolute timeline seconds'),
        wordsTruncated: z.boolean().optional(),
        text: z.string(),
        textTruncated: z.boolean().optional(),
        jsonPath: z.string().describe('path of the full result, relative to the project folder'),
      },
      inputSchema: {
        language: z
          .string()
          .optional()
          .describe(
            "'auto' (the default) or a language code such as zh / en / ja. Naming the language is usually more accurate than auto-detection",
          ),
      },
      // Deliberately **no** readOnlyHint: hosts use it to skip permission prompts, and this one runs minutes of
      // ffmpeg + whisper and writes files. "Does not change project state" is not the same as "cheap and free of
      // side effects".
    },
    async ({ language }) => {
      const r = await transcribe(store.doc, projectDir, { language });
      const truncated = r.words.length > MAX_WORDS_INLINE;
      const textTruncated = r.text.length > MAX_TEXT_INLINE;
      return result(
        {
          language: r.language,
          wordCount: r.words.length,
          words: truncated ? r.words.slice(0, MAX_WORDS_INLINE) : r.words,
          ...(truncated ? { wordsTruncated: true } : {}),
          text: textTruncated ? r.text.slice(0, MAX_TEXT_INLINE) : r.text,
          ...(textTruncated ? { textTruncated: true } : {}),
          jsonPath: r.jsonPath,
        },
        `transcript: ${r.words.length} words (language ${r.language})` +
          (truncated || textTruncated
            ? `, embedded copy truncated; full result at ${r.jsonPath}`
            : '') +
          `\n${r.text.slice(0, 400)}`,
      );
    },
  );

  server.registerTool(
    'auto_caption',
    {
      description:
        'One-shot auto captions: recognize → paginate → write the caption track (a whole-track replace; every ' +
        'existing caption is replaced). ' +
        'Recognition takes the same path as transcribe — minutes of ffmpeg + whisper, the same derived/asr.wav and ' +
        'derived/asr.json, and the same disregard for volume and ducking. ' +
        'karaoke is on by default (per-word highlight; rendering emits one card per word). ' +
        'To control the sentence splitting yourself, use transcribe + set_captions instead. ' +
        `Above ${MAX_CAPTIONS_INLINE} captions the reply embeds only the start and sets captionsTruncated ` +
        '(when the write succeeded the full set is in the document, readable via get_project).',
      outputSchema: {
        language: z.string(),
        wordCount: z.number(),
        captionCount: z
          .number()
          .describe('total captions produced (may exceed the length of captions)'),
        captions: z.array(
          z.object({
            id: z.string(),
            text: z.string(),
            start: z.number(),
            duration: z.number(),
            style: z.unknown(),
            tokens: z.array(captionTokenOutput).optional(),
          }),
        ),
        captionsTruncated: z.boolean().optional(),
        write: z
          .object({ version: z.number().optional(), error: z.string().optional() })
          .describe(
            'the write result. An error here means the captions did not reach the document (the reply is also flagged isError)',
          ),
      },
      inputSchema: {
        language: z.string().optional(),
        karaoke: z.boolean().optional().describe('per-word highlight; default true'),
        maxGapMs: z
          .number()
          .optional()
          .describe('break to a new caption when the gap between words exceeds this (default 400)'),
        maxDurationMs: z
          .number()
          .optional()
          .describe('max milliseconds per caption (default 2500)'),
        maxUnits: z
          .number()
          .optional()
          .describe('max width per caption; a CJK character counts as 2 (default 24)'),
        style: z
          .object({
            fontFamily: z.string().optional(),
            fontSize: z.number().positive().max(CARD_LIMITS.fontSizeMax).optional(),
            fill: z.string().optional(),
            stroke: z.string().optional(),
            y: z.number().optional(),
            highlight: z.string().optional(),
          })
          .optional()
          .describe('override the caption style; omitted fields keep their defaults'),
        ifVersion: z.number().optional(),
      },
    },
    async ({ language, karaoke, maxGapMs, maxDurationMs, maxUnits, style, ifVersion }) => {
      // 先擋一次「反正一定寫不進去」的兩種情況。真正的守衛仍在下面的 aiWrite（樂觀鎖的
      // 語意就是要在寫入的當下比對），這裡純粹是不要為了一個註定失敗的寫入先燒掉一趟
      // whisper——辨識是分鐘級的，而審核中／版本已過期在呼叫的當下就看得出來。
      if (store.doc.review !== null) return err('error: a review is in progress');
      if (ifVersion !== undefined && ifVersion !== store.version)
        return err(`error: stale (ifVersion=${ifVersion}, current=${store.version})`);
      const r = await transcribe(store.doc, projectDir, { language });
      const captions = buildCaptionPages(
        r.words,
        { karaoke, maxGapMs, maxDurationMs, maxUnits },
        { ...DEFAULT_CAPTION_STYLE, ...style },
      );
      const write = aiWrite(store, { name: 'setCaptions', captions }, ifVersion);
      const capTruncated = captions.length > MAX_CAPTIONS_INLINE;
      const payload = {
        language: r.language,
        wordCount: r.words.length,
        captionCount: captions.length,
        captions: capTruncated ? captions.slice(0, MAX_CAPTIONS_INLINE) : captions,
        ...(capTruncated ? { captionsTruncated: true } : {}),
        write: write.ok ? { version: write.version } : { error: write.error },
      };
      const summary = `${writeResultText(write)} | auto-caption: ${captions.length} captions / ${r.words.length} words (${r.language})`;
      // 寫入失敗要標 isError（見 errResult）。captions 照樣回去——辨識已經花掉了，
      // 呼叫端拿它去 set_captions 就不必重跑。
      return write.ok ? result(payload, summary) : errResult(payload, summary);
    },
  );

  // ---- 播放頭操作（粗剪主力）----
  server.registerTool(
    'timeline_op',
    {
      description:
        'Rough-cut at a point on the timeline: split, deleteBefore (drop the picture before that time), ' +
        'deleteAfter (drop what follows), or freeze (insert a freeze-frame). Only the video main track is affected, ' +
        'and the magnetic track closes the gap. ' +
        '⚠️ The price of touching **only the main track**: captions and audio use absolute timeline seconds, so after ' +
        'a deleteBefore the picture shifts left while they stay put — they fall out of sync and you must fix them ' +
        'with update_caption / update_audio. (Same semantics as CapCut; not a bug.) Also, when a whole clip ' +
        'disappears, overlays anchored to it break and the reply lists which ones. ' +
        "split's cut point must fall strictly inside a clip, leaving at least 0.1s on each side — too close to an " +
        'edge is rejected. When the clip has a leadPad, a point inside that black lead is also rejected for split ' +
        'and freeze, even if it clears the 0.1s edge buffer — the error names the pad boundary (the lead has no ' +
        'source frame to cut or freeze at). deleteBefore/deleteAfter handle the pad gracefully instead of ' +
        'rejecting: a cut landing inside the lead just shortens it (or, for deleteAfter, drops the whole clip when ' +
        'nothing but pad would be left). A freeze inserts a **silent** frozen clip (it occupies timeline length, ' +
        'so everything after it shifts right).',
      outputSchema: clipTrackOutput,
      inputSchema: {
        op: z.enum(['split', 'deleteBefore', 'deleteAfter', 'freeze']),
        time: z.number().describe('absolute timeline seconds'),
        duration: z.number().optional().describe('length of the freeze; default 3 seconds'),
        ifVersion: z.number().optional(),
      },
    },
    async ({ op, time, duration, ifVersion }) => {
      const cmd =
        op === 'split'
          ? ({ name: 'splitAt', time } as const)
          : op === 'deleteBefore'
            ? ({ name: 'deleteBefore', time } as const)
            : op === 'deleteAfter'
              ? ({ name: 'deleteAfter', time } as const)
              : ({ name: 'freezeFrame', time, duration } as const);
      // deleteBefore/deleteAfter 會讓整段片段消失 → 錨點可能斷掉，跟 set_timeline 同一件事
      return clipTrackReply(store, aiWrite(store, cmd, ifVersion));
    },
  );

  // ---- 音訊 ----
  server.registerTool(
    'extract_audio',
    {
      description:
        "Extract a clip's audio into a standalone audio item (the clip's own volume goes to zero), so it can be " +
        'adjusted, faded or deleted on its own. ' +
        'The extracted item uses **absolute timeline time** and does not follow the original clip — reorder or delete ' +
        'clips later and the sound stays where it was, so fix it yourself with update_audio. ' +
        'Rejected when the media has no audio track.',
      outputSchema: writeOutput,
      inputSchema: { clipId: z.string(), ifVersion: z.number().optional() },
    },
    async ({ clipId, ifVersion }) =>
      writeReply(aiWrite(store, { name: 'extractAudio', clipId }, ifVersion)),
  );

  server.registerTool(
    'set_audio',
    {
      description:
        'Set the whole audio track (voiceover/BGM; every existing audio item is replaced, an empty array clears the ' +
        "track). start is absolute timeline seconds; ducking lowers the video's own audio to a quarter while that " +
        'item plays. ' +
        'Every item is validated and **one bad item rejects the whole batch, leaving the document untouched**: ' +
        'mediaId must exist, start and in must be >= 0, duration must be > 0, volume within 0–2, fadeIn/fadeOut must ' +
        'not exceed duration, and in+duration must not exceed the source length. ' +
        'To touch a single item, use update_audio.',
      outputSchema: writeOutput,
      inputSchema: { audio: z.array(audioSchema), ifVersion: z.number().optional() },
    },
    async ({ audio, ifVersion }) =>
      writeReply(aiWrite(store, { name: 'setAudio', audio: audio as AudioItem[] }, ifVersion)),
  );

  server.registerTool(
    'update_audio',
    {
      description:
        'Adjust one audio item (volume, fades, timing, ducking). ' +
        'The rules are checked against the **post-patch** shape, not just the fields you sent — shortening duration ' +
        'alone, in a way that leaves an existing fadeOut longer than the new duration, is rejected. ' +
        'Bounds are the same as set_audio.',
      outputSchema: writeOutput,
      inputSchema: {
        id: z.string(),
        // strict：理由同 clipPatchSchema——打錯欄位名（例如 gain）會被靜默丟掉，
        // 然後回一句「ok」但音量根本沒動。
        patch: z
          .object({
            start: z.number().optional(),
            in: z.number().optional(),
            duration: z.number().optional(),
            volume: z.number().min(0).max(2).optional(),
            fadeIn: z.number().min(0).optional(),
            fadeOut: z.number().min(0).optional(),
            ducking: z.boolean().optional(),
          })
          .strict(),
        ifVersion: z.number().optional(),
      },
    },
    async ({ id, patch, ifVersion }) =>
      writeReply(aiWrite(store, { name: 'updateAudio', id, patch }, ifVersion)),
  );

  // ---- 畫布與封面 ----
  server.registerTool(
    'set_canvas_fit',
    {
      description:
        'What to do when the media does not fill the canvas: contain = black bars, blur = a blurred, scaled-up fill ' +
        '(blur is the better look for landscape footage on a 9:16 canvas).',
      outputSchema: writeOutput,
      inputSchema: { fit: z.enum(['contain', 'blur']), ifVersion: z.number().optional() },
    },
    async ({ fit, ifVersion }) =>
      writeReply(aiWrite(store, { name: 'setCanvasFit', fit }, ifVersion)),
  );

  server.registerTool(
    'set_cover',
    {
      description:
        'Set the cover image: when a rendered file is still around, the frame at that time is taken from the export ' +
        '(overlays and captions included); otherwise it falls back to the source media (clip picture only). ' +
        'Always written to output/cover.jpg, overwriting the same file on every call. ' +
        'The reply embeds the JPEG; the URL and path are in the structured content.',
      outputSchema: {
        coverPath: z.string().describe('relative to the project folder'),
        url: z.string(),
        version: z.number(),
      },
      inputSchema: { time: z.number(), ifVersion: z.number().optional() },
    },
    async ({ time, ifVersion }) => {
      // 這個工具以前直接 store.mutate，繞過 aiWrite——審核進行中照樣改得動 coverPath。
      if (store.doc.review !== null) return err('error: a review is in progress');
      try {
        const rel = await renderCoverImage(store.doc, projectDir, time);
        const w = aiWrite(store, { name: 'setCover', path: rel }, ifVersion);
        if (!w.ok) return err(writeResultText(w));
        return imageReply(
          join(projectDir, rel),
          { coverPath: rel, url: `${baseUrl}/media/${rel}`, version: w.version },
          `${baseUrl}/media/${rel}`,
        );
      } catch (e) {
        return err(`cover failed: ${(e as Error).message}`);
      }
    },
  );

  // ---- 審核 ----
  server.registerTool(
    'request_review',
    {
      description:
        'Ask the user to review the current timeline in the browser UI. Blocks until approved / rejected / timed out ' +
        '(15 minutes by default), and returns the outcome plus whatever the human changed during the review. ' +
        '⚠️ When the outcome is rejected, changes made since this call are rolled back in one go (back to the ' +
        'version as it was when the review was requested) — it is not merely a "rejected" answer. Derived-file ' +
        'bookkeeping (filmstrip/peaks/proxy fields finishing in the background) is excluded from the rollback: ' +
        'that is not an edit, so it survives. ' +
        'While the review is open every write of yours is refused and only the user can edit; writes resume once it ' +
        'is approved or rejected. ' +
        'Calling it again before the previous round finishes closes that round as a timeout.',
      outputSchema: {
        outcome: z.enum(['approved', 'rejected', 'approved_with_notes', 'timeout']),
        note: z.string().optional(),
        humanChanges: z
          .array(historyEntryOutput)
          .describe('changes the human made during the review'),
        version: z.number(),
      },
      inputSchema: { summary: z.string(), focus: z.array(z.string()).optional() },
      annotations: { title: 'Request human review' },
    },
    async ({ summary, focus }, extra) => {
      // 保活：若 client 給了 progressToken，每 20s 送一次 progress 躲 idle timeout
      const token = extra?._meta?.progressToken as string | number | undefined;
      let keepalive: ReturnType<typeof setInterval> | null = null;
      if (token !== undefined && extra?.sendNotification) {
        keepalive = setInterval(() => {
          void extra
            .sendNotification({
              method: 'notifications/progress',
              params: { progressToken: token, progress: 0, message: 'waiting for review' },
            })
            .catch(() => {});
        }, 20_000);
      }
      try {
        const r = await reviews.request(summary, focus);
        return result(
          {
            outcome: r.outcome,
            note: r.note,
            humanChanges: r.humanChanges,
            version: store.version,
          },
          `review ${r.outcome}${r.note ? `: ${r.note}` : ''} (${r.humanChanges.length} human changes)`,
        );
      } finally {
        if (keepalive) clearInterval(keepalive);
      }
    },
  );

  // ---- 渲染 ----
  server.registerTool(
    'render',
    {
      description:
        'Render the project to a final mp4 (1080×1920, re-encoded). Returns the output path and URL. ' +
        'The exported length is the output duration (get_project total), not just the main track: whichever track ' +
        '(captions/audio/overlays included) reaches furthest sets the length, and the picture past the main track ' +
        'is black while captions/audio/overlays there still play. ' +
        '⚠️ Despite that, render still requires at least one clip on the main track — a caption- or audio-only ' +
        "project (main track empty) fails with 'timeline is empty' even though get_frame succeeds there with black " +
        'frames; do not infer render-ability from get_frame success. ' +
        'subtitles defaults to burn: captions are burned into the picture, always via the Pillow-rasterized PNG card ' +
        '— the same image the preview uses (with the per-word highlight that means one card per word, so many ' +
        'captions make rendering slower). ' +
        "Use 'embed' to let viewers toggle subtitles themselves (a soft track; subtitlesEmbedded is returned), or " +
        "'sidecar' for platforms that auto-translate subtitles (a separate .srt; subtitlePath is returned). " +
        'Every mode except burn leaves the picture clean — a soft track on top of burned-in captions shows the viewer ' +
        'two rows of text. ' +
        '⚠️ render is itself a write: it is refused while a review is in progress, and it records the render state in ' +
        'the project, so **the version advances** — an ifVersion you were holding is stale after a render and must be ' +
        're-read. ' +
        'In burn mode, more than 600 cards in total (per-word highlight means one card per word) rejects the whole ' +
        'render — re-run auto_caption with karaoke:false, or render in sections.',
      outputSchema: {
        output: z.string().describe('path of the rendered file, relative to the project folder'),
        url: z.string(),
        captionsBurned: z.boolean(),
        subtitles: z.enum(['burn', 'off', 'sidecar', 'embed']),
        subtitlePath: z.string().optional().describe('present in sidecar mode only'),
        subtitlesEmbedded: z.boolean(),
      },
      inputSchema: {
        stamp: z
          .string()
          .regex(/^[A-Za-z0-9._-]{1,64}$/)
          .optional()
          .describe(
            'Output file name (the result is output/<stamp>.mp4); defaults to render_<version>. ' +
              'Alphanumerics and . _ - only, because it *is* the file name — not a path, so no / and no ..',
          ),
        subtitles: z
          .enum(['burn', 'off', 'sidecar', 'embed'])
          .optional()
          .describe(
            'How subtitles are handled: burn = burned into the picture (default) / off = none / sidecar = a separate ' +
              '.srt / embed = an embedded soft track. Nothing is burned in except in burn mode. When the caption ' +
              'track is empty, sidecar/embed produce no subtitle file and no subtitle track.',
          ),
        // 尺寸的上下界與「奇數會被進位」都要講明：h264 的 yuv420p 不吃奇數維度，
        // 而只給單邊時另一邊是依畫布比例推算的（推算值本來就會取偶數）。
        width: z
          .number()
          .int()
          .min(16)
          .max(7680)
          .optional()
          .describe(
            'output width (defaults to the project canvas, 1080). An odd value is rounded up to even, because h264 does not accept odd dimensions',
          ),
        height: z
          .number()
          .int()
          .min(16)
          .max(7680)
          .optional()
          .describe(
            'output height (default 1920). When only one side is given, the other is derived from the canvas aspect ratio and is likewise made even',
          ),
        fps: z.number().positive().max(240).optional(),
        crf: z.number().min(0).max(51).optional().describe('quality; lower is better, default 20'),
        videoBitrate: z
          .string()
          .optional()
          .describe("e.g. '10M'; supplying it switches to bitrate mode"),
        codec: z.enum(['h264', 'hevc']).optional(),
      },
      annotations: { title: 'Render final video' },
    },
    async ({ stamp, ...exportOpts }) => {
      if (store.doc.review !== null) return err('error: a review is in progress');
      try {
        const s = stamp ?? `render_${store.version}`;
        const res = await render(store, projectDir, s, exportOpts);
        const mode = exportOpts.subtitles ?? 'burn';
        // 其他模式的「沒燒」是使用者要的，別報成問題。
        // ⚠️ burn 模式下 `captionsBurned === false` 的**唯一**成因是「專案的字幕軌是空的」：
        // `render()` 只在 `captions.length > 0 && subtitleMode === 'burn'` 時才產字卡，而
        // `renderCaptionCards()` 對每條 caption 至少回一張卡，所以 captionCards 空 ⟺ captions 空
        // （`buildRenderArgs` 的 `useCards = burnCaptions && captionCards.length > 0`）。
        // 「python3/Pillow 不在」與「字型候選鏈全滅」都**不會**走到這裡：前者讓
        // `spawn('python3', …)` 丟 ENOENT、後者由 `fontFallbackError()` reject，兩者都經
        // `mapLimit`（任一項 reject 就整體 reject）讓 `render()` 整個失敗，落到下面的 catch。
        // 下面 note 那句 'is python3/Pillow available?' 因此是**假診斷**——但它是執行期輸出，
        // 改它屬行為變更，已記進 `docs/ROADMAP.md` 第 11 條待專案擁有者裁決。
        const note =
          mode === 'burn'
            ? res.captionsBurned
              ? ''
              : ' (captions not burned: no text cards were produced — is python3/Pillow available?)'
            : res.subtitlePath
              ? ` (subtitles → ${res.subtitlePath})`
              : res.subtitlesEmbedded
                ? ' (subtitles embedded as a soft track)'
                : ' (no captions to export)';
        return result(
          {
            output: res.outPath,
            url: `${baseUrl}/media/${res.outPath}`,
            captionsBurned: res.captionsBurned,
            subtitles: mode,
            subtitlePath: res.subtitlePath,
            subtitlesEmbedded: res.subtitlesEmbedded,
          },
          `rendered → ${baseUrl}/media/${res.outPath}${note}`,
        );
      } catch (e) {
        store.mutate('ai', 'render error', (d) => {
          d.render = { status: 'error', error: (e as Error).message };
        });
        return err(`render failed: ${(e as Error).message}`);
      }
    },
  );

  const publishMetaInput = z.object({
    title: z.string().optional().describe('YouTube/Facebook title; TikTok/Instagram ignore it'),
    body: z.string().describe('caption / description text'),
    hashtags: z.array(z.string()).optional().describe('without the leading #'),
    kind: z
      .enum(['short', 'video'])
      .optional()
      .describe(
        'target form — affects the duration/size warnings only. Defaults: youtube→short, facebook→video; ' +
          'tiktok/instagram are always short. Pass video for a long-form YouTube/Facebook upload.',
      ),
  });

  server.registerTool(
    'export_publish_package',
    {
      description:
        'Package the finished render for manual upload: copies the output video plus cover and .srt into ' +
        'output/publish/<stamp>/, writes one text file per platform from the metadata you provide, and records ' +
        'per-platform duration/size warnings in manifest.json. No social platform API is called — the user ' +
        'uploads by hand (per-platform upload URLs are in the reply). Requires a completed render, and at least ' +
        'one platform. Re-running replaces the package for that render.',
      outputSchema: {
        version: z.number(),
        dir: z.string().describe('package directory, relative to the project folder'),
        files: z.array(z.string()),
        warnings: z
          .array(z.string())
          .describe('per-platform duration/size warnings; empty when clean'),
      },
      inputSchema: {
        tiktok: publishMetaInput.optional(),
        youtube: publishMetaInput.optional(),
        instagram: publishMetaInput.optional(),
        facebook: publishMetaInput.optional(),
        ifVersion: z.number().optional(),
      },
    },
    async ({ tiktok, youtube, instagram, facebook, ifVersion }) => {
      // 比照 auto_caption：真正的守衛在 aiWrite，這裡先擋掉注定失敗的呼叫，免得白做檔案工作。
      if (store.doc.review !== null) return err('error: a review is in progress');
      const meta: Partial<Record<PublishPlatform, PublishMeta>> = {
        ...(tiktok ? { tiktok } : {}),
        ...(youtube ? { youtube } : {}),
        ...(instagram ? { instagram } : {}),
        ...(facebook ? { facebook } : {}),
      };
      let info: PublishInfo;
      try {
        info = await buildPublishPackage(projectDir, store.doc, meta);
      } catch (e) {
        return err(`error: ${(e as Error).message}`);
      }
      const w = aiWrite(store, { name: 'setPublish', info }, ifVersion);
      if (!w.ok) return err(writeResultText(w));
      const urls = info.platforms.map((p) => `${p}: ${UPLOAD_URLS[p]}`).join(' | ');
      return result(
        { version: w.version, dir: info.dir, files: info.files, warnings: info.warnings },
        `${writeResultText(w)} | packaged ${info.files.length} file(s) into ${info.dir} — upload at ${urls}` +
          (info.warnings.length > 0 ? `\n⚠️ ${info.warnings.join('; ')}` : ''),
      );
    },
  );

  return server;
}

/** 掛 /mcp（Streamable HTTP，stateless：每請求 fresh server+transport）。 */
export function mountMcp(app: Express, deps: McpDeps): void {
  const handle = async (req: Request, res: Response) => {
    const server = createMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
  app.post('/mcp', handle);
  app.get('/mcp', handle);
  app.delete('/mcp', handle);
}
