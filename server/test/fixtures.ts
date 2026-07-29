import { join } from 'node:path';
import { runFfmpeg } from '../src/ffmpeg.js';

export interface FixtureOpts {
  duration?: number;
  withAudio?: boolean;
  freq?: number;
}

/** lavfi 測試影片：直式 540x960@30。withAudio=false 時完全無音軌。 */
export async function makeVideo(
  dir: string,
  name: string,
  opts: FixtureOpts = {},
): Promise<string> {
  const { duration = 4, withAudio = true, freq = 440 } = opts;
  const out = join(dir, name);
  const args = ['-f', 'lavfi', '-i', `testsrc2=duration=${duration}:size=540x960:rate=30`];
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${duration}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (withAudio) args.push('-c:a', 'aac', '-shortest');
  args.push(out);
  await runFfmpeg(args);
  return out;
}
