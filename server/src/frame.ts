import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from '@vidcut/shared';
import { locate, totalDuration } from '@vidcut/shared';
import { runFfmpeg } from './ffmpeg.js';
import { resolveMediaPath } from './paths.js';

/**
 * 抽出時間軸時間 t 的 active 片段畫面成 JPEG，回傳相對專案資料夾的路徑。
 * **只有片段畫面**（用 proxy 抽單幀）：不合成 overlay／字幕／blur 背景。
 * M4 已完成，但這個合成從來沒做過，也沒有排進任何計畫——別再寫成「留待 M4 升級」，
 * 那句 roadmap 殘留曾經害 AI 誤判 overlay 沒設定成功（見 CLAUDE.md 鐵則）。
 * 要驗 overlay／字幕請 render，或請使用者看 UI 預覽（`mcp.ts` 的 get_frame 描述同此）。
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
  // 與 render.ts extractCover 同型接法：proxyPath **不保證存在**（Plan 8 起三階段
  // ingest——A0 probe+登記完就可用，proxy 是 A2 的背景升級，skip 判準命中時永遠不產）。
  // 沒有 proxy 就直接吃原檔：`?? path` 是這條路徑的正常分支，不是防禦性殘留。
  const src = resolveMediaPath(projectDir, loc.media.proxyPath ?? loc.media.path);
  const sourceTime = loc.clip.in + loc.offsetInClip;

  const outRel = join('derived', 'frames', `t${t.toFixed(2)}.jpg`);
  const outAbs = join(projectDir, outRel);
  await mkdir(join(projectDir, 'derived', 'frames'), { recursive: true });
  await runFfmpeg(['-ss', String(sourceTime), '-i', src, '-frames:v', '1', '-q:v', '3', outAbs]);
  return outRel;
}
