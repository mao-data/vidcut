// 語音辨識（whisper.cpp）。產出的詞時間戳是**時間軸絕對秒數**，
// 因為餵給 ASR 的就是時間軸混音——省掉來源↔時間軸換算這個常見錯誤來源。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Project, TranscriptWord } from '@vidcut/shared';
import { normalizeWords, totalDuration } from '@vidcut/shared';
import { runFfmpeg } from './ffmpeg.js';

/** ASR 用的取樣率：whisper.cpp 只吃 16kHz 單聲道。 */
const ASR_SAMPLE_RATE = 16000;

const BIN_CANDIDATES = ['whisper-cli', 'whisper-cpp'];
const MODEL_DIRS = [
  join(homedir(), '.cache', 'whisper.cpp'),
  '/opt/homebrew/share/whisper.cpp/models',
  '/usr/local/share/whisper.cpp/models',
];
/** 模型偏好順序（越前面越準）。 */
const MODEL_RANK = ['large-v3-turbo', 'large-v3', 'large', 'medium', 'small', 'base', 'tiny'];

export const INSTALL_HINT =
  'whisper.cpp 未安裝或找不到模型。安裝：brew install whisper-cpp；' +
  '下載模型：curl -L -o ~/.cache/whisper.cpp/ggml-large-v3-turbo-q5_0.bin ' +
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin；' +
  '或用 VIDCUT_WHISPER_MODEL 指定 .bin 路徑。';

/** 找 whisper 執行檔（PATH 上的 whisper-cli / whisper-cpp）。找不到回 null。 */
export function findWhisperBinary(): string | null {
  for (const bin of BIN_CANDIDATES) {
    const r = spawnSync('which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status === 0) return bin;
  }
  return null;
}

/** 找 ggml 模型：env 指定 → 已知目錄中依 MODEL_RANK 挑最好的。找不到回 null。 */
export function findWhisperModel(): string | null {
  const fromEnv = process.env.VIDCUT_WHISPER_MODEL;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  const found: string[] = [];
  for (const dir of MODEL_DIRS) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.bin')) found.push(join(dir, f));
    }
  }
  if (found.length === 0) return null;
  const rank = (p: string) => {
    const i = MODEL_RANK.findIndex((m) => p.includes(m));
    return i === -1 ? MODEL_RANK.length : i;
  };
  return found.sort((a, b) => rank(a) - rank(b))[0]!;
}

function mediaOf(project: Project, mediaId: string, ctx: string) {
  const media = project.media.find((m) => m.id === mediaId);
  if (!media) throw new Error(`asr: media not found for ${ctx}`);
  return media;
}

/**
 * 建構「時間軸混音 → 16k 單聲道 WAV」的 ffmpeg 參數。
 *
 * 刻意不重用 buildRenderArgs：目的不同。ASR 要的是最大可辨識度，所以
 * **忽略 clip.volume、音訊項音量、淡入淡出與 ducking**（被靜音的片段裡的台詞仍要辨識），
 * 而成片要的是藝術混音。硬共用會讓 render 那段長出一堆 audioOnly 分支且 input 索引偏移。
 */
export function buildAsrAudioArgs(project: Project, projectDir: string, outWav: string): string[] {
  const clips = project.tracks.video;
  const audioItems = project.tracks.audio;
  const args: string[] = [];

  // 只有「真的有聲音可讀」的片段才開 input；定格幀與無聲素材用 anullsrc 佔位以維持對齊
  const inputIdxByClip = new Map<string, number>();
  let inputs = 0;
  for (const clip of clips) {
    const media = mediaOf(project, clip.mediaId, `clip ${clip.id}`);
    if (clip.frozen || !media.probe.hasAudio) continue;
    args.push(
      '-ss',
      String(clip.in),
      '-t',
      String(clip.duration),
      '-i',
      join(projectDir, media.path),
    );
    inputIdxByClip.set(clip.id, inputs++);
  }
  const audioBase = inputs;
  for (const a of audioItems) {
    const media = mediaOf(project, a.mediaId, `audio ${a.id}`);
    args.push('-i', join(projectDir, media.path));
    inputs++;
  }

  const fc: string[] = [];
  const mono = `aresample=${ASR_SAMPLE_RATE},aformat=sample_fmts=s16:channel_layouts=mono`;
  const mixLabels: string[] = [];

  if (clips.length > 0) {
    clips.forEach((clip, i) => {
      const idx = inputIdxByClip.get(clip.id);
      if (idx === undefined) {
        fc.push(
          `anullsrc=channel_layout=mono:sample_rate=${ASR_SAMPLE_RATE}:d=${clip.duration}[a${i}]`,
        );
      } else {
        fc.push(`[${idx}:a]asetpts=PTS-STARTPTS,${mono}[a${i}]`);
      }
    });
    const labels = clips.map((_c, i) => `[a${i}]`).join('');
    fc.push(`${labels}concat=n=${clips.length}:v=0:a=1[aclips]`);
    mixLabels.push('[aclips]');
  }

  audioItems.forEach((a, k) => {
    const chain = [`atrim=start=${a.in}:duration=${a.duration}`, 'asetpts=PTS-STARTPTS', mono];
    const delayMs = Math.round(a.start * 1000);
    if (delayMs > 0) chain.push(`adelay=${delayMs}`);
    fc.push(`[${audioBase + k}:a]${chain.join(',')}[aud${k}]`);
    mixLabels.push(`[aud${k}]`);
  });

  if (mixLabels.length === 0) throw new Error('asr: 時間軸沒有任何聲音可辨識');
  if (mixLabels.length === 1) fc.push(`${mixLabels[0]}anull[aout]`);
  else {
    fc.push(
      `${mixLabels.join('')}amix=inputs=${mixLabels.length}:normalize=0:dropout_transition=0[aout]`,
    );
  }

  args.push(
    '-filter_complex',
    fc.join(';'),
    '-map',
    '[aout]',
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(ASR_SAMPLE_RATE),
    '-c:a',
    'pcm_s16le',
    outWav,
  );
  return args;
}

interface WhisperToken {
  text?: string;
  offsets?: { from?: number; to?: number };
  /** DTW 對齊出來的時間點，單位 10ms。負值＝無效 */
  t_dtw?: number;
}

interface WhisperJson {
  result?: { language?: string };
  transcription?: Array<{
    offsets?: { from?: number; to?: number };
    text?: string;
    tokens?: WhisperToken[];
  }>;
}

/** whisper 的特殊 token（`[_EOT_]`、`<|0.00|>` 之類），不是台詞。 */
const SPECIAL_TOKEN = /^\s*(\[_.*_\]|<\|.*\|>)\s*$/;

/** CJK：判斷要不要把 token 併成一個「詞」（CJK 一個 token 就自成一詞）。 */
const CJK_CHAR = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * 模型檔名 → whisper.cpp 的 DTW aheads preset 名稱。對不上就回 null（退回 segment offsets）。
 */
export function dtwPresetFor(modelPath: string): string | null {
  const f = modelPath.toLowerCase();
  const en = f.includes('.en') ? '.en' : '';
  if (f.includes('large-v3-turbo')) return 'large.v3.turbo';
  if (f.includes('large-v3')) return 'large.v3';
  if (f.includes('large-v2')) return 'large.v2';
  if (f.includes('large-v1') || f.includes('large')) return 'large.v1';
  for (const size of ['medium', 'small', 'base', 'tiny']) {
    if (f.includes(size)) return `${size}${en}`;
  }
  return null;
}

/**
 * 解析 whisper-cli 的 JSON，優先用 token 層的 DTW 時間。
 *
 * 為什麼不用看起來更直覺的 `-ml 1 -sow`（一段一詞）：實測 whisper.cpp 1.9.1 的
 * **segment offsets 在長句尾段會整批退化**成「全部等於音訊結尾」，最後一個詞還會拿到
 * 30 秒（內部補齊的區塊邊界）。同一次辨識裡 token 的 `t_dtw` 卻是正確且單調的
 * （實測 8.84 → 9.04 → … → 12.36），所以逐詞時間一律以 t_dtw 為準。
 *
 * token 合併成詞的規則：以空白開頭＝新詞（拉丁語系），CJK 字元自成一詞
 * （中文沒有詞間空白，而逐字高亮本來就是我們要的效果）。
 */
export function parseWhisperJson(raw: string): { language: string; words: TranscriptWord[] } {
  const data = JSON.parse(raw) as WhisperJson;
  const words: TranscriptWord[] = [];

  for (const seg of data.transcription ?? []) {
    const tokens = (seg.tokens ?? []).filter(
      (t) => t.text !== undefined && !SPECIAL_TOKEN.test(t.text),
    );
    if (tokens.length === 0) {
      // 沒有 token 層（例如只用 -oj）→ 退回 segment 層
      const text = (seg.text ?? '').trim();
      if (text !== '') {
        words.push({
          text,
          start: (seg.offsets?.from ?? 0) / 1000,
          end: (seg.offsets?.to ?? 0) / 1000,
        });
      }
      continue;
    }

    // 先把 token 併成詞，時間取該詞第一個 token 的時間
    const segWords: Array<{ text: string; start: number }> = [];
    for (const tok of tokens) {
      const text = tok.text!;
      const dtw = tok.t_dtw !== undefined && tok.t_dtw >= 0 ? tok.t_dtw / 100 : null;
      const start = dtw ?? (tok.offsets?.from ?? 0) / 1000;
      const prev = segWords[segWords.length - 1];
      const startsWord =
        prev === undefined ||
        /^\s/.test(text) ||
        CJK_CHAR.test(text.trim()[0] ?? '') ||
        CJK_CHAR.test(prev.text[prev.text.length - 1] ?? '');
      if (startsWord) segWords.push({ text: text.trim(), start });
      else prev.text += text;
    }

    // 詞的結束＝下一個詞的開始；最後一個詞用 segment 結束（下游 normalizeWords 會再夾一次）
    const segEnd = (seg.offsets?.to ?? 0) / 1000;
    segWords.forEach((w, i) => {
      if (w.text === '') return;
      const next = segWords[i + 1];
      words.push({ text: w.text, start: w.start, end: next ? next.start : segEnd });
    });
  }

  return { language: data.result?.language ?? 'unknown', words };
}

export interface TranscribeResult {
  language: string;
  words: TranscriptWord[];
  text: string;
  /** 相對專案資料夾：辨識用的 WAV 與原始 JSON，便於重跑/除錯 */
  audioPath: string;
  jsonPath: string;
  model: string;
}

export interface TranscribeOptions {
  /** 'auto' 或 ISO 語言碼（zh/en/ja…）。預設 auto。 */
  language?: string;
  /** 覆寫模型路徑 */
  model?: string;
}

/** 跑一次 whisper.cpp。輸出的詞時間戳可直接當時間軸座標用。 */
export async function transcribe(
  project: Project,
  projectDir: string,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const bin = findWhisperBinary();
  const model = opts.model ?? findWhisperModel();
  if (!bin || !model) throw new Error(INSTALL_HINT);

  const relWav = join('derived', 'asr.wav');
  const relJson = join('derived', 'asr.json');
  await mkdir(join(projectDir, 'derived'), { recursive: true });
  await runFfmpeg(buildAsrAudioArgs(project, projectDir, join(projectDir, relWav)));

  const outPrefix = join(projectDir, 'derived', 'asr');
  await new Promise<void>((resolve, reject) => {
    const preset = dtwPresetFor(model);
    const child = spawn(
      bin,
      [
        '-m',
        model,
        '-f',
        join(projectDir, relWav),
        // -ojf：輸出含 token 層（我們要的逐詞時間在 token 的 t_dtw，見 parseWhisperJson）
        '-ojf',
        '-of',
        outPrefix,
        '-l',
        opts.language ?? 'auto',
        '-nt',
        // DTW 需要關掉 flash attention（whisper.cpp 兩者互斥，開著會靜默停用 DTW）
        ...(preset ? ['-nfa', '-dtw', preset] : []),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (e) => reject(new Error(`${bin}: ${e.message}\n${INSTALL_HINT}`)));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}: ${stderr.slice(-1500)}`)),
    );
  });

  const raw = await readFile(join(projectDir, relJson), 'utf8');
  const { language, words: rawWords } = parseWhisperJson(raw);
  // 修掉 whisper 的 30 秒補齊與短音訊擠壓（見 normalizeWords）——呼叫端不該看到這些病態值
  const words = normalizeWords(rawWords, totalDuration(project));
  return {
    language,
    words,
    text: words.map((w) => w.text).join(' '),
    audioPath: relWav,
    jsonPath: relJson,
    model,
  };
}
