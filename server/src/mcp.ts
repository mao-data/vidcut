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
import { aiWrite } from './aiWrite.js';
import { ingestMedia } from './ingest.js';
import { extractFrame } from './frame.js';
import { extractCover, render } from './render.js';

export interface McpDeps {
  store: ProjectStore;
  projectDir: string;
  editorContext: EditorContext;
  reviews: ReviewManager;
  /** 給 get_frame 組媒體 URL 用（如 http://127.0.0.1:3845） */
  baseUrl: string;
}

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

function result(structured: Record<string, unknown>, summary: string) {
  return { content: [{ type: 'text' as const, text: summary }], structuredContent: structured };
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

const overlaySchema = z
  .object({
    id: z.string(),
    imagePath: z.string(),
    anchor: z.object({ clipId: z.string(), offset: z.number() }).optional(),
    start: z.number().optional(),
    duration: z.number().nullable(),
    position: z.object({ x: z.number(), y: z.number(), scale: z.number() }),
  })
  .strict();

const captionSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    start: z.number(),
    duration: z.number(),
    style: z.object({
      fontFamily: z.string(),
      fontSize: z.number(),
      fill: z.string(),
      stroke: z.string().optional(),
      y: z.number(),
      highlight: z.string().optional().describe('逐詞高亮色（有 tokens 時，已唸到的詞用這色）'),
    }),
    tokens: z
      .array(z.object({ text: z.string(), start: z.number(), end: z.number() }))
      .optional()
      .describe('逐詞時間戳（時間軸絕對秒數）。有值時渲染會做 karaoke 逐詞高亮。'),
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

function writeResultText(r: { ok: boolean; version?: number; error?: string }): string {
  return r.ok ? `ok, version=${r.version}` : `error: ${r.error}`;
}

/** 建立註冊好全部工具的 McpServer（每個 HTTP 請求建一個，closure 共享 deps）。 */
export function createMcpServer(deps: McpDeps): McpServer {
  const { store, projectDir, editorContext, reviews, baseUrl } = deps;
  const server = new McpServer(
    { name: 'vidcut', version: '0.1.0' },
    {
      instructions:
        'vidcut 直式短影音時間軸編輯器（1080×1920）。典型流程：import_media 匯入素材 → ' +
        'set_timeline 排片 → timeline_op 粗剪（split/deleteBefore/deleteAfter/freeze）→ ' +
        'set_overlays / set_captions 上字（講話類影片直接用 auto_caption 自動上字幕＋逐詞高亮）→ ' +
        'set_audio 放旁白或 BGM（ducking 會自動壓低原聲）→ ' +
        'request_review 請使用者在瀏覽器確認 → 依 get_feedback 的人類調整修改 → render 輸出。' +
        '橫向素材放進直式畫布時用 set_canvas_fit blur 比黑邊好看。' +
        'get_editor_context 可讀使用者當前選取與 playhead（他說「這段」時用得到）；' +
        'get_frame 可看某時刻的畫面；transcribe 可取逐字稿（詞時間戳＝時間軸秒數）來選段或自己排字幕。' +
        '寫入前可帶 ifVersion 避免蓋掉使用者剛做的修改；審核進行中寫入會被拒。',
    },
  );

  // ---- 讀取 ----
  server.registerTool(
    'get_project',
    {
      description:
        '取得專案裁剪總覽（clips/captions/media/version/review）；full:true 回完整 JSON。',
      inputSchema: { full: z.boolean().optional() },
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
        '抽出指定時間點的畫面 JPEG（AI 的「眼睛」；M3 僅片段畫面，M4 加 overlay 合成）。',
      inputSchema: { time: z.number() },
    },
    async ({ time }) => {
      const rel = await extractFrame(projectDir, store.doc, time);
      if (!rel) return text(`no active clip at ${time}s`);
      return result({ url: `${baseUrl}/media/${rel}`, path: rel }, `${baseUrl}/media/${rel}`);
    },
  );

  // ---- 匯入 / 排片 ----
  server.registerTool(
    'import_media',
    {
      description: '登記素材檔（須已放進專案資料夾）並產生 proxy/filmstrip/peaks。回 mediaId。',
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
        return text(`import failed: ${(e as Error).message}`);
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
      if (store.doc.review !== null) return text('error: a review is in progress');
      if (ifVersion !== undefined && ifVersion !== store.version)
        return text(`error: stale (ifVersion=${ifVersion}, current=${store.version})`);
      // 驗證 mediaId 存在
      for (const c of clips) {
        const media = store.doc.media.find((m) => m.id === c.mediaId);
        if (!media) return text(`error: unknown mediaId ${c.mediaId}`);
        if (c.in < 0 || c.duration <= 0 || c.in + c.duration > media.probe.duration + 1e-6) {
          return text(`error: clip out of bounds for ${c.mediaId}`);
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
      text(writeResultText(aiWrite(store, { name: 'updateClip', clipId, patch }, ifVersion))),
  );

  server.registerTool(
    'reorder_clips',
    {
      description: '重排主軌片段（order 為 clipId 的排列）。',
      inputSchema: { order: z.array(z.string()), ifVersion: z.number().optional() },
    },
    async ({ order, ifVersion }) =>
      text(writeResultText(aiWrite(store, { name: 'reorderClips', order }, ifVersion))),
  );

  server.registerTool(
    'remove_clip',
    {
      description: '移除片段。',
      inputSchema: { clipId: z.string(), ifVersion: z.number().optional() },
    },
    async ({ clipId, ifVersion }) =>
      text(writeResultText(aiWrite(store, { name: 'removeClip', clipId }, ifVersion))),
  );

  server.registerTool(
    'set_overlays',
    {
      description: '整組替換 overlay 軌。',
      inputSchema: { overlays: z.array(overlaySchema), ifVersion: z.number().optional() },
    },
    async ({ overlays, ifVersion }) =>
      text(
        writeResultText(
          aiWrite(store, { name: 'setOverlays', overlays: overlays as OverlayItem[] }, ifVersion),
        ),
      ),
  );

  server.registerTool(
    'set_captions',
    {
      description: '整組替換字幕軌。',
      inputSchema: { captions: z.array(captionSchema), ifVersion: z.number().optional() },
    },
    async ({ captions, ifVersion }) =>
      text(
        writeResultText(
          aiWrite(store, { name: 'setCaptions', captions: captions as CaptionItem[] }, ifVersion),
        ),
      ),
  );

  server.registerTool(
    'undo',
    { description: '撤回最近 N 筆變更。', inputSchema: { steps: z.number().optional() } },
    async ({ steps }) => text(writeResultText(aiWrite(store, { name: 'undo', steps }))),
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
    },
    async ({ language }) => {
      const r = await transcribe(store.doc, projectDir, { language });
      return result(
        {
          language: r.language,
          wordCount: r.words.length,
          words: r.words,
          text: r.text,
          jsonPath: r.jsonPath,
        },
        `逐字稿：${r.words.length} 個詞（語言 ${r.language}）\n${r.text.slice(0, 400)}`,
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
            fontSize: z.number().optional(),
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
      return text(writeResultText(aiWrite(store, cmd, ifVersion)));
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
      text(writeResultText(aiWrite(store, { name: 'extractAudio', clipId }, ifVersion))),
  );

  server.registerTool(
    'set_audio',
    {
      description: '整組設定音訊軌（放旁白/BGM）。start 為時間軸絕對秒數；ducking 會壓低影片原聲。',
      inputSchema: { audio: z.array(audioSchema), ifVersion: z.number().optional() },
    },
    async ({ audio, ifVersion }) =>
      text(
        writeResultText(
          aiWrite(store, { name: 'setAudio', audio: audio as AudioItem[] }, ifVersion),
        ),
      ),
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
      text(writeResultText(aiWrite(store, { name: 'updateAudio', id, patch }, ifVersion))),
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
      text(writeResultText(aiWrite(store, { name: 'setCanvasFit', fit }, ifVersion))),
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
        return result(
          { coverPath: rel, url: `${baseUrl}/media/${rel}` },
          `${baseUrl}/media/${rel}`,
        );
      } catch (e) {
        return text(`cover failed: ${(e as Error).message}`);
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
        '字幕會燒錄（本機無 drawtext 或有逐詞高亮時自動走 PNG 字卡）。' +
        '逐詞高亮＝一個詞一張字卡，字幕很多時渲染會變慢。',
      inputSchema: {
        stamp: z.string().optional(),
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
      if (store.doc.review !== null) return text('error: a review is in progress');
      try {
        const s = stamp ?? `render_${store.version}`;
        const res = await render(store, projectDir, s, exportOpts);
        return result(
          {
            output: res.outPath,
            url: `${baseUrl}/media/${res.outPath}`,
            captionsBurned: res.captionsBurned,
          },
          `rendered → ${baseUrl}/media/${res.outPath}${res.captionsBurned ? '' : ' (captions not burned: no drawtext)'}`,
        );
      } catch (e) {
        store.mutate('ai', 'render error', (d) => {
          d.render = { status: 'error', error: (e as Error).message };
        });
        return text(`render failed: ${(e as Error).message}`);
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
