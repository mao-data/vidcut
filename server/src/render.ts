import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaptionItem, Project, RenderOptions } from '@vidcut/shared';
import { locate, overlayWindow, totalDuration } from '@vidcut/shared';
import { runFfmpeg } from './ffmpeg.js';
import type { ProjectStore } from './store.js';

let drawtextAvailable: boolean | null = null;

const TEXT_CARD_PY = join(dirname(fileURLToPath(import.meta.url)), '../scripts/text_card.py');

export interface CaptionCard {
  cap: CaptionItem;
  /** 相對專案資料夾的透明 PNG 路徑 */
  relPath: string;
}

/**
 * 用 Pillow 把一條 caption 畫成透明 PNG 字卡（繞過 ffmpeg 無 drawtext）。
 * 回傳相對專案資料夾的路徑。
 */
export function renderCaptionCard(
  projectDir: string,
  cap: CaptionItem,
  canvasWidth: number,
): Promise<string> {
  const relPath = join('derived', 'captions', `${cap.id}.png`);
  const outPath = join(projectDir, relPath);
  const payload = JSON.stringify({
    out: outPath,
    text: cap.text,
    fontSize: cap.style.fontSize,
    fill: cap.style.fill,
    stroke: cap.style.stroke ?? null,
    width: canvasWidth,
  });
  return new Promise<string>((resolve, reject) => {
    const child = spawn('python3', [TEXT_CARD_PY], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(relPath);
      else reject(new Error(`text_card.py exited ${code}: ${stderr.slice(-1000)}`));
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

/** 偵測本機 ffmpeg 是否有 drawtext（libfreetype）。快取結果。 */
export async function hasDrawtext(): Promise<boolean> {
  if (drawtextAvailable !== null) return drawtextAvailable;
  drawtextAvailable = await new Promise<boolean>((resolve) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-filters'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
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

/** 定格幀靜圖的固定位置（buildRenderArgs 與 render 共用同一推導）。 */
export function frozenFramePath(clipId: string): string {
  return join('derived', 'frozen', `${clipId}.jpg`);
}

/** blur 填充的模糊半徑（對 1080 寬的畫布視覺上剛好）。 */
const BLUR_RADIUS = 24;
/** ducking 時影片主軌被壓到的音量比例。 */
const DUCK_LEVEL = 0.25;

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
  opts: { hasDrawtext: boolean; captionCards?: CaptionCard[]; export?: RenderOptions },
): RenderPlan {
  const exp = opts.export ?? {};
  const { width, height, fps } = project.canvas;
  const fit = project.canvas.fit ?? 'contain';
  const clips = project.tracks.video;
  const overlays = project.tracks.overlays;
  const audioItems = project.tracks.audio;
  const captionCards = opts.captionCards ?? [];
  // drawtext 可用就原生燒字；否則走 PNG 字卡（overlay）
  const useCards = !opts.hasDrawtext && captionCards.length > 0;
  const total = totalDuration(project);

  const args: string[] = [];
  // 每個 clip 一個 input。定格幀改吃靜圖（-loop 1 -t D）；一般片段 input-level trim
  for (const clip of clips) {
    const media = project.media.find((m) => m.id === clip.mediaId);
    if (!media) throw new Error(`render: media not found for clip ${clip.id}`);
    if (clip.frozen) {
      args.push(
        '-loop',
        '1',
        '-t',
        String(clip.duration),
        '-i',
        join(projectDir, frozenFramePath(clip.id)),
      );
    } else {
      args.push(
        '-ss',
        String(clip.in),
        '-t',
        String(clip.duration),
        '-i',
        join(projectDir, media.path),
      );
    }
  }
  // overlay PNG inputs（在 clip inputs 之後）
  const overlayInputBase = clips.length;
  for (const ov of overlays) {
    args.push('-i', join(projectDir, ov.imagePath));
  }
  // caption 字卡 PNG inputs（在 overlay inputs 之後，僅字卡路徑）
  const captionInputBase = overlayInputBase + overlays.length;
  if (useCards) {
    for (const cc of captionCards) {
      args.push('-i', join(projectDir, cc.relPath));
    }
  }
  // 獨立音訊項 inputs（旁白/BGM/抽出的聲音）
  const audioInputBase = captionInputBase + (useCards ? captionCards.length : 0);
  for (const a of audioItems) {
    const media = project.media.find((m) => m.id === a.mediaId);
    if (!media) throw new Error(`render: media not found for audio ${a.id}`);
    args.push('-i', join(projectDir, media.path));
  }

  const fc: string[] = [];
  // 影片鏈：contain = 黑邊；blur = 模糊放大填滿再把原比例疊在中央
  clips.forEach((_clip, i) => {
    if (fit === 'blur') {
      fc.push(
        `[${i}:v]split=2[bg${i}][fg${i}]`,
        `[bg${i}]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
          `crop=${width}:${height},boxblur=${BLUR_RADIUS}:1[bgb${i}]`,
        `[fg${i}]scale=${width}:${height}:force_original_aspect_ratio=decrease[fgs${i}]`,
        `[bgb${i}][fgs${i}]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${fps},setpts=PTS-STARTPTS[v${i}]`,
      );
    } else {
      fc.push(
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},setpts=PTS-STARTPTS[v${i}]`,
      );
    }
  });
  const vlabels = clips.map((_c, i) => `[v${i}]`).join('');
  fc.push(`${vlabels}concat=n=${clips.length}:v=1:a=0[vcat]`);

  // 音訊鏈：片段原聲（定格幀與無聲素材補靜音軌）
  clips.forEach((clip, i) => {
    const media = project.media.find((m) => m.id === clip.mediaId)!;
    if (media.probe.hasAudio && !clip.frozen) {
      fc.push(`[${i}:a]volume=${clip.volume},asetpts=PTS-STARTPTS,aresample=44100[a${i}]`);
    } else {
      fc.push(`anullsrc=channel_layout=stereo:sample_rate=44100:d=${clip.duration}[a${i}]`);
    }
  });
  const alabels = clips.map((_c, i) => `[a${i}]`).join('');
  fc.push(`${alabels}concat=n=${clips.length}:v=0:a=1[aclips]`);

  // 主軌 ducking：有 ducking 的音訊項播放期間把片段原聲壓低
  let acur = '[aclips]';
  audioItems
    .filter((a) => a.ducking)
    .forEach((a, k) => {
      const next = `[aduck${k}]`;
      const end = a.start + a.duration;
      // volume 的表達式內逗號要轉義（filter_complex 用逗號分隔濾鏡）
      fc.push(
        `${acur}volume=volume='if(between(t\\,${a.start}\\,${end})\\,${DUCK_LEVEL}\\,1)':eval=frame${next}`,
      );
      acur = next;
    });

  // 獨立音訊項：atrim 取段 → 音量/淡入淡出 → adelay 移到絕對時間
  const audioLabels: string[] = [];
  audioItems.forEach((a, k) => {
    const inputIdx = audioInputBase + k;
    const label = `aud${k}`;
    const chain = [
      `atrim=start=${a.in}:duration=${a.duration}`,
      'asetpts=PTS-STARTPTS',
      'aresample=44100',
      `volume=${a.volume}`,
    ];
    if (a.fadeIn && a.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${a.fadeIn}`);
    if (a.fadeOut && a.fadeOut > 0) {
      chain.push(`afade=t=out:st=${Math.max(0, a.duration - a.fadeOut)}:d=${a.fadeOut}`);
    }
    const delayMs = Math.round(a.start * 1000);
    if (delayMs > 0) chain.push(`adelay=${delayMs}|${delayMs}`);
    fc.push(`[${inputIdx}:a]${chain.join(',')}[${label}]`);
    audioLabels.push(`[${label}]`);
  });

  // 混音並截到成片長度（adelay 可能讓音軌超出畫面長度）
  if (audioLabels.length > 0) {
    fc.push(
      `${acur}${audioLabels.join('')}amix=inputs=${audioLabels.length + 1}:normalize=0:` +
        `dropout_transition=0,atrim=duration=${total},asetpts=PTS-STARTPTS[aout]`,
    );
  } else if (acur !== '[aclips]') {
    fc.push(`${acur}anull[aout]`);
  } else {
    fc.push(`[aclips]anull[aout]`);
  }

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

  // captions：drawtext 可用 → 原生燒字；否則 → PNG 字卡（overlay）
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
  } else if (useCards) {
    // 字卡 PNG 全寬、水平已置中；overlay 於 x=0、y=H*style.y，依時間 enable
    captionCards.forEach((cc, k) => {
      const inputIdx = captionInputBase + k;
      const next = `[capc${k}]`;
      const enable = `enable='between(t\\,${cc.cap.start}\\,${cc.cap.start + cc.cap.duration})'`;
      const y = `(H*${cc.cap.style.y})`;
      fc.push(`${vcur}[${inputIdx}:v]overlay=x=0:y=${y}:${enable}${next}`);
      vcur = next;
    });
    captionsBurned = true;
  }

  // 匯出縮放：合成一律在專案畫布尺寸做（overlay/字卡才對得上），最後才縮到輸出尺寸
  const outW = exp.width ?? width;
  const outH = exp.height ?? height;
  if (outW !== width || outH !== height) {
    fc.push(`${vcur}scale=${outW}:${outH}:flags=lanczos[vout]`);
    vcur = '[vout]';
  }
  if (exp.fps && exp.fps !== fps) {
    fc.push(`${vcur}fps=${exp.fps}[vfps]`);
    vcur = '[vfps]';
  }

  args.push('-filter_complex', fc.join(';'), '-map', vcur, '-map', '[aout]');
  args.push('-c:v', exp.codec === 'hevc' ? 'libx265' : 'libx264', '-preset', 'medium');
  if (exp.videoBitrate) args.push('-b:v', exp.videoBitrate);
  else args.push('-crf', String(exp.crf ?? 20));
  if (exp.codec === 'hevc') args.push('-tag:v', 'hvc1'); // QuickTime/iOS 相容
  args.push(
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
  exportOpts?: RenderOptions,
): Promise<RenderResult> {
  const project = store.doc;
  if (project.tracks.video.length === 0) throw new Error('render: timeline is empty');
  const outDir = join(projectDir, 'output');
  await mkdir(outDir, { recursive: true });
  const outRel = join('output', `${stamp}.mp4`);
  const outPath = join(projectDir, outRel);

  const drawtext = await hasDrawtext();

  // 定格幀：先從來源抽出該時刻的靜圖
  const frozen = project.tracks.video.filter((c) => c.frozen);
  if (frozen.length > 0) {
    await mkdir(join(projectDir, 'derived', 'frozen'), { recursive: true });
    for (const clip of frozen) {
      const media = project.media.find((m) => m.id === clip.mediaId);
      if (!media) throw new Error(`render: media not found for frozen clip ${clip.id}`);
      await runFfmpeg([
        '-ss',
        String(clip.in),
        '-i',
        join(projectDir, media.path),
        '-frames:v',
        '1',
        '-q:v',
        '2',
        join(projectDir, frozenFramePath(clip.id)),
      ]);
    }
  }

  // 無 drawtext 且有字幕 → 先用 Pillow 產字卡 PNG
  let captionCards: CaptionCard[] = [];
  if (!drawtext && project.tracks.captions.length > 0) {
    await mkdir(join(projectDir, 'derived', 'captions'), { recursive: true });
    captionCards = await Promise.all(
      project.tracks.captions.map(async (cap) => ({
        cap,
        relPath: await renderCaptionCard(projectDir, cap, project.canvas.width),
      })),
    );
  }
  const plan = buildRenderArgs(project, projectDir, outPath, {
    export: exportOpts,
    hasDrawtext: drawtext,
    captionCards,
  });

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

/**
 * 產生封面圖。已有成品時直接從成片抽幀（所見即所得，含 overlay/字幕）；
 * 否則退而從來源素材抽。寫到 output/cover.jpg 並記進 project.render.coverPath。
 */
export async function extractCover(
  store: ProjectStore,
  projectDir: string,
  time: number,
): Promise<string> {
  const project = store.doc;
  await mkdir(join(projectDir, 'output'), { recursive: true });
  const relPath = join('output', 'cover.jpg');

  const last = project.render.lastOutput;
  let src: string | null = null;
  let seek = time;
  if (last) {
    src = join(projectDir, last);
  } else {
    const loc = locate(project, Math.min(Math.max(time, 0), totalDuration(project)));
    if (!loc) throw new Error('cover: no clip at that time');
    src = join(projectDir, loc.media.proxyPath ?? loc.media.path);
    seek = loc.clip.frozen ? loc.clip.in : loc.clip.in + loc.offsetInClip;
  }

  await runFfmpeg([
    '-ss',
    String(seek),
    '-i',
    src,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    join(projectDir, relPath),
  ]);
  store.mutate('ai', 'set cover', (d) => {
    d.render.coverPath = relPath;
  });
  return relPath;
}
