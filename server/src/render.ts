import { mkdir, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaptionItem, Project, RenderOptions, SubtitleExportMode } from '@vidcut/shared';
import { locate, overlayWindow, serializeSrt, totalDuration } from '@vidcut/shared';
import { probe, runFfmpeg } from './ffmpeg.js';
import type { ProjectStore } from './store.js';
import { cardRequestError } from './cardBudget.js';
import { cardMargin } from './rasterizer.js';
import { capToCardRequest } from './cardSync.js';

/** 渲染進度旁路：'progress' 事件 (0–1)。暫態資料不進版本化 store，由 wsHub 廣播給 UI。 */
export const renderProgressBus = new EventEmitter();

let drawtextAvailable: boolean | null = null;

const TEXT_CARD_PY = join(dirname(fileURLToPath(import.meta.url)), '../scripts/text_card.py');

export interface CaptionCard {
  cap: CaptionItem;
  /** 相對專案資料夾的透明 PNG 路徑 */
  relPath: string;
  /** 這張卡的顯示時間窗（逐詞高亮時＝該詞的時間窗，否則＝整條 caption） */
  start: number;
  end: number;
}

/**
 * 字卡總數上限。逐詞高亮是「一個詞一張卡」，每張卡都是一個 ffmpeg input +
 * 一個 overlay 濾鏡，太多會撞到 ffmpeg 的實際限制且拖慢渲染。
 */
const MAX_CAPTION_CARDS = 600;

let captionFontResolver: (family: string) => string | undefined = () => undefined;
/** 注入字型解析器（啟動時由 index.ts 呼叫）。未注入 → fontPath null → text_card.py 退回候選鏈。 */
export function setCaptionFontResolver(fn: (family: string) => string | undefined): void {
  captionFontResolver = fn;
}

/**
 * 用 Pillow 把一條 caption 畫成透明 PNG 字卡（繞過 ffmpeg 無 drawtext）。
 * 給 tokenIndex 時畫成逐詞高亮的第 N 個狀態。回傳相對專案資料夾的路徑。
 */
export function renderCaptionCard(
  projectDir: string,
  cap: CaptionItem,
  canvasWidth: number,
  tokenIndex?: number,
): Promise<string> {
  const karaoke = tokenIndex !== undefined && cap.tokens && cap.tokens.length > 0;
  // 匯出這條路自己 spawn python3（不走常駐 worker），所以卡不住字卡佇列——但一樣會被
  // OOM killer 收掉。文件內容雖然在寫入時已經過命令層的像素預算檢查，**這次改動之前
  // 存下來的專案**不受那道檢查保護（例如 fontSize 20000 的字幕），一按匯出就會炸。
  // 這裡再擋一次，讓它變成一句看得懂的渲染錯誤，而不是 python 被訊號殺掉的殘骸。
  const budgetErr = cardRequestError(capToCardRequest(cap, canvasWidth));
  if (budgetErr) return Promise.reject(new Error(`caption ${cap.id}: ${budgetErr}`));
  const relPath = join(
    'derived',
    'captions',
    karaoke ? `${cap.id}_${tokenIndex}.png` : `${cap.id}.png`,
  );
  const outPath = join(projectDir, relPath);
  const payload = JSON.stringify({
    out: outPath,
    text: cap.text,
    fontSize: cap.style.fontSize,
    fill: cap.style.fill,
    stroke: cap.style.stroke ?? null,
    width: canvasWidth,
    // 換行寬要**明講**，不能靠 python 的預設值：字幕沒有 maxWidth 欄位 → 分數固定 0.9，
    // 但 python 的預設是 `max(32, width // 20)`，畫布寬 < 640 時與 cardMargin() 不同值。
    // 不傳的話「預覽=成品」在小畫布上會靜默失效（兩邊折行位置不同 → 不同張 PNG）。
    margin: cardMargin(canvasWidth),
    fontPath: captionFontResolver(cap.style.fontFamily) ?? null,
    ...(karaoke
      ? {
          tokens: cap.tokens!.map((t) => t.text),
          activeIndex: tokenIndex,
          highlight: cap.style.highlight ?? cap.style.fill,
        }
      : null),
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

/**
 * 一條 caption → 要疊上去的字卡們。
 * 沒有 tokens：一張卡蓋整條 caption。
 * 有 tokens（karaoke）：一個詞一張卡，時間窗＝相鄰詞的邊界；因為排版是確定性的，
 * 這些卡幾何完全對齊，播起來就是同一行字逐詞變色。
 */
export async function renderCaptionCards(
  projectDir: string,
  cap: CaptionItem,
  canvasWidth: number,
): Promise<CaptionCard[]> {
  const end = cap.start + cap.duration;
  const tokens = cap.tokens;
  if (!tokens || tokens.length === 0) {
    return [
      {
        cap,
        relPath: await renderCaptionCard(projectDir, cap, canvasWidth),
        start: cap.start,
        end,
      },
    ];
  }
  return Promise.all(
    tokens.map(async (tok, k) => ({
      cap,
      relPath: await renderCaptionCard(projectDir, cap, canvasWidth, k),
      // 用下一個詞的起點當結束，讓高亮期間沒有空隙
      start: Math.max(cap.start, tok.start),
      end: tokens[k + 1] ? Math.max(tok.start, tokens[k + 1]!.start) : end,
    })),
  );
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
/** mono → stereo 的無損顯式升混（兩聲道都放滿幅原訊號）。 */
const MONO_UPMIX = 'pan=stereo|c0=c0|c1=c0';

/**
 * 由 project.json 建構 ffmpeg 參數（spec §8.2）。
 * 影片：每片段 input-level -ss/-t 精確剪（一律重新編碼，不用 -c copy）→ scale/pad 1080×1920 → concat。
 * overlay PNG：overlay 濾鏡（time enable、位置由 0–1 換算）。
 * 音訊：有聲用片段聲音、無聲補 anullsrc → concat。
 * captions：有字卡就疊字卡（逐詞高亮只能走這條），否則用原生 drawtext。
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
  // 只有 burn 模式把字幕燒進畫面；off/sidecar/embed 都要乾淨畫面
  // （soft track 疊上燒錄＝觀眾開字幕看到兩排字）
  const burnCaptions = (exp.subtitles ?? 'burn') === 'burn';
  // 有字卡就用字卡（呼叫端已判斷需不需要）；沒有字卡才退回原生 drawtext
  const useCards = burnCaptions && captionCards.length > 0;
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
  // mono 素材先顯式升 stereo——不做的話 amix 隱式升混套 0.707 center level，
  // mono 音軌會平白 −3dB（2026-08-03 對照實驗證實；stereo 不受影響）
  const monoUp = (m: { probe: { audioChannels?: number } } | undefined) =>
    m?.probe.audioChannels === 1 ? `${MONO_UPMIX},` : '';
  clips.forEach((clip, i) => {
    const media = project.media.find((m) => m.id === clip.mediaId)!;
    if (media.probe.hasAudio && !clip.frozen) {
      fc.push(
        `[${i}:a]${monoUp(media)}volume=${clip.volume},asetpts=PTS-STARTPTS,aresample=44100[a${i}]`,
      );
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
    const media = project.media.find((m) => m.id === a.mediaId);
    const chain = [
      `atrim=start=${a.in}:duration=${a.duration}`,
      'asetpts=PTS-STARTPTS',
      'aresample=44100',
      ...(media?.probe.audioChannels === 1 ? [MONO_UPMIX] : []),
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
    // x 錨=圖片水平中心、y 錨=圖片上緣（**刻意不對稱**，見 OverlayItem.position 的說明）。
    // overlay 濾鏡的 `w`/`h` 指的是「疊上去那一路的當下尺寸」，也就是**經過下面 scale 之後**
    // 的寬高——所以置中式子不必因為加了 scale 而改寫，w 會自動變成縮放後的寬。
    const x = `(W*${ov.position.x})-(w/2)`;
    const y = `(H*${ov.position.y})`;
    // position.scale：預覽端是 CSS `transform: scale()`，這裡必須有對應的濾鏡，
    // 否則使用者在 Inspector 改了 scale，預覽變、成品不變（2026-08-04 修掉的 WYSIWYG 落差；
    // 缺口曾大到 244px，見 npm run verify:wysiwyg）。
    let ovLabel = `[${inputIdx}:v]`;
    const s = ov.position.scale;
    if (Number.isFinite(s) && s > 0 && s !== 1) {
      // 縮放要在 overlay 之前做完，overlay 才量得到縮放後的 w/h。
      fc.push(`[${inputIdx}:v]scale=iw*${s}:ih*${s}[ovs${k}]`);
      ovLabel = `[ovs${k}]`;
    } else if (!(Number.isFinite(s) && s > 0)) {
      // scale <= 0／NaN：預覽端 CSS scale(0) 是「看不見」，而 ffmpeg 的 `scale=0` 意思是
      // **沿用原尺寸**——照原樣疊上去等於又製造一次「預覽沒有、成品有一張全尺寸圖」的
      // 靜默落差，正是本次要修的那一類 bug。直接不合成這張 overlay。
      return;
    }
    // s === 1 走原路（不插 scale 濾鏡）：省一次重採樣，也讓既有 filtergraph 逐字不變。
    fc.push(`${vcur}${ovLabel}overlay=x=${x}:y=${y}:${enable}${next}`);
    vcur = next;
  });

  // captions：有字卡就疊字卡（逐詞高亮只能走這條）；否則用原生 drawtext
  let captionsBurned = false;
  if (useCards) {
    // 字卡 PNG 全寬、水平已置中；overlay 於 x=0、y=H*style.y，依各自時間窗 enable
    captionCards.forEach((cc, k) => {
      const inputIdx = captionInputBase + k;
      const next = `[capc${k}]`;
      const enable = `enable='between(t\\,${cc.start}\\,${cc.end})'`;
      const y = `(H*${cc.cap.style.y})`;
      fc.push(`${vcur}[${inputIdx}:v]overlay=x=0:y=${y}:${enable}${next}`);
      vcur = next;
    });
    captionsBurned = true;
  } else if (burnCaptions && opts.hasDrawtext && project.tracks.captions.length > 0) {
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

  // 匯出縮放：合成一律在專案畫布尺寸做（overlay/字卡才對得上），最後才縮到輸出尺寸。
  // 只給單邊時另一邊依畫布比例推算——沿用畫布原尺寸會默默輸出變形的成品，
  // 而 MCP 的 render 工具允許 AI 只指定其中一邊。取偶數（h264 要求 yuv420p 的偶數維度）。
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const outW = exp.width ?? (exp.height ? even((exp.height * width) / height) : width);
  const outH = exp.height ?? (exp.width ? even((exp.width * height) / width) : height);
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
  /** `sidecar` 模式產出的字幕檔（相對專案資料夾）；其餘模式為 undefined。 */
  subtitlePath?: string;
  /** `embed` 模式是否真的把 soft track 混進成品。 */
  subtitlesEmbedded: boolean;
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
  const stored = store.doc;
  if (stored.tracks.video.length === 0) throw new Error('render: timeline is empty');

  // 舊 project.json 的 probe 沒有 audioChannels——渲染前補測（不落盤），
  // 讓 mono 升混修正對既有專案也生效
  const used = new Set<string>();
  for (const c of stored.tracks.video) if (!c.frozen) used.add(c.mediaId);
  for (const a of stored.tracks.audio) used.add(a.mediaId);
  const media = await Promise.all(
    stored.media.map(async (m) => {
      if (!used.has(m.id) || !m.probe.hasAudio || m.probe.audioChannels !== undefined) return m;
      try {
        const p = await probe(join(projectDir, m.path));
        return { ...m, probe: { ...m.probe, audioChannels: p.audioChannels } };
      } catch {
        return m; // 測不到就維持舊行為（不升混）
      }
    }),
  );
  const project: Project = { ...stored, media };
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

  // 需要字卡的兩種情況：本機沒有 drawtext，或有逐詞高亮（drawtext 做不到逐詞著色）。
  // 非 burn 模式不燒字幕，連字卡都不必產（一支長片省下數百次 Pillow 呼叫）。
  const captions = project.tracks.captions;
  const subtitleMode: SubtitleExportMode = exportOpts?.subtitles ?? 'burn';
  const karaoke = captions.some((c) => c.tokens && c.tokens.length > 0);
  let captionCards: CaptionCard[] = [];
  if (captions.length > 0 && subtitleMode === 'burn' && (!drawtext || karaoke)) {
    // 先估數量再產圖——否則超量時會先寫上千張 PNG 才報錯
    const expected = captions.reduce((n, c) => n + Math.max(1, c.tokens?.length ?? 1), 0);
    if (expected > MAX_CAPTION_CARDS) {
      throw new Error(
        `字卡數 ${expected} 超過上限 ${MAX_CAPTION_CARDS}（逐詞高亮＝一詞一張卡）。` +
          '請減少字幕數、關掉 karaoke（auto_caption 的 karaoke:false），或分段渲染。',
      );
    }
    await mkdir(join(projectDir, 'derived', 'captions'), { recursive: true });
    const perCaption = await Promise.all(
      captions.map((cap) => renderCaptionCards(projectDir, cap, project.canvas.width)),
    );
    captionCards = perCaption.flat();
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
        // 進度是暫態，走旁路（wsHub 廣播）——不進版本/歷史/undo（spec 2026-08-03 B2）
        renderProgressBus.emit('progress', Number(progress.toFixed(3)));
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

  // 字幕檔：sidecar 放使用者拿得到的 output/；embed 的 .srt 只是餵 ffmpeg 的中間物，放 derived/。
  // 兩者都在標記 done 之前完成，避免 UI 看到 done 時成品還缺字幕軌。
  let subtitlePath: string | undefined;
  let subtitlesEmbedded = false;
  const srt = subtitleMode === 'sidecar' || subtitleMode === 'embed' ? serializeSrt(captions) : '';
  if (srt !== '') {
    if (subtitleMode === 'sidecar') {
      subtitlePath = join('output', `${stamp}.srt`);
      await writeFile(join(projectDir, subtitlePath), srt, 'utf8');
    } else {
      const srtPath = join(projectDir, 'derived', 'subtitles', `${stamp}.srt`);
      await mkdir(dirname(srtPath), { recursive: true });
      await writeFile(srtPath, srt, 'utf8');
      // ffmpeg 不能就地改寫自己的輸入，所以混到暫檔再蓋回去
      const muxed = join(outDir, `${stamp}.subbed.mp4`);
      await runFfmpeg([
        '-i',
        outPath,
        '-i',
        srtPath,
        '-map',
        '0',
        '-map',
        '1:0',
        '-c',
        'copy',
        '-c:s',
        'mov_text',
        '-movflags',
        '+faststart',
        muxed,
      ]);
      await rename(muxed, outPath);
      subtitlesEmbedded = true;
    }
  }

  store.mutate('ai', 'render done', (d) => {
    d.render = { status: 'done', progress: 1, lastOutput: outRel };
  });
  return { outPath: outRel, captionsBurned: plan.captionsBurned, subtitlePath, subtitlesEmbedded };
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
