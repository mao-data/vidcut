import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from '@vidcut/shared';
import { locate, totalDuration } from '@vidcut/shared';
import { runFfmpeg } from './ffmpeg.js';

/**
 * 抽出時間軸時間 t 的 active 片段畫面成 JPEG，回傳相對專案資料夾的路徑。
 * M3 僅片段畫面（用 proxy）；overlay/字幕合成留待 M4 的 get_frame 升級。
 * 回 null 表示該時間無 active 片段。
 */
export async function extractFrame(
  projectDir: string,
  project: Project,
  t: number,
): Promise<string | null> {
  const total = totalDuration(project);
  const loc = locate(project, Math.min(Math.max(t, 0), total));
  if (!loc) return null;
  const src = loc.media.proxyPath ?? loc.media.path;
  const sourceTime = loc.clip.in + loc.offsetInClip;

  const outRel = join('derived', 'frames', `t${t.toFixed(2)}.jpg`);
  const outAbs = join(projectDir, outRel);
  await mkdir(join(projectDir, 'derived', 'frames'), { recursive: true });
  await runFfmpeg([
    '-ss',
    String(sourceTime),
    '-i',
    join(projectDir, src),
    '-frames:v',
    '1',
    '-q:v',
    '3',
    outAbs,
  ]);
  return outRel;
}
