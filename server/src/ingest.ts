import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import type { MediaAsset, ProbeInfo } from '@vidcut/shared';
import { filmstripPlan, proxyPlan } from '@vidcut/shared';
import { probe, runFfmpeg } from './ffmpeg.js';
import type { ProjectStore } from './store.js';
import { applyCommand } from './commands.js';
import { resolveMediaPath } from './paths.js';

export interface IngestOpts {
  label?: string;
  meta?: Record<string, unknown>;
}

// 80 樣本/桶 @8kHz = 100 桶/秒：時間軸放大時波形仍有解析度
const PEAK_SAMPLES_PER_BUCKET = 80;
const PEAK_SAMPLE_RATE = 8000;

/** `prepareMedia` 的結果：已經匯入過（回既有 id），或產好了一份待登記的素材。 */
export type PreparedMedia = { existingId: string } | { asset: MediaAsset };

/**
 * A0：probe 來源檔 + 組出**待登記**的裸 asset——**不寫文件、不跑任何衍生檔 ffmpeg**。
 * 秒級：只有一次 ffprobe（含 `probeKeyframeInterval` 的第二次 ffprobe，見 `ffmpeg.ts`）。
 * 登記交給 `registerMedia` 命令（見 shared 的 Command 註解）：這裡保持同步，於是 AI
 * 那條路可以用 aiWrite 吃到審核鎖。filmstrip/peaks（A1）與 proxy（A2）由呼叫端接著
 * 丟進背景佇列（見 `runDerivedStages`／`enqueueDerivedStages`）。
 *
 * 冪等：同一支檔重複呼叫回既有 id，而且**在跑任何 ffmpeg 之前**就判斷完。
 * 判斷用的是**解析後的絕對路徑**，不是字串相等——`doc.media` 裡相對路徑代表專案內、
 * 絕對路徑代表零複製外部引用，直接比字串的話同一支檔用兩種寫法各匯一次會變成兩筆。
 * （`sourceFolder.ts` 的 `imported` 早就是這樣比了，這裡以前沒跟上：list_source 說
 * 「已匯入」，import_media 卻還是幫你多建一筆。）
 *
 * 純音訊素材（`info.hasVideo === false`）沒有視訊流可做 proxy/filmstrip，仍然只在 A1
 * 產 peaks；此處只需在探測階段就確認至少有一個可用串流。
 *
 * 詳見 spec §8.1；三階段拆分見 docs/superpowers/plans/2026-08-20-fast-ingest.md。
 */
export async function prepareMedia(
  store: ProjectStore,
  projectDir: string,
  relPath: string,
  opts: IngestOpts = {},
): Promise<PreparedMedia> {
  const wanted = resolveMediaPath(projectDir, relPath);
  const existing = store.doc.media.find((m) => resolveMediaPath(projectDir, m.path) === wanted);
  if (existing) return { existingId: existing.id };

  const abs = resolveMediaPath(projectDir, relPath);
  // keyframes:true——A2 的 proxyPlan（remux vs transcode）判準需要 keyframeIntervalSec；
  // 這是唯一該扛這筆額外 ffprobe 成本的呼叫端（Plan 8 final review F4，見 ffmpeg.ts
  // 的 ProbeOpts 註解：render 路徑的 probe() 用不到這個數字，不該預設量測）。
  const info = await probe(abs, { keyframes: true });
  const audioOnly = info.hasVideo === false;
  if (audioOnly && !info.hasAudio) throw new Error(`no usable stream in ${relPath}`);

  const id = nanoid(8);
  const asset: MediaAsset = {
    id,
    path: relPath,
    probe: info,
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.meta ? { meta: opts.meta } : {}),
  };
  return { asset };
}

/**
 * A1 的檔案工作（store-free，素材庫入庫共用）：filmstrip 單列 sprite 寫進 derivedAbs。
 * 呼叫端保證 info.hasVideo !== false。回傳 filmstripPlan 算出的 tiles。
 */
export async function writeFilmstrip(
  abs: string,
  derivedAbs: string,
  info: ProbeInfo,
): Promise<number> {
  await mkdir(derivedAbs, { recursive: true });
  // filmstrip —— 單列 sprite，格數與取樣頻率由 filmstripPlan 決定。
  // 短片（≲7.7 分鐘 16:9）逐秒一格，跟以前行為一致；長片單列寬度會撞上
  // JPEG 編碼器 65500px 上限（實測 exit 234），filmstripPlan 把格數夾在
  // 上限內、改用 <1 的 fps 均勻降頻取樣，覆蓋整支影片而不是只取前段。
  const { tiles, fps } = filmstripPlan({
    durationSec: info.duration,
    width: info.width,
    height: info.height,
  });
  await runFfmpeg([
    '-i',
    abs,
    '-vf',
    // fps 用 toFixed 避免極小值被序列化成科學記號（ffmpeg 的 fps 濾鏡吃不了 1e-7）
    `fps=${fps.toFixed(6)},scale=-2:80,tile=${tiles}x1`,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    join(derivedAbs, 'filmstrip.jpg'),
  ]);
  return tiles;
}

/**
 * A1 的檔案工作（store-free，素材庫入庫共用）：peaks.json 寫進 derivedAbs。
 * 無音軌時用 anullsrc 合成同時長靜音來源（原因見原註解，一併搬來）。
 */
export async function writePeaks(abs: string, derivedAbs: string, info: ProbeInfo): Promise<void> {
  await mkdir(derivedAbs, { recursive: true });
  // peaks —— 8kHz mono s16le → 160 樣本/桶 max|amp| 正規化 0–1
  const pcmDir = await mkdtemp(join(tmpdir(), 'vidcut-pcm-'));
  // a.pcm 只是算 peaks 的中間產物，peaks.json 寫完就沒用了。用 finally 而不是把 rm
  // 排在最後一行：中途任何一步丟錯（ffmpeg 失敗、peaks.json 寫不進去）都必須清掉，
  // 否則每匯入一支素材就在系統 temp 漏一個目錄，且永遠不會自己消失。
  try {
    const pcmFile = join(pcmDir, 'a.pcm');
    // 峰值來源：原檔有音軌就直接吃原檔；沒有音軌（靜音影片）以前是吃 proxy 補的
    // anullsrc 靜音軌，但 A1 先於 A2 執行，這時 proxy 還沒產——改成自己用 anullsrc
    // 合成同樣時長的靜音來源，效果一致（peaks 全 0），且不必等 A2。
    const pcmArgs = info.hasAudio
      ? ['-i', abs]
      : [
          '-f',
          'lavfi',
          '-i',
          `anullsrc=r=${PEAK_SAMPLE_RATE}:cl=mono`,
          '-t',
          String(info.duration),
        ];
    await runFfmpeg([
      ...pcmArgs,
      '-ac',
      '1',
      '-ar',
      String(PEAK_SAMPLE_RATE),
      '-f',
      's16le',
      pcmFile,
    ]);
    const pcm = await readFile(pcmFile);
    // 每桶同時取 max（峰值包絡）與 RMS（能量核心）——雙層波形靠這兩個陣列
    const peaks: number[] = [];
    const rms: number[] = [];
    const step = PEAK_SAMPLES_PER_BUCKET * 2; // 2 bytes/sample
    for (let i = 0; i + 1 < pcm.length; i += step) {
      let max = 0;
      let sumSq = 0;
      let n = 0;
      for (let j = i; j < Math.min(i + step, pcm.length - 1); j += 2) {
        const v = pcm.readInt16LE(j);
        max = Math.max(max, Math.abs(v));
        sumSq += v * v;
        n++;
      }
      peaks.push(Number((max / 32768).toFixed(4)));
      rms.push(Number((Math.sqrt(sumSq / Math.max(1, n)) / 32768).toFixed(4)));
    }
    await writeFile(
      join(derivedAbs, 'peaks.json'),
      JSON.stringify({
        samplesPerBucket: PEAK_SAMPLES_PER_BUCKET,
        sampleRate: PEAK_SAMPLE_RATE,
        peaks,
        rms,
      }),
    );
  } finally {
    await rm(pcmDir, { recursive: true, force: true });
  }
}

/**
 * A2 的檔案工作（store-free，素材庫入庫共用）：依 mode 產 proxy.mp4。
 * mode 由呼叫端決定：專案路徑用 proxyPlan（skip 時根本不呼叫這裡）；
 * 素材庫一律 transcode（庫檔要能直接預覽、匯入專案後不依賴絕對路徑原檔的播放路徑）。
 */
export async function writeProxy(
  abs: string,
  derivedAbs: string,
  info: ProbeInfo,
  mode: 'remux' | 'transcode',
): Promise<void> {
  await mkdir(derivedAbs, { recursive: true });
  const proxyAbs = join(derivedAbs, 'proxy.mp4');

  if (mode === 'remux') {
    // 影像層面已合格，只是容器不對（例如 mkv 裝 h264）——秒級封裝，不重編碼。
    await runFfmpeg(['-i', abs, '-c', 'copy', '-movflags', '+faststart', proxyAbs]);
  } else {
    // transcode：spec §8.1 精確參數；無音軌補 anullsrc
    const proxyArgs = ['-i', abs];
    if (!info.hasAudio) proxyArgs.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
    proxyArgs.push(
      '-vf',
      'scale=-2:960:flags=bicubic,fps=30',
      '-c:v',
      'libx264',
      '-profile:v',
      'high',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-g',
      '15',
      '-keyint_min',
      '15',
      '-sc_threshold',
      '0',
      '-tune',
      'fastdecode',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ac',
      '2',
    );
    if (!info.hasAudio) proxyArgs.push('-shortest');
    proxyArgs.push('-movflags', '+faststart', proxyAbs);
    await runFfmpeg(proxyArgs);
  }
}

/**
 * A1：filmstrip（非純音訊）+ peaks——寫進 `derived/<mediaId>/`，完成後透過
 * `updateMediaDerived` 落盤。失敗**不拋、不清目錄**：呼叫端（背景佇列）只需要
 * console.error，素材本身（A0 已登記的原檔）照樣可用，見 Plan 8 範圍裁決 §2。
 *
 * 直接呼叫（不經佇列）時失敗會拋出——`ingestMediaFully` 靠這個把失敗傳上去。
 */
async function runFilmstripAndPeaks(
  store: ProjectStore,
  projectDir: string,
  mediaId: string,
  abs: string,
  info: ProbeInfo,
): Promise<void> {
  const derivedRel = join('derived', mediaId);
  const derivedAbs = join(projectDir, derivedRel);
  const audioOnly = info.hasVideo === false;
  const filmstripTiles = audioOnly ? undefined : await writeFilmstrip(abs, derivedAbs, info);
  await writePeaks(abs, derivedAbs, info);

  const patch: Pick<MediaAsset, 'peaksPath' | 'filmstripPath' | 'filmstripTiles'> = {
    peaksPath: join(derivedRel, 'peaks.json'),
    ...(audioOnly ? {} : { filmstripPath: join(derivedRel, 'filmstrip.jpg'), filmstripTiles }),
  };
  const r = applyCommand(store, 'human', { name: 'updateMediaDerived', mediaId, patch });
  if (!r.ok) throw new Error(`updateMediaDerived (A1) ${mediaId}: ${r.error}`);
}

/**
 * A2：proxy——判準來自 `proxyPlan`（shared）。純音訊素材沒有視訊流，整段跳過。
 * `skip`：不產任何檔案，`proxyPath` 永遠缺席。`remux`：`-c copy` 秒級封裝進
 * mp4（容器不對，但影像層面已經是 web-compatible）。`transcode`：現行完整參數。
 */
async function runProxy(
  store: ProjectStore,
  projectDir: string,
  mediaId: string,
  abs: string,
  info: ProbeInfo,
): Promise<void> {
  if (info.hasVideo === false) return; // 純音訊：無視訊流，不產 proxy

  const mode = proxyPlan({
    codec: info.codec,
    pixFmt: info.pixFmt,
    container: info.container,
    width: info.width,
    height: info.height,
    fps: info.fps,
    keyframeIntervalSec: info.keyframeIntervalSec,
  });
  if (mode === 'skip') return; // 來源已是瀏覽器可播的 H.264，播放/抽幀直接吃原檔

  const derivedRel = join('derived', mediaId);
  await writeProxy(abs, join(projectDir, derivedRel), info, mode);

  const r = applyCommand(store, 'human', {
    name: 'updateMediaDerived',
    mediaId,
    patch: { proxyPath: join(derivedRel, 'proxy.mp4') },
  });
  if (!r.ok) throw new Error(`updateMediaDerived (A2) ${mediaId}: ${r.error}`);
}

/**
 * 依序跑 A1（filmstrip+peaks）→ A2（proxy），**直接拋出**任何一階段的失敗。
 * 給 `ingestMediaFully` 與背景佇列共用：前者要「衍生失敗就整體失敗」，後者
 * 自己接住錯誤改成 console.error（見 `enqueueDerivedStages`）。
 */
async function runDerivedStages(
  store: ProjectStore,
  projectDir: string,
  mediaId: string,
  abs: string,
  info: ProbeInfo,
): Promise<void> {
  await runFilmstripAndPeaks(store, projectDir, mediaId, abs, info);
  await runProxy(store, projectDir, mediaId, abs, info);
}

// 背景衍生階段的模組級序列佇列：ffmpeg 不並行（與 app.ts `/api/import` 逐支序列處理
// 同一款紀律），同一素材 A1 先於 A2（`runDerivedStages` 內部順序），不同素材之間也
// 序列跑，避免多支素材的背景轉檔互搶 CPU、拖慢使用者當下正在剪的那一支。
// 鏈本身**永不 reject**（見 .then 的兩個分支都導回 undefined）：某支素材的背景階段
// 失敗不會卡死後面排隊的素材。
let derivedQueue: Promise<void> = Promise.resolve();

/**
 * 把一支素材的背景衍生階段（A1→A2）排進模組級佇列。**不等待**——呼叫端（`ingestMedia`
 * 與 MCP 的 `import_media`，見 `mcp.ts`）在這裡就回傳，讓 A0 的秒級體感成立。失敗只
 * `console.error`，不重試（P1 再談），素材本身在 A0 就已經可用。
 *
 * export 是因為 `import_media`（AI 路徑）自己組 `prepareMedia` + `aiWrite`，不經過
 * `ingestMedia`，登記成功後要用**同一條**模組級佇列排背景階段——兩條路徑各開一條佇列
 * 會讓人的匯入與 AI 的匯入的 ffmpeg 互相並行，違反「ffmpeg 不並行」的紀律。
 */
export function enqueueDerivedStages(
  store: ProjectStore,
  projectDir: string,
  mediaId: string,
  abs: string,
  info: ProbeInfo,
): void {
  derivedQueue = derivedQueue.then(
    () =>
      runDerivedStages(store, projectDir, mediaId, abs, info).catch((e: unknown) => {
        console.error(
          `ingest: background derive failed for media ${mediaId} (${abs}): ${(e as Error).message}`,
        );
      }),
    // 前一個任務不會 reject（上面那個 .catch 已經接住），這個分支理論上到不了，
    // 純粹是防禦性地維持「鏈永不斷」的不變量。
    () => undefined,
  );
}

/**
 * 測試專用：等佇列排空到「呼叫當下已入列的工作全部跑完」。**不保證**等到之後才
 * enqueue 的工作——回傳的是當下這個 tick 的 `derivedQueue` 參照，跟著它 await 到底。
 * 生產程式碼不需要這個（背景階段本來就不等），只有測試需要觀察「A0 回傳後，佇列排空
 * 三欄位是否齊全」。
 */
export async function waitForIngestQueue(): Promise<void> {
  await derivedQueue;
}

/**
 * 人的路徑：A0（probe + 登記，回 mediaId）——衍生檔（filmstrip/peaks/proxy）丟進
 * 背景佇列，不等待。走 `applyCommand` 而不是 aiWrite——HTTP 上傳與 demo 建置都是
 * 使用者自己的動作，不該被他自己的審核擋住。AI 那條路（MCP 的 import_media）自己組
 * `prepareMedia` + `aiWrite`，才吃得到審核鎖，登記成功後同樣把背景階段排進這條佇列。
 *
 * ⚠️ **語意變更**（Plan 8）：以前這個函式回傳時 proxy/filmstrip/peaks 全部就緒；
 * 現在回傳時**只有** A0 的原始 probe 資料。需要三者齊全的呼叫端（demo 建置、既有測試）
 * 請改用 `ingestMediaFully`。
 */
export async function ingestMedia(
  store: ProjectStore,
  projectDir: string,
  relPath: string,
  opts: IngestOpts = {},
): Promise<string> {
  const prepared = await prepareMedia(store, projectDir, relPath, opts);
  if ('existingId' in prepared) return prepared.existingId;
  const r = applyCommand(store, 'human', { name: 'registerMedia', asset: prepared.asset });
  if (!r.ok) throw new Error(`import ${relPath}: ${r.error}`);
  const abs = resolveMediaPath(projectDir, relPath);
  enqueueDerivedStages(store, projectDir, prepared.asset.id, abs, prepared.asset.probe);
  return prepared.asset.id;
}

/**
 * 三階段全部 await 完成才回傳：demo 建置與既有測試預期衍生檔（proxy/filmstrip/peaks）
 * 匯入完就已齊全，這條走完整同步等待，**衍生階段失敗會 throw**（不是背景佇列那種
 * console.error 靜默）——demo 要的是完整產物，測試也需要明確的失敗訊號。
 */
export async function ingestMediaFully(
  store: ProjectStore,
  projectDir: string,
  relPath: string,
  opts: IngestOpts = {},
): Promise<string> {
  const prepared = await prepareMedia(store, projectDir, relPath, opts);
  if ('existingId' in prepared) return prepared.existingId;
  const r = applyCommand(store, 'human', { name: 'registerMedia', asset: prepared.asset });
  if (!r.ok) throw new Error(`import ${relPath}: ${r.error}`);
  const abs = resolveMediaPath(projectDir, relPath);
  await runDerivedStages(store, projectDir, prepared.asset.id, abs, prepared.asset.probe);
  return prepared.asset.id;
}
