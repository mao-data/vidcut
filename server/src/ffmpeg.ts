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

export async function probe(file: string): Promise<ProbeInfo> {
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
  const keyframeIntervalSec = v ? await probeKeyframeInterval(file) : undefined;
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
