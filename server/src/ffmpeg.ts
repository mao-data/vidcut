import { spawn } from 'node:child_process';
import type { ProbeInfo } from '@vidcut/shared';

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

export async function runFfmpeg(args: string[]): Promise<void> {
  await run('ffmpeg', ['-hide_banner', '-y', ...args]);
}

/**
 * 直接跑 ffprobe、回傳原始 stdout。`probe()` 內部量測影音走固定的輸出形狀，
 * 圖片尺寸探測（probeImageSize，libraryIngest.ts）需要自訂 -show_entries，
 * 所以另開這個瘦身版而不是硬塞進 probe() 的介面。非零 exit 由 run() 丟錯——
 * 壞圖（副檔名對、內容爛）就是靠這裡的丟錯擋下。
 */
export async function runFfprobe(args: string[]): Promise<string> {
  const { stdout } = await run('ffprobe', args);
  return stdout;
}

interface FfprobeStream {
  codec_type: string;
  codec_name?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  channels?: number;
  side_data_list?: Array<{ rotation?: number }>;
  tags?: Record<string, string>;
}

export interface ProbeOpts {
  /**
   * 量測 keyframe（I-frame）平均間距（見 probeKeyframeInterval）。**預設關閉**
   * （Plan 8 final review F4）：這是額外一次 ffprobe 呼叫，掃前 60 秒封包流，
   * 只有 A0（`prepareMedia`）決定 `proxyPlan`（remux vs transcode）需要這個數字；
   * render 路徑的 `withProbedChannels`（render.ts）只要 `audioChannels`，卻因為
   * 舊版 `probe()` 無條件量測而白白扛了這筆成本——渲染時延不該被一個它用不到的
   * 量測拖慢。只有呼叫端明確要求才做。
   */
  keyframes?: boolean;
}

export async function probe(file: string, opts: ProbeOpts = {}): Promise<ProbeInfo> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    file,
  ]);
  const data = JSON.parse(stdout) as {
    streams: FfprobeStream[];
    format: { duration?: string; format_name?: string };
  };
  const v = data.streams.find((s) => s.codec_type === 'video');
  const a = data.streams.find((s) => s.codec_type === 'audio');
  if (!v && !a) throw new Error(`no audio or video stream in ${file}`);
  const [num, den] = (v?.r_frame_rate ?? '30/1').split('/').map(Number);
  const rotation = v
    ? (v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ??
      Number(v.tags?.rotate ?? 0))
    : 0;
  const container = data.format.format_name?.split(',')[0];
  const keyframeIntervalSec = v && opts.keyframes ? await probeKeyframeInterval(file) : undefined;
  return {
    duration: Number(data.format.duration ?? 0),
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps: den ? num! / den : 30,
    hasAudio: a !== undefined,
    rotation: Math.abs(rotation) % 360,
    hasVideo: v !== undefined,
    ...(a?.channels !== undefined ? { audioChannels: a.channels } : {}),
    ...(v?.codec_name !== undefined ? { codec: v.codec_name } : {}),
    ...(v?.pix_fmt !== undefined ? { pixFmt: v.pix_fmt } : {}),
    ...(container !== undefined ? { container } : {}),
    ...(keyframeIntervalSec !== undefined ? { keyframeIntervalSec } : {}),
  };
}

/**
 * 量測一支影片開頭 keyframe（I-frame）的平均間距（秒）。只讀前 60 秒
 * （`-read_intervals %+60`）——這是成本上限,28 分鐘的檔不能為了量測掃全檔,
 * 抓開頭一段當代表值。少於 2 個 keyframe 量不出間距,保守回 undefined
 * （見 shared/src/proxyPlan.ts 檔頭：量測失敗一律讓 proxyPlan 走 transcode）。
 */
export async function probeKeyframeInterval(file: string): Promise<number | undefined> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-read_intervals',
    '%+60',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=pts_time,flags',
    '-of',
    'csv=p=0',
    file,
  ]);
  const keyTimes: number[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [ptsTime, flags] = trimmed.split(',');
    if (flags?.startsWith('K') && ptsTime !== undefined) {
      const t = Number(ptsTime);
      if (!Number.isNaN(t)) keyTimes.push(t);
    }
  }
  if (keyTimes.length < 2) return undefined;
  const span = keyTimes[keyTimes.length - 1]! - keyTimes[0]!;
  return span / (keyTimes.length - 1);
}
