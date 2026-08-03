import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nanoid } from 'nanoid';
import type { MediaAsset } from '@vidcut/shared';
import { probe, runFfmpeg } from './ffmpeg.js';
import type { ProjectStore } from './store.js';
import { resolveMediaPath } from './paths.js';

export interface IngestOpts {
  label?: string;
  meta?: Record<string, unknown>;
}

// 80 樣本/桶 @8kHz = 100 桶/秒：時間軸放大時波形仍有解析度
const PEAK_SAMPLES_PER_BUCKET = 80;
const PEAK_SAMPLE_RATE = 8000;

/**
 * 登記素材檔並產出衍生檔（proxy / filmstrip / peaks）。回傳 mediaId。
 * 素材檔須已在 projectDir 內（relPath 相對路徑）。冪等：同 relPath 重複呼叫回既有 id。
 * 詳見 spec §8.1。
 */
export async function ingestMedia(
  store: ProjectStore,
  projectDir: string,
  relPath: string,
  opts: IngestOpts = {},
): Promise<string> {
  const existing = store.doc.media.find((m) => m.path === relPath);
  if (existing) return existing.id;

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

    // 4. 登記（單一 mutation）
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
    store.mutate('ai', `import ${relPath}`, (d) => {
      d.media.push(asset);
    });
    return id;
  } catch (e) {
    await rm(derivedAbs, { recursive: true, force: true });
    throw e;
  }
}
