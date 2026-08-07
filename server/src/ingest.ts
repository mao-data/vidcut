import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import type { MediaAsset } from '@vidcut/shared';
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
 * 產出衍生檔（proxy / filmstrip / peaks）並組出 MediaAsset——**但不寫文件**。
 * 登記交給 `registerMedia` 命令（見 shared 的 Command 註解）：async 的重活留在這裡，
 * 命令層保持同步，於是 AI 那條路可以用 aiWrite 吃到審核鎖。
 *
 * 冪等：同一支檔重複呼叫回既有 id，而且**在跑任何 ffmpeg 之前**就判斷完。
 * 判斷用的是**解析後的絕對路徑**，不是字串相等——`doc.media` 裡相對路徑代表專案內、
 * 絕對路徑代表零複製外部引用，直接比字串的話同一支檔用兩種寫法各匯一次會變成兩筆。
 * （`sourceFolder.ts` 的 `imported` 早就是這樣比了，這裡以前沒跟上：list_source 說
 * 「已匯入」，import_media 卻還是幫你多建一筆。）
 *
 * 詳見 spec §8.1。
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
  const info = await probe(abs);
  const id = nanoid(8);
  const derivedRel = join('derived', id);
  const derivedAbs = join(projectDir, derivedRel);
  // 純音訊素材：沒有視訊流可做 proxy/filmstrip，只產 peaks（音訊軌播放直接用原始檔）。
  // 這道判定刻意排在 mkdir 之前——無可用串流時直接丟錯，不留下空的 derived/ 目錄。
  const audioOnly = info.hasVideo === false;
  if (audioOnly && !info.hasAudio) throw new Error(`no usable stream in ${relPath}`);
  await mkdir(derivedAbs, { recursive: true });
  try {
    // 1. proxy —— spec §8.1 精確參數；無音軌補 anullsrc
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
    proxyArgs.push('-movflags', '+faststart', join(derivedAbs, 'proxy.mp4'));
    if (!audioOnly) {
      await runFfmpeg(proxyArgs);

      // 2. filmstrip —— 每秒 1 幀單列 sprite
      const frames = Math.max(1, Math.ceil(info.duration));
      await runFfmpeg([
        '-i',
        abs,
        '-vf',
        `fps=1,scale=-2:80,tile=${frames}x1`,
        '-frames:v',
        '1',
        '-q:v',
        '3',
        join(derivedAbs, 'filmstrip.jpg'),
      ]);
    }

    // 3. peaks —— 8kHz mono s16le → 160 樣本/桶 max|amp| 正規化 0–1
    const pcmDir = await mkdtemp(join(tmpdir(), 'vidcut-pcm-'));
    // a.pcm 只是算 peaks 的中間產物，peaks.json 寫完就沒用了。用 finally 而不是把 rm
    // 排在最後一行：中途任何一步丟錯（ffmpeg 失敗、peaks.json 寫不進去）都必須清掉，
    // 否則每匯入一支素材就在系統 temp 漏一個目錄，且永遠不會自己消失。
    try {
      const pcmFile = join(pcmDir, 'a.pcm');
      const pcmSrc = info.hasAudio ? abs : join(derivedAbs, 'proxy.mp4'); // 無音軌用 proxy 的靜音軌
      await runFfmpeg([
        '-i',
        pcmSrc,
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

    // 4. 組出待登記的 asset（寫文件是呼叫端的事，見函式註解）
    const asset: MediaAsset = {
      id,
      path: relPath,
      ...(audioOnly
        ? {}
        : {
            proxyPath: join(derivedRel, 'proxy.mp4'),
            filmstripPath: join(derivedRel, 'filmstrip.jpg'),
          }),
      peaksPath: join(derivedRel, 'peaks.json'),
      probe: info,
      ...(opts.label ? { label: opts.label } : {}),
      ...(opts.meta ? { meta: opts.meta } : {}),
    };
    return { asset };
  } catch (e) {
    await rm(derivedAbs, { recursive: true, force: true });
    throw e;
  }
}

/**
 * 人的路徑：產衍生檔 + 登記，回 mediaId。走 `applyCommand` 而不是 aiWrite——
 * HTTP 上傳與 demo 建置都是使用者自己的動作，不該被他自己的審核擋住。
 * AI 那條路（MCP 的 import_media）自己組 prepareMedia + aiWrite，才吃得到審核鎖。
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
  return prepared.asset.id;
}
