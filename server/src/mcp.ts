import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Express, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { AudioItem, HistoryBrief, OverlayItem, CaptionItem } from '@vidcut/shared';
import { totalDuration, buildCaptionPages, DEFAULT_CAPTION_STYLE } from '@vidcut/shared';
import { transcribe } from './asr.js';
import type { ProjectStore } from './store.js';
import type { EditorContext } from './editorContext.js';
import type { ReviewManager } from './reviews.js';
import type { TextCardService } from './textCards.js';
import { aiWrite } from './aiWrite.js';
import { ingestMedia } from './ingest.js';
import { extractFrame } from './frame.js';
import { extractCover, render } from './render.js';
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

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

/** 應用層失敗：標 isError 讓模型能明確辨識（訊息本身與成功路徑同格式）。 */
function err(s: string) {
  return { content: [{ type: 'text' as const, text: s }], isError: true };
}

function result(structured: Record<string, unknown>, summary: string) {
  return { content: [{ type: 'text' as const, text: summary }], structuredContent: structured };
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

const clipPatchShape = {
  in: z.number().optional(),
  duration: z.number().optional(),
  volume: z.number().min(0).max(2).optional(),
  label: z.string().optional(),
};

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
        '自動換行寬度，相對畫布寬的分數（0.1–1），預設 0.9。' +
          '文字超過這個寬度會**自動折行**：中文逐字折、英數在空白處折（不會切進單字中間）、' +
          '字串裡真的 \\n 一律強制換行；單一超長不可斷字串（如網址）會逐字硬切。' +
          '調小＝更窄更多行，卡片會變高（卡片一律畫布全寬，高度隨行數長）。' +
          '⚠️ 行數會吃字卡的像素預算，而伺服器這側量不到字寬，只能取上界估算' +
          '（「每個字元各佔一行」與「每個字元最寬 3 em」兩者取較緊的那個）——' +
          '所以很長的文字可能被拒絕（錯誤訊息會告訴你估到的尺寸），縮短文字或縮小 fontSize 即可。',
      ),
  })
  .strict();

const overlaySchema = z
  .object({
    id: z.string(),
    imagePath: z
      .string()
      .optional()
      .describe('純圖 overlay 專用：外部腳本產好的 PNG 路徑。文字 overlay 不要給（見 text）。'),
    text: overlayTextSchema
      .optional()
      .describe(
        '可編輯文字 overlay：伺服器自動產字卡並填 imagePath，之後改字直接送新 text。' +
          'text 與 imagePath 恰好給一個：給 text 就別給 imagePath（會被伺服器算出的路徑取代），' +
          '給 imagePath 就是純圖 overlay（外部腳本產的 PNG，文字不可編輯）。',
      ),
    anchor: z.object({ clipId: z.string(), offset: z.number() }).optional(),
    start: z.number().optional(),
    duration: z.number().nullable(),
    position: z
      .object({ x: z.number(), y: z.number(), scale: z.number() })
      .describe(
        '相對畫布。注意不對稱：x 是圖片「水平中心」、y 是圖片「上緣」。' +
          '滿版直式圖要用 {x:0.5, y:0, scale:1}（y:0.5 會把圖推到下半場外）。' +
          'x/y 不限定 0–1：可以部分掛在畫布外（y 為負＝掛在上緣外），超出的部分成品與' +
          '預覽都會被裁掉、行為一致；只驗有限性不驗範圍，設更極端的值會讓元素完全看不見。' +
          '人在 UI 拖曳時夾制在「中心留在畫布內」＝每邊最多露一半。' +
          'scale 是倍率（1＝圖片原生尺寸），繞著「上緣中點」縮放：x/y 錨點不動，' +
          '成品與預覽都會照這個倍率縮（2026-08-04 起渲染端真的實作了，之前只有預覽吃）。' +
          'scale 限 0–10：負值會被拒（預覽是鏡像、成品整張不合成，是真的預覽≠成品），' +
          '過大值會在 ffmpeg 端炸記憶體。scale=0 仍可用（兩邊都是看不見）。',
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
            '文字 overlay 不要給 imagePath——伺服器產完字卡會自己填。' +
            '（舊介面要求傳空字串佔位，現已改為整個省略。）',
        });
    } else if (o.imagePath === undefined || o.imagePath === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['imagePath'],
        message:
          '要嘛給 text（文字 overlay，伺服器產卡），要嘛給非空的 imagePath（純圖 overlay）。',
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
  highlight: z.string().optional().describe('逐詞高亮色（有 tokens 時，已唸到的詞用這色）'),
});

const captionTokensSchema = z
  .array(z.object({ text: z.string(), start: z.number(), end: z.number() }))
  .describe('逐詞時間戳（時間軸絕對秒數）。有值時渲染會做 karaoke 逐詞高亮。');

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
    fadeIn: z.number().min(0).optional(),
    fadeOut: z.number().min(0).optional(),
    ducking: z.boolean().optional(),
    label: z.string().optional(),
  })
  .strict();

const timelineClipSchema = z.object({
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

function writeResultText(r: { ok: boolean; version?: number; error?: string }): string {
  return r.ok ? `ok, version=${r.version}` : `error: ${r.error}`;
}

/** 寫入類工具的統一回覆：成功回文字、失敗回 isError。 */
function writeReply(r: { ok: boolean; version?: number; error?: string }) {
  return r.ok ? text(writeResultText(r)) : err(writeResultText(r));
}

/** 建立註冊好全部工具的 McpServer（每個 HTTP 請求建一個，closure 共享 deps）。 */
export function createMcpServer(deps: McpDeps): McpServer {
  const { store, projectDir, editorContext, reviews, baseUrl, textCards } = deps;
  const server = new McpServer(
    { name: 'vidcut', version: '0.1.0' },
    {
      instructions:
        'vidcut 直式短影音時間軸編輯器（1080×1920）。典型流程：' +
        'list_source 看素材夾裡有什麼（dir 為絕對路徑，imported 標示已匯入者）→ ' +
        'import_media 逐支匯入（可直接引用專案外的絕對路徑，零複製）→ ' +
        'set_timeline 初次排片，或 add_clip 逐支接到主軌尾端（不動既有片段）→ ' +
        'timeline_op 粗剪（split/deleteBefore/deleteAfter/freeze）→ ' +
        'set_overlays / set_captions 上字（講話類影片直接用 auto_caption 自動上字幕＋逐詞高亮）→ ' +
        'set_audio 放旁白或 BGM（ducking 會自動壓低原聲）→ ' +
        'request_review 請使用者在瀏覽器確認 → 依 get_feedback 的人類調整修改 → render 輸出。' +
        '純音訊素材（mp3/wav…）只能上音訊軌，add_clip 與 set_timeline 會擋下它。' +
        'render 的 subtitles 預設 burn（字幕燒進畫面）；要讓觀眾自己開關就用 embed，' +
        '要上傳到會自動翻譯字幕的平台就用 sidecar（另存 .srt），burn 以外畫面都乾淨。' +
        '橫向素材放進直式畫布時用 set_canvas_fit blur 比黑邊好看。' +
        '疊圖分兩種，text 與 imagePath 恰好給一個：文字類用 add_overlay/update_overlay/set_overlays 帶 ' +
        'text（伺服器自動產字卡並維護 imagePath，不要自己給，之後改字直接送新 text）；' +
        '純圖 overlay 自己給 imagePath、不給 text（外部腳本產的 PNG，文字不可編輯）——' +
        '對純圖 overlay 送 update_overlay + text 會被拒絕（不會偷偷把它換成文字卡），' +
        '真要轉型請 remove_overlay + add_overlay。' +
        'update_caption 整句平移（duration 不變只改 start）時，該句的 tokens' +
        '（逐詞時間戳＝時間軸絕對秒數）會自動一起平移；修邊（改 duration）則不動詞時間。' +
        '文字 overlay 與字幕都會**自動換行**：預設折在畫布寬的 90%（文字 overlay 可用 maxWidth 調），' +
        '中文逐字折、英數在空白處折、字串裡的 \\n 強制換行——不必自己算要斷在哪。' +
        '文字太長或字級太大導致字卡超過像素預算時，寫入會被拒絕（錯誤訊息會寫出估到的尺寸；' +
        '行數取的是上界估算，實際折出來通常少很多）。' +
        'get_editor_context 可讀使用者當前選取與 playhead（他說「這段」時用得到）；' +
        'get_frame 可看某時刻的畫面（回覆內嵌 JPEG）；transcribe 可取逐字稿（詞時間戳＝時間軸秒數）來選段或自己排字幕。' +
        '小修單一項目用細粒度工具（update_caption / update_overlay / add_overlay / remove_overlay / remove_audio），' +
        '不要整組重送 set_*。寫入前可帶 ifVersion 避免蓋掉使用者剛做的修改；審核進行中寫入會被拒。',
    },
  );

  // ---- 讀取 ----
  server.registerTool(
    'get_project',
    {
      description:
        '取得專案裁剪總覽（clips/captions/media/version/review）；full:true 回完整 JSON。',
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
      description: '最近的變更記錄（version/label/source/ts）。',
      inputSchema: { limit: z.number().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const h = store
        .history()
        .slice(-(limit ?? 30))
        .map((e): HistoryBrief => ({
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
      description: '自指定 version 以來的人類變更摘要（AI 讀回使用者的調整）。',
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
      description: '人在 UI 的當前選取、playhead 位置、拖選時間範圍。',
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
        '抽出指定時間點的畫面 JPEG（AI 的「眼睛」）。只有片段畫面——不合成 overlay/字幕/blur 背景；' +
        '要驗證這些請 render 或請使用者看 UI 預覽。',
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
        '列出素材夾內可匯入的檔案（不遞迴、排除隱藏檔、只回白名單副檔名）。' +
        'dir 為絕對路徑。imported 標示該檔是否已在本專案的 doc.media 裡。' +
        `超過 ${MAX_FILES_INLINE} 筆只內嵌前段並標 truncated。`,
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
            (truncated ? `，僅內嵌前 ${MAX_FILES_INLINE} 筆` : ''),
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
        '登記素材檔並產生衍生檔（proxy/filmstrip/peaks）。relPath 可為專案內相對路徑，' +
        '也可為專案外的絕對路徑（零複製引用，原檔留在原地）。純音訊（mp3/wav…）可直接' +
        '匯入，跳過 proxy/filmstrip 只產 peaks，僅供音訊軌（set_audio）使用。回 mediaId。',
      inputSchema: {
        relPath: z.string(),
        label: z.string().optional(),
        meta: z.record(z.unknown()).optional(),
      },
    },
    async ({ relPath, label, meta }) => {
      try {
        const id = await ingestMedia(store, projectDir, relPath, { label, meta });
        const m = store.doc.media.find((x) => x.id === id)!;
        return result(
          { mediaId: id, probe: m.probe },
          `imported ${relPath} as ${id} (${m.probe.duration.toFixed(1)}s)`,
        );
      } catch (e) {
        return err(`import failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'set_timeline',
    {
      description: '整組設定影片主軌（初次排片）。clips 依序為播放順序。',
      inputSchema: { clips: z.array(timelineClipSchema), ifVersion: z.number().optional() },
    },
    async ({ clips, ifVersion }) => {
      // 用 aiWrite 的守衛，但 set_timeline 不是既有 command；先檢查守衛條件再直接 mutate
      if (store.doc.review !== null) return err('error: a review is in progress');
      if (ifVersion !== undefined && ifVersion !== store.version)
        return err(`error: stale (ifVersion=${ifVersion}, current=${store.version})`);
      // 驗證 mediaId 存在
      for (const c of clips) {
        const media = store.doc.media.find((m) => m.id === c.mediaId);
        if (!media) return err(`error: unknown mediaId ${c.mediaId}`);
        if (media.probe.hasVideo === false) {
          return err(`error: ${c.mediaId} is audio-only — put it on the audio track (set_audio)`);
        }
        if (c.in < 0 || c.duration <= 0 || c.in + c.duration > media.probe.duration + 1e-6) {
          return err(`error: clip out of bounds for ${c.mediaId}`);
        }
      }
      const r = store.mutate('ai', 'set timeline', (d) => {
        d.tracks.video = clips.map((c, i) => ({
          id: `clip_${i}_${c.mediaId}`,
          mediaId: c.mediaId,
          in: c.in,
          duration: c.duration,
          volume: c.volume ?? 1,
          ...(c.label ? { label: c.label } : {}),
          ...(c.meta ? { meta: c.meta } : {}),
        }));
      });
      return result(
        { version: r.version, clips: clips.length },
        `set ${clips.length} clips, v${r.version}`,
      );
    },
  );

  server.registerTool(
    'add_clip',
    {
      description:
        '把已匯入的素材接到主軌尾端（不動既有片段，適合逐支加片）。' +
        '純音訊素材會被拒——放 BGM／旁白請用 set_audio。回新 clip 的 clipId。',
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
      description: '修改片段 in/duration/volume/label（會驗證 trim 邊界）。',
      inputSchema: {
        clipId: z.string(),
        patch: z.object(clipPatchShape),
        ifVersion: z.number().optional(),
      },
    },
    async ({ clipId, patch, ifVersion }) =>
      writeReply(aiWrite(store, { name: 'updateClip', clipId, patch }, ifVersion)),
  );

  server.registerTool(
    'reorder_clips',
    {
      description: '重排主軌片段（order 為 clipId 的排列）。',
      inputSchema: { order: z.array(z.string()), ifVersion: z.number().optional() },
    },
    async ({ order, ifVersion }) =>
      writeReply(aiWrite(store, { name: 'reorderClips', order }, ifVersion)),
  );

  server.registerTool(
    'remove_clip',
    {
      description: '移除片段。',
      inputSchema: { clipId: z.string(), ifVersion: z.number().optional() },
    },
    async ({ clipId, ifVersion }) =>
      writeReply(aiWrite(store, { name: 'removeClip', clipId }, ifVersion)),
  );

  server.registerTool(
    'set_overlays',
    {
      description:
        '整組替換 overlay 軌。每個項目 text 與 imagePath 恰好給一個：帶 text 的自動產字卡並填 ' +
        'imagePath（不要自己給）；純圖項目給實際 imagePath。',
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
      description: '整組替換字幕軌。',
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
        '只改一句字幕（text/start/duration/style/tokens）。小修用這個，別用 set_captions 整組重送。' +
        'style 提供時整組替換；tokens 給 [] 代表清除逐詞時間戳。' +
        '⚠️ 有 tokens 的句子改 text 要**同時**送 tokens（清成 [] 或給對得上新文字的一組），' +
        '只送 text 是靜默 no-op（字卡照 tokens 排版，根本不看 text）——見 patch.text 的說明。' +
        'tokens（逐詞時間戳）存的是時間軸絕對秒數，伺服器只在「整句平移」時自動幫你一起移：' +
        '只給 start（或給了 start 且 duration 不變）＝整句搬到別的時間點，每個詞的 start/end ' +
        '平移同樣的差值，不必自己重算。修邊則完全不動詞時間：只給 duration（縮尾巴）、' +
        '或同時給 start 與 duration 且 duration 跟著變（縮頭：右緣不動、start 往後）——' +
        '那是在改「這句顯示多久」，不是改「哪個字什麼時候被唸出來」。' +
        '同一次呼叫若也給了 tokens，則以你給的為準（不再平移）。',
      inputSchema: {
        id: z.string(),
        patch: z
          .object({
            text: z
              .string()
              .optional()
              .describe(
                '⚠️ 這句**有 tokens 時，只改 text 是靜默 no-op**：字卡是照 tokens 排版的' +
                  '（有 tokens 就完全不看 text），畫面不會有任何變化也不會報錯。' +
                  '改字請一併送 `tokens: []` 清掉舊的詞邊界——它們本來就對不上新文字了；' +
                  '要保留逐詞高亮就自己給一組對得上新文字的 tokens。',
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
        '只改一張疊圖（start/anchor/duration/position/text）。start 與 anchor 互斥：給哪個就轉成哪種定位。' +
        '文字 overlay 改字/樣式就送新 text（伺服器重新產卡並更新 imagePath，不必也不該自己給 imagePath）。',
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
                '整份換掉（沒有單欄位 patch 語意）。x=水平中心、y=上緣（不對稱）。' +
                  'x/y 不限定 0–1：可以部分掛在畫布外（y 為負＝掛在上緣外），超出的部分' +
                  '成品與預覽都會被裁掉、行為一致。' +
                  'scale=倍率繞上緣中點縮放，成品與預覽一致；限 0–10，負值會被拒' +
                  '（預覽是鏡像、成品整張不合成），scale=0 兩邊都是看不見。',
              ),
            text: overlayTextSchema
              .optional()
              .describe(
                '改文字內容/樣式：伺服器會重新產卡並更新 imagePath。只能用在本來就是文字 overlay ' +
                  '（建立時就帶 text）的項目；對純圖 overlay 送 text 會被拒絕（不會把它轉成文字卡、' +
                  '不會覆蓋它的 imagePath），真要轉型請 remove_overlay + add_overlay。',
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
        '新增單張疊圖（其他 overlay 不動）。text 與 imagePath 恰好給一個：文字類 overlay 帶 text ' +
        '（伺服器自動產字卡並維護 imagePath，不要自己給）；純圖 overlay 給實際 imagePath。',
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
      inputSchema: { id: z.string(), ifVersion: z.number().optional() },
    },
    async ({ id, ifVersion }) =>
      writeReply(aiWrite(store, { name: 'removeOverlay', id }, ifVersion)),
  );

  server.registerTool(
    'remove_audio',
    {
      description: '移除一個音訊項。',
      inputSchema: { id: z.string(), ifVersion: z.number().optional() },
    },
    async ({ id, ifVersion }) => writeReply(aiWrite(store, { name: 'removeAudio', id }, ifVersion)),
  );

  server.registerTool(
    'undo',
    {
      description: '撤回最近 N 筆編輯（游標式：連續呼叫一路往回退）。渲染/審核等狀態變更不在範圍。',
      inputSchema: { steps: z.number().optional() },
    },
    async ({ steps }) => writeReply(aiWrite(store, { name: 'undo', steps })),
  );

  server.registerTool(
    'redo',
    {
      description: '重做最近 N 筆被撤回的編輯（undo 的反向）。新的編輯會清空可重做的內容。',
      inputSchema: { steps: z.number().optional() },
    },
    async ({ steps }) => writeReply(aiWrite(store, { name: 'redo', steps })),
  );

  // ---- 逐字稿與自動字幕 ----

  server.registerTool(
    'transcribe',
    {
      description:
        '對「時間軸目前的混音」跑語音辨識（whisper.cpp），回傳逐詞時間戳。' +
        '時間是時間軸絕對秒數，可直接當字幕時間用，不必換算來源時間。' +
        '只讀不寫。要直接上字幕請用 auto_caption。',
      inputSchema: {
        language: z
          .string()
          .optional()
          .describe("'auto'（預設）或語言碼，如 zh / en / ja。指定語言通常比自動偵測準"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ language }) => {
      const r = await transcribe(store.doc, projectDir, { language });
      const truncated = r.words.length > MAX_WORDS_INLINE;
      return result(
        {
          language: r.language,
          wordCount: r.words.length,
          words: truncated ? r.words.slice(0, MAX_WORDS_INLINE) : r.words,
          ...(truncated ? { wordsTruncated: true } : {}),
          text: r.text,
          jsonPath: r.jsonPath,
        },
        `逐字稿：${r.words.length} 個詞（語言 ${r.language}）` +
          (truncated ? `，僅內嵌前 ${MAX_WORDS_INLINE} 詞，全量見 ${r.jsonPath}` : '') +
          `\n${r.text.slice(0, 400)}`,
      );
    },
  );

  server.registerTool(
    'auto_caption',
    {
      description:
        '一鍵自動字幕：辨識 → 分頁 → 寫入字幕軌（整組替換）。' +
        'karaoke 預設開啟（逐詞高亮，渲染時一個詞一張字卡）。' +
        '想自己控制斷句就改用 transcribe + set_captions。',
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
      const r = await transcribe(store.doc, projectDir, { language });
      const captions = buildCaptionPages(
        r.words,
        { karaoke, maxGapMs, maxDurationMs, maxUnits },
        { ...DEFAULT_CAPTION_STYLE, ...style },
      );
      const write = aiWrite(store, { name: 'setCaptions', captions }, ifVersion);
      return result(
        {
          language: r.language,
          wordCount: r.words.length,
          captionCount: captions.length,
          captions,
          write: write.ok ? { version: write.version } : { error: write.error },
        },
        `${writeResultText(write)}｜自動字幕 ${captions.length} 句 / ${r.words.length} 詞（${r.language}）`,
      );
    },
  );

  // ---- 播放頭操作（粗剪主力）----
  server.registerTool(
    'timeline_op',
    {
      description:
        '在時間軸某個時間點做粗剪動作：split（切開）、deleteBefore（刪除該時間之前的畫面）、' +
        'deleteAfter（刪除之後）、freeze（插入定格幀）。只影響影片主軌，磁性軌自動閉合縫隙。',
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
      return writeReply(aiWrite(store, cmd, ifVersion));
    },
  );

  // ---- 音訊 ----
  server.registerTool(
    'extract_audio',
    {
      description: '把片段的聲音抽成獨立音訊項（片段轉靜音），之後可單獨調音量/淡化/刪除。',
      inputSchema: { clipId: z.string(), ifVersion: z.number().optional() },
    },
    async ({ clipId, ifVersion }) =>
      writeReply(aiWrite(store, { name: 'extractAudio', clipId }, ifVersion)),
  );

  server.registerTool(
    'set_audio',
    {
      description: '整組設定音訊軌（放旁白/BGM）。start 為時間軸絕對秒數；ducking 會壓低影片原聲。',
      inputSchema: { audio: z.array(audioSchema), ifVersion: z.number().optional() },
    },
    async ({ audio, ifVersion }) =>
      writeReply(aiWrite(store, { name: 'setAudio', audio: audio as AudioItem[] }, ifVersion)),
  );

  server.registerTool(
    'update_audio',
    {
      description: '調整單一音訊項（音量、淡入淡出、時間、ducking）。',
      inputSchema: {
        id: z.string(),
        patch: z.object({
          start: z.number().optional(),
          in: z.number().optional(),
          duration: z.number().optional(),
          volume: z.number().min(0).max(2).optional(),
          fadeIn: z.number().min(0).optional(),
          fadeOut: z.number().min(0).optional(),
          ducking: z.boolean().optional(),
        }),
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
      inputSchema: { fit: z.enum(['contain', 'blur']), ifVersion: z.number().optional() },
    },
    async ({ fit, ifVersion }) =>
      writeReply(aiWrite(store, { name: 'setCanvasFit', fit }, ifVersion)),
  );

  server.registerTool(
    'set_cover',
    {
      description: '設定封面圖（從已渲染成品或來源素材抽該時間點的畫面）。回傳圖片 URL。',
      inputSchema: { time: z.number() },
    },
    async ({ time }) => {
      try {
        const rel = await extractCover(store, projectDir, time);
        return imageReply(
          join(projectDir, rel),
          { coverPath: rel, url: `${baseUrl}/media/${rel}` },
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
        '請使用者在瀏覽器 UI 審核目前的時間軸，阻塞直到核准/退回/逾時。回傳 outcome 與審核期間的人類變更。',
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
        'burn 以外的模式畫面都是乾淨的——soft track 疊上燒錄會讓觀眾看到兩排字。',
      inputSchema: {
        stamp: z.string().optional(),
        subtitles: z
          .enum(['burn', 'off', 'sidecar', 'embed'])
          .optional()
          .describe(
            '字幕處理：burn=燒進畫面（預設）／off=不放／sidecar=另存 .srt／embed=內嵌 soft track。' +
              'burn 以外都不燒。字幕軌是空的時候 sidecar/embed 不會產生任何字幕檔或字幕軌。',
          ),
        width: z.number().optional().describe('輸出寬（預設用專案畫布 1080）'),
        height: z.number().optional().describe('輸出高（預設 1920）'),
        fps: z.number().optional(),
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
        // burn 模式下沒燒成功才值得警告（字卡一張都沒產出來——python3/Pillow 不在、
        // 或字型表是空的）；其他模式的「沒燒」是使用者要的，別報成問題。
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
