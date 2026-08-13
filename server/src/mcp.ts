import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { AudioItem, HistoryBrief, OverlayItem, CaptionItem } from '@vidcut/shared';
import {
  totalDuration,
  overlayWindow,
  buildCaptionPages,
  DEFAULT_CAPTION_STYLE,
} from '@vidcut/shared';
import { transcribe } from './asr.js';
import type { ProjectStore } from './store.js';
import type { EditorContext } from './editorContext.js';
import type { ReviewManager } from './reviews.js';
import type { TextCardService } from './textCards.js';
import { aiWrite } from './aiWrite.js';
import { prepareMedia } from './ingest.js';
import { extractFrame } from './frame.js';
import { renderCoverImage, render } from './render.js';
import { listSource } from './sourceFolder.js';
import { resolveTextCommand } from './textOverlays.js';
import { CARD_LIMITS } from './cardBudget.js';

export interface McpDeps {
  store: ProjectStore;
  projectDir: string;
  editorContext: EditorContext;
  reviews: ReviewManager;
  /** 給 get_frame 組媒體 URL 用（如 http://127.0.0.1:3845） */
  baseUrl: string;
  /** add_overlay/update_overlay 帶 text 時用來產字卡（見 resolveTextCommand 前置） */
  textCards: TextCardService;
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

/** 專案裁剪視圖（避免超過 client 輸出上限）。 */
function projectSummary(store: ProjectStore) {
  const d = store.doc;
  return {
    version: store.version,
    name: d.name,
    canvas: d.canvas,
    total: totalDuration(d),
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
    ? `ok (no-op: 命令合法但沒有任何欄位改變), version=${r.version}`
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
    `${writeResultText(r)}\n⚠️ ${orphaned.length} 個 overlay 的 anchor 指向已不存在的 clip：` +
      `${orphaned.join(', ')}——它們在預覽與成品裡都不會顯示。` +
      '請用 update_overlay 換成新的 anchor，或改用絕對 start。',
  );
}

/** 建立註冊好全部工具的 McpServer（每個 HTTP 請求建一個，closure 共享 deps）。 */
export function createMcpServer(deps: McpDeps): McpServer {
  const { store, projectDir, editorContext, reviews, baseUrl, textCards } = deps;
  const server = new McpServer(
    { name: 'vidcut', version: '0.1.0' },
    {
      instructions:
        'vidcut is a timeline editor for vertical short video (1080×1920). Typical flow: ' +
        'list_source to see what is in a footage folder (dir must be absolute; imported flags what is already in) → ' +
        'import_media one file at a time (absolute paths outside the project are fine — nothing is copied) → ' +
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
        'Pass ifVersion on writes to avoid clobbering an edit the user just made; ' +
        'writes are rejected while a review is in progress (import_media, set_cover and render included — they are ' +
        'writes too), and if the review is rejected, every change made since it was requested is rolled back in one go.' +
        'A write that replies "no-op" means the command was valid but no field actually changed — usually the values ' +
        'sent match the current state.' +
        'The patch for update_clip / update_caption / update_overlay / update_audio is matched strictly: a misspelled ' +
        'field name returns a schema error rather than becoming a no-op.',
    },
  );

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
        total: z.number().optional().describe('total duration in seconds'),
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
      return result(
        s as unknown as Record<string, unknown>,
        `v${s.version}: ${s.clips.length} clips, total ${s.total.toFixed(1)}s`,
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
      const changes = store
        .history()
        .filter((h) => h.version > sinceVersion && h.source === 'human')
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

  server.registerTool(
    'get_frame',
    {
      description:
        "Extract the frame at a given time as JPEG — the AI's eyes. Clip picture only: overlays, captions and the " +
        'blur background are NOT composited in; to check those, render or ask the user to look at the UI preview. ' +
        'Does not change project state, but does write a JPEG under derived/frames/ (re-extracted on every call, ' +
        'not cached). time is clamped to [0, total duration]; returns an error when the main track is empty.',
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
        'Register a media file and build its derivatives (proxy/filmstrip/peaks). relPath may be relative to the ' +
        'project, or an absolute path outside it (referenced in place — nothing is copied). Audio-only files ' +
        '(mp3/wav…) can be imported directly: proxy/filmstrip are skipped, only peaks are built, and they are usable ' +
        'on the audio track (set_audio) only. Returns a mediaId.',
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
      // 早期守衛：proxy/filmstrip 是分鐘級的 ffmpeg 工作，別為了一個註定寫不進去的
      // 登記先跑完。真正的守衛在下面的 aiWrite——這個工具以前直接 store.mutate，
      // 兩層都沒走，所以**審核進行中照樣能把素材塞進專案**（實測 11 → 12 筆）。
      if (store.doc.review !== null) return err('error: a review is in progress');
      if (ifVersion !== undefined && ifVersion !== store.version)
        return err(`error: stale (ifVersion=${ifVersion}, current=${store.version})`);
      try {
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
        return result(
          { mediaId: m.id, probe: m.probe, version: w.version },
          `imported ${relPath} as ${m.id} (${m.probe.duration.toFixed(1)}s)`,
        );
      } catch (e) {
        return err(`import failed: ${(e as Error).message}`);
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
        'in+duration must not exceed the source length, volume within 0–2, and ids you supply must not repeat.',
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
        'one file at a time). Audio-only media is rejected: use set_audio for BGM/voiceover. Returns the new clipId.',
      outputSchema: { clipId: z.string(), version: z.number() },
      inputSchema: {
        mediaId: z.string(),
        in: z.number(),
        duration: z.number(),
        label: z.string().optional(),
        ifVersion: z.number().optional(),
      },
    },
    async ({ mediaId, in: clipIn, duration, label, ifVersion }) => {
      const cmd = { name: 'addClip', mediaId, in: clipIn, duration, label } as const;
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
        "Change one clip's in/duration/volume/label (its position in the main track is untouched). " +
        'Bounds are checked against the **post-patch** shape: in >= 0, duration >= 0.1s, in+duration must not exceed ' +
        'the source length, volume within 0–2. ' +
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
      description: '移除一張疊圖。',
      outputSchema: writeOutput,
      inputSchema: { id: z.string(), ifVersion: z.number().optional() },
    },
    async ({ id, ifVersion }) =>
      writeReply(aiWrite(store, { name: 'removeOverlay', id }, ifVersion)),
  );

  server.registerTool(
    'remove_audio',
    {
      description: '移除一個音訊項。',
      outputSchema: writeOutput,
      inputSchema: { id: z.string(), ifVersion: z.number().optional() },
    },
    async ({ id, ifVersion }) => writeReply(aiWrite(store, { name: 'removeAudio', id }, ifVersion)),
  );

  server.registerTool(
    'undo',
    {
      description:
        '撤回最近 N 筆編輯（游標式：連續呼叫一路往回退）。' +
        '**只有動到軌道與畫布的變更可撤回**——渲染、審核、封面（set_cover）與匯入素材' +
        '（import_media）都不進 undo 堆疊，撤不掉。可撤的不足 N 筆時撤到沒有為止；' +
        '一筆都沒有才回錯誤。' +
        '⚠️ undo 堆疊是**人與 AI 共用的一份**——你撤掉的可能是使用者剛剛做的調整。' +
        '不確定就先 get_history 看最近幾筆的 source。',
      outputSchema: writeOutput,
      inputSchema: {
        steps: z.number().int().min(1).optional().describe('撤回幾筆，預設 1'),
        ifVersion: z.number().optional(),
      },
    },
    async ({ steps, ifVersion }) => writeReply(aiWrite(store, { name: 'undo', steps }, ifVersion)),
  );

  server.registerTool(
    'redo',
    {
      description:
        '重做最近 N 筆被撤回的編輯（undo 的反向）。新的編輯會清空可重做的內容。' +
        '堆疊與人共用，注意事項同 undo。',
      outputSchema: writeOutput,
      inputSchema: {
        steps: z.number().int().min(1).optional().describe('重做幾筆，預設 1'),
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
        '對整條時間軸的聲音跑語音辨識（whisper.cpp），回傳逐詞時間戳。' +
        '時間是時間軸絕對秒數，可直接當字幕時間用，不必換算來源時間。' +
        '⚠️ 餵給辨識的**不是**成品混音：為了最大辨識度，片段音量、音訊項音量、淡入淡出與 ' +
        'ducking 一律被忽略——被靜音的片段（含 extract_audio 之後的原片段）裡的台詞照樣會辨識出來。' +
        '定格片段與無音軌素材以靜音佔位，所以時間對得上。時間軸完全沒有聲音時會失敗。' +
        '**不改專案狀態**，但會跑一次全時間軸混音（ffmpeg）再跑 whisper——分鐘級的操作，' +
        '而且會寫 derived/asr.wav 與 derived/asr.json（後者的路徑就是回傳的 jsonPath）。' +
        `要直接上字幕請用 auto_caption。逐詞結果超過 ${MAX_WORDS_INLINE} 詞、` +
        `或整份逐字稿超過 ${MAX_TEXT_INLINE} 字時只內嵌前段並標 truncated，全量在 jsonPath。`,
      outputSchema: {
        language: z.string(),
        wordCount: z.number().describe('全部的詞數（可能多於 words 的長度）'),
        words: z.array(transcriptWordOutput).describe('時間是時間軸絕對秒數'),
        wordsTruncated: z.boolean().optional(),
        text: z.string(),
        textTruncated: z.boolean().optional(),
        jsonPath: z.string().describe('全量結果的檔案路徑，相對專案資料夾'),
      },
      inputSchema: {
        language: z
          .string()
          .optional()
          .describe("'auto'（預設）或語言碼，如 zh / en / ja。指定語言通常比自動偵測準"),
      },
      // 刻意**不標** readOnlyHint：host 會拿它來免權限提示，而這支要跑分鐘級的 ffmpeg
      // ＋ whisper 並寫檔。「不改專案狀態」不等於「便宜且無副作用」。
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
        `逐字稿：${r.words.length} 個詞（語言 ${r.language}）` +
          (truncated || textTruncated ? `，內嵌已截斷，全量見 ${r.jsonPath}` : '') +
          `\n${r.text.slice(0, 400)}`,
      );
    },
  );

  server.registerTool(
    'auto_caption',
    {
      description:
        '一鍵自動字幕：辨識 → 分頁 → 寫入字幕軌（整組替換，原有字幕全部被取代）。' +
        '辨識跟 transcribe 走同一條路——分鐘級的 ffmpeg＋whisper，同樣會寫 derived/asr.wav ' +
        '與 derived/asr.json，同樣忽略音量與 ducking。' +
        'karaoke 預設開啟（逐詞高亮，渲染時一個詞一張字卡）。' +
        '想自己控制斷句就改用 transcribe + set_captions。' +
        `超過 ${MAX_CAPTIONS_INLINE} 句時回覆只內嵌前段並標 captionsTruncated` +
        '（寫入成功的話全量在文件裡，get_project 讀得到）。',
      outputSchema: {
        language: z.string(),
        wordCount: z.number(),
        captionCount: z.number().describe('產出的字幕總數（可能多於 captions 的長度）'),
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
          .describe('寫入結果。有 error 就代表字幕沒進文件（回覆同時會標 isError）'),
      },
      inputSchema: {
        language: z.string().optional(),
        karaoke: z.boolean().optional().describe('逐詞高亮，預設 true'),
        maxGapMs: z.number().optional().describe('詞間停頓超過此值換頁（預設 400）'),
        maxDurationMs: z.number().optional().describe('單頁最長毫秒（預設 2500）'),
        maxUnits: z.number().optional().describe('單頁寬度上限，中文字計 2（預設 24）'),
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
          .describe('覆寫字幕樣式；省略的欄位用預設'),
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
      const summary = `${writeResultText(write)}｜自動字幕 ${captions.length} 句 / ${r.words.length} 詞（${r.language}）`;
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
        '在時間軸某個時間點做粗剪動作：split（切開）、deleteBefore（刪除該時間之前的畫面）、' +
        'deleteAfter（刪除之後）、freeze（插入定格幀）。只影響影片主軌，磁性軌自動閉合縫隙。' +
        '⚠️ **只動主軌**的代價：字幕與音訊用的是時間軸絕對秒數，deleteBefore 之後畫面整個' +
        '往左移，字幕/音訊卻留在原地——會失步，要自己補 update_caption / update_audio。' +
        '（與 CapCut 同語意，不是 bug。）另外整段片段消失時，錨定在它上面的 overlay 會斷，' +
        '回覆會列出是哪幾個。' +
        'split 的切點必須嚴格落在片段內部，切完兩側各至少 0.1 秒，太靠邊會被拒；' +
        'freeze 插進去的定格片段是**無聲**的（會佔掉時間軸長度，後面的畫面整段右移）。',
      outputSchema: clipTrackOutput,
      inputSchema: {
        op: z.enum(['split', 'deleteBefore', 'deleteAfter', 'freeze']),
        time: z.number().describe('時間軸絕對秒數'),
        duration: z.number().optional().describe('freeze 的定格長度，預設 3 秒'),
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
        '把片段的聲音抽成獨立音訊項（片段音量歸零），之後可單獨調音量/淡化/刪除。' +
        '抽出的音訊項用**時間軸絕對時間**，不跟隨原片段搬動——之後重排或刪片段，' +
        '聲音會留在原處，要自己補 update_audio。素材沒有音軌時會被拒。',
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
        '整組設定音訊軌（放旁白/BGM；原有音訊項全部被取代，空陣列＝清空音訊軌）。' +
        'start 為時間軸絕對秒數；ducking 會在該項播放期間把影片原聲壓到四分之一。' +
        '逐項驗證、**任一項不合格就整批拒絕、文件完全不動**：mediaId 要存在、' +
        'start 與 in 要 >= 0、duration 要 > 0、volume 在 0–2、' +
        'fadeIn/fadeOut 不能超過 duration、in+duration 不能超過素材長度。' +
        '小修單一項請用 update_audio。',
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
        '調整單一音訊項（音量、淡入淡出、時間、ducking）。' +
        '規則是拿「**改完之後的樣子**」去驗，不是只驗你送的欄位——' +
        '例如只縮短 duration，卻讓既有的 fadeOut 超出新的 duration，這次呼叫就會被拒。' +
        '邊界同 set_audio。',
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
        '素材未填滿畫布時的處理：contain=黑邊、blur=模糊放大填充（把橫向素材放進 9:16 時建議用 blur）。',
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
        '設定封面圖：成品檔案還在時從成品抽該時間點的畫面（含 overlay 與字幕），' +
        '否則退回從來源素材抽（就只有片段畫面）。固定寫到 output/cover.jpg，' +
        '每次呼叫覆蓋同一個檔。回覆內嵌 JPEG，URL 與路徑在 structured 裡。',
      outputSchema: {
        coverPath: z.string().describe('相對專案資料夾'),
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
        '請使用者在瀏覽器 UI 審核目前的時間軸，阻塞直到核准/退回/逾時（預設 15 分鐘）。' +
        '回傳 outcome 與審核期間的人類變更。' +
        '⚠️ outcome 是 rejected 時，**自本次呼叫以來的變更會被整批回滾**' +
        '（回到送審當下的版本），不是只回一句「被退回」。' +
        '審核期間你的所有寫入都會被拒，只有使用者能改；核准/退回之後才恢復。' +
        '前一輪還沒結束就再呼叫一次，會把前一輪以 timeout 收掉。',
      outputSchema: {
        outcome: z.enum(['approved', 'rejected', 'approved_with_notes', 'timeout']),
        note: z.string().optional(),
        humanChanges: z.array(historyEntryOutput).describe('審核期間人做的變更'),
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
        '從專案輸出成品 mp4（1080×1920，重新編碼）。回傳輸出路徑與 URL。' +
        'subtitles 預設 burn＝字幕燒進畫面（一律走 Pillow 產的 PNG 字卡，跟預覽同一張圖；' +
        '逐詞高亮＝一個詞一張字卡，字幕很多時渲染會變慢）。' +
        "想讓觀眾自己開關字幕就用 'embed'（soft track，回傳 subtitlesEmbedded）；" +
        "要上傳到會自動翻譯字幕的平台就用 'sidecar'（另存 .srt，回傳 subtitlePath）。" +
        'burn 以外的模式畫面都是乾淨的——soft track 疊上燒錄會讓觀眾看到兩排字。' +
        '⚠️ render 本身也是寫入：審核進行中會被拒，而且它會把渲染狀態寫進專案，' +
        '**版本號會前進**——手上的 ifVersion 在 render 之後就過期了，要重讀。' +
        '主軌是空的會失敗；burn 模式的字卡總數（逐詞高亮＝一詞一張）超過 600 張時' +
        '整支拒絕渲染，改用 karaoke:false 重跑 auto_caption 或分段渲染。',
      outputSchema: {
        output: z.string().describe('成品路徑，相對專案資料夾'),
        url: z.string(),
        captionsBurned: z.boolean(),
        subtitles: z.enum(['burn', 'off', 'sidecar', 'embed']),
        subtitlePath: z.string().optional().describe('sidecar 模式才有'),
        subtitlesEmbedded: z.boolean(),
      },
      inputSchema: {
        stamp: z
          .string()
          .regex(/^[A-Za-z0-9._-]{1,64}$/)
          .optional()
          .describe(
            '輸出檔名（成品是 output/<stamp>.mp4），預設 render_<version>。' +
              '只能用英數與 . _ -，因為它就是檔名——不是路徑，不能有 / 或 ..。',
          ),
        subtitles: z
          .enum(['burn', 'off', 'sidecar', 'embed'])
          .optional()
          .describe(
            '字幕處理：burn=燒進畫面（預設）／off=不放／sidecar=另存 .srt／embed=內嵌 soft track。' +
              'burn 以外都不燒。字幕軌是空的時候 sidecar/embed 不會產生任何字幕檔或字幕軌。',
          ),
        // 尺寸的上下界與「奇數會被進位」都要講明：h264 的 yuv420p 不吃奇數維度，
        // 而只給單邊時另一邊是依畫布比例推算的（推算值本來就會取偶數）。
        width: z
          .number()
          .int()
          .min(16)
          .max(7680)
          .optional()
          .describe('輸出寬（預設用專案畫布 1080）。奇數會自動進位到偶數（h264 不吃奇數維度）'),
        height: z
          .number()
          .int()
          .min(16)
          .max(7680)
          .optional()
          .describe('輸出高（預設 1920）。只給單邊時另一邊依畫布比例推算，同樣取偶數'),
        fps: z.number().positive().max(240).optional(),
        crf: z.number().min(0).max(51).optional().describe('品質，越小越好，預設 20'),
        videoBitrate: z.string().optional().describe("如 '10M'；給了就用位元率模式"),
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
