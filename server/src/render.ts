import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Project } from '@vidcut/shared';
import { overlayWindow, totalDuration } from '@vidcut/shared';
import type { ProjectStore } from './store.js';

let drawtextAvailable: boolean | null = null;

/** 偵測本機 ffmpeg 是否有 drawtext（libfreetype）。快取結果。 */
export async function hasDrawtext(): Promise<boolean> {
  if (drawtextAvailable !== null) return drawtextAvailable;
  drawtextAvailable = await new Promise<boolean>((resolve) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-filters'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('close', () => resolve(/\bdrawtext\b/.test(out)));
    child.on('error', () => resolve(false));
  });
  return drawtextAvailable;
}

function esc(s: string): string {
  // drawtext text 轉義
  return s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export interface RenderPlan {
  args: string[];
  outPath: string;
  totalDuration: number;
  captionsBurned: boolean;
}

/**
 * 由 project.json 建構 ffmpeg 參數（spec §8.2）。
 * 影片：每片段 input-level -ss/-t 精確剪（一律重新編碼，不用 -c copy）→ scale/pad 1080×1920 → concat。
 * overlay PNG：overlay 濾鏡（time enable、位置由 0–1 換算）。
 * 音訊：有聲用片段聲音、無聲補 anullsrc → concat。
 * captions：drawtext 可用才燒（否則跳過並回報）。
 */
export function buildRenderArgs(
  project: Project,
  projectDir: string,
  outPath: string,
  opts: { hasDrawtext: boolean },
): RenderPlan {
  const { width, height, fps } = project.canvas;
  const clips = project.tracks.video;
  const overlays = project.tracks.overlays;
  const total = totalDuration(project);

  const args: string[] = [];
  // 每個 clip 一個 input（input-level trim）
  for (const clip of clips) {
    const media = project.media.find((m) => m.id === clip.mediaId);
    if (!media) throw new Error(`render: media not found for clip ${clip.id}`);
    args.push('-ss', String(clip.in), '-t', String(clip.duration), '-i', join(projectDir, media.path));
  }
  // overlay PNG inputs（在 clip inputs 之後）
  const overlayInputBase = clips.length;
  for (const ov of overlays) {
    args.push('-i', join(projectDir, ov.imagePath));
  }

  const fc: string[] = [];
  // 影片鏈
  clips.forEach((_clip, i) => {
    fc.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},setpts=PTS-STARTPTS[v${i}]`,
    );
  });
  const vlabels = clips.map((_c, i) => `[v${i}]`).join('');
  fc.push(`${vlabels}concat=n=${clips.length}:v=1:a=0[vcat]`);

  // 音訊鏈
  clips.forEach((clip, i) => {
    const media = project.media.find((m) => m.id === clip.mediaId)!;
    if (media.probe.hasAudio) {
      fc.push(`[${i}:a]volume=${clip.volume},asetpts=PTS-STARTPTS,aresample=44100[a${i}]`);
    } else {
      fc.push(
        `anullsrc=channel_layout=stereo:sample_rate=44100:d=${clip.duration}[a${i}]`,
      );
    }
  });
  const alabels = clips.map((_c, i) => `[a${i}]`).join('');
  fc.push(`${alabels}concat=n=${clips.length}:v=0:a=1[aout]`);

  // overlay 鏈
  let vcur = '[vcat]';
  overlays.forEach((ov, k) => {
    const win = overlayWindow(project, ov);
    if (!win) return;
    const inputIdx = overlayInputBase + k;
    const next = `[ovl${k}]`;
    const enable = `enable='between(t\\,${win.start}\\,${win.end})'`;
    const x = `(W*${ov.position.x})-(w/2)`;
    const y = `(H*${ov.position.y})`;
    fc.push(`${vcur}[${inputIdx}:v]overlay=x=${x}:y=${y}:${enable}${next}`);
    vcur = next;
  });

  // captions（drawtext 可用才燒）
  let captionsBurned = false;
  if (opts.hasDrawtext && project.tracks.captions.length > 0) {
    for (const cap of project.tracks.captions) {
      const next = `[cap_${cap.id}]`;
      const yExpr = `(h*${cap.style.y})`;
      const enable = `enable='between(t\\,${cap.start}\\,${cap.start + cap.duration})'`;
      const stroke = cap.style.stroke ? `:borderw=3:bordercolor=${cap.style.stroke}` : '';
      fc.push(
        `${vcur}drawtext=text='${esc(cap.text)}':fontsize=${cap.style.fontSize}:` +
          `fontcolor=${cap.style.fill}${stroke}:x=(w-text_w)/2:y=${yExpr}:${enable}${next}`,
      );
      vcur = next;
    }
    captionsBurned = true;
  }

  args.push(
    '-filter_complex',
    fc.join(';'),
    '-map',
    vcur,
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    outPath,
  );

  return { args, outPath, totalDuration: total, captionsBurned };
}

export interface RenderResult {
  outPath: string;
  captionsBurned: boolean;
}

/**
 * 執行渲染，解析 ffmpeg -progress 更新 store.render.progress。
 * 輸出到 projectDir/output/<stamp>.mp4（stamp 由呼叫端傳入以維持可測性）。
 */
export async function render(
  store: ProjectStore,
  projectDir: string,
  stamp: string,
): Promise<RenderResult> {
  const project = store.doc;
  if (project.tracks.video.length === 0) throw new Error('render: timeline is empty');
  const outDir = join(projectDir, 'output');
  await mkdir(outDir, { recursive: true });
  const outRel = join('output', `${stamp}.mp4`);
  const outPath = join(projectDir, outRel);

  const drawtext = await hasDrawtext();
  const plan = buildRenderArgs(project, projectDir, outPath, { hasDrawtext: drawtext });

  store.mutate('ai', 'render start', (d) => {
    d.render = { status: 'running', progress: 0 };
  });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      ['-hide_banner', '-y', ...plan.args, '-progress', 'pipe:1', '-nostats'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stdout.on('data', (d) => {
      const m = /out_time_ms=(\d+)/.exec(d.toString());
      if (m && plan.totalDuration > 0) {
        const sec = Number(m[1]) / 1_000_000;
        const progress = Math.min(1, sec / plan.totalDuration);
        store.mutate('ai', 'render progress', (doc) => {
          doc.render.progress = Number(progress.toFixed(3));
        });
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg render exited ${code}: ${stderr.slice(-2000)}`));
    });
  });

  store.mutate('ai', 'render done', (d) => {
    d.render = { status: 'done', progress: 1, lastOutput: outRel };
  });
  return { outPath: outRel, captionsBurned: plan.captionsBurned };
}
