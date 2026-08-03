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
    format: { duration?: string };
  };
  const v = data.streams.find((s) => s.codec_type === 'video');
  const a = data.streams.find((s) => s.codec_type === 'audio');
  if (!v && !a) throw new Error(`no audio or video stream in ${file}`);
  const [num, den] = (v?.r_frame_rate ?? '30/1').split('/').map(Number);
  const rotation = v
    ? (v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ??
      Number(v.tags?.rotate ?? 0))
    : 0;
  return {
    duration: Number(data.format.duration ?? 0),
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps: den ? num! / den : 30,
    hasAudio: a !== undefined,
    rotation: Math.abs(rotation) % 360,
    hasVideo: v !== undefined,
    ...(a?.channels !== undefined ? { audioChannels: a.channels } : {}),
  };
}
