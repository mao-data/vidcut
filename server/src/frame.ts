import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from '@vidcut/shared';
import { clipSourceTime, locate, outputDuration, totalDuration } from '@vidcut/shared';
import { runFfmpeg } from './ffmpeg.js';
import { resolveMediaPath } from './paths.js';

/**
 * 抽出時間軸時間 t 的 active 片段畫面成 JPEG，回傳相對專案資料夾的路徑。
 * **只有片段畫面**（用 proxy 抽單幀）：不合成 overlay／字幕／blur 背景。
 * M4 已完成，但這個合成從來沒做過，也沒有排進任何計畫——別再寫成「留待 M4 升級」，
 * 那句 roadmap 殘留曾經害 AI 誤判 overlay 沒設定成功（見 CLAUDE.md 鐵則）。
 * 要驗 overlay／字幕請 render，或請使用者看 UI 預覽（`mcp.ts` 的 get_frame 描述同此）。
 *
 * **黑尾（Plan 13 裁決 6）**：時間夾制上界從 totalDuration 換成 outputDuration——
 * 黑尾區間（主軌之後、outputDuration 之前）`locate()` 對它必然回 null（那裡沒有
 * active clip），但 get_frame 抽到那個時刻時**必須**回一張黑幀而不是「查無片段」的
 * 錯誤，否則 AI 會誤判黑尾是壞掉的專案狀態。這裡走的是 ffmpeg `color=black` lavfi
 * 來源直接生成單張黑幀（用專案畫布尺寸），跟 extractCover／render.ts 的黑尾合成
 * （tpad 疊字幕/overlay）是**不同機制**：get_frame 的既有語意本來就只回「片段畫面」
 * 不合成任何東西，黑尾時刻沒有片段可抽，用同一支黑色 lavfi 幀維持這個語意一致，
 * 不必為了黑尾另外接一條「像 render 一樣合成疊字幕」的路——那是 render 的工作。
 * 主軌範圍內（含空主軌）行為完全不變：回 null 表示該時間無 active 片段。
 */
export async function extractFrame(
  projectDir: string,
  project: Project,
  t: number,
): Promise<string | null> {
  const total = totalDuration(project);
  const output = outputDuration(project);
  const clamped = Math.min(Math.max(t, 0), output);
  // 黑尾判定要用「clamped > total」，不能靠 locate() 回不回 null 來判斷：locate() 對
  // t === total 有「片尾特例」，回的是最後一個 clip 的**尾端**（合法位置，用來抽最後
  // 一幀），不是黑尾。若在這裡把 clamped 先夾到 total 再丟給 locate()，黑尾時刻會全部
  // 落在這個邊界特例上，抽到的是「seek 到來源檔案結尾」，ffmpeg 對已無畫面可讀的
  // seek 常回 234（mjpeg 編碼器收不到 frame）——曾經因此整段黑尾直接炸掉，而不是回黑幀。
  //
  // 黑尾區間是半開的 [total, output)：單用 `clamped > total` 在 total===0 且
  // output>0（主軌全刪、字幕/音訊仍延伸）時會漏接 t===0——那個點嚴格來說「不大於
  // total」，卻仍落在黑尾裡，會直接掉進下面 locate() 對空主軌回 null 的分支，害
  // get_frame 在「有東西可回」的時刻報錯（Plan 13 終審 review round 1 minor）。
  // 用 `output > total && clamped >= total` 才精確對齊半開區間；`output === total`
  // （無黑尾）時這個新增條件恆為 false，t===total 仍走原本 locate() 的片尾特例，
  // byte-identical。
  if (output > total && clamped >= total) return extractBlackFrame(projectDir, project, clamped);
  const loc = locate(project, clamped);
  if (!loc) return null; // 空主軌：clamped<=total===0 但仍 locate 不到（tracks.video 為空）
  // Plan 14 Task 2：clip 內偏移 → 來源時間一律走 clipSourceTime，落在黑墊內回 null——
  // 該畫黑，沒有對應的來源畫面（不能再手算 `in + offsetInClip`，那會把黑墊段誤算成
  // 來源時間，抽出一張不該存在的畫面）。無 leadPad 的 clip：clipSourceTime 回傳值與
  // 舊式子 `in + offsetInClip` 逐位元組相同。
  const sourceTime = clipSourceTime(loc.clip, loc.offsetInClip);
  if (sourceTime === null) return extractBlackFrame(projectDir, project, clamped);
  // 與 render.ts extractCover 同型接法：proxyPath **不保證存在**（Plan 8 起三階段
  // ingest——A0 probe+登記完就可用，proxy 是 A2 的背景升級，skip 判準命中時永遠不產）。
  // 沒有 proxy 就直接吃原檔：`?? path` 是這條路徑的正常分支，不是防禦性殘留。
  const src = resolveMediaPath(projectDir, loc.media.proxyPath ?? loc.media.path);

  const outRel = join('derived', 'frames', `t${t.toFixed(2)}.jpg`);
  const outAbs = join(projectDir, outRel);
  await mkdir(join(projectDir, 'derived', 'frames'), { recursive: true });
  await runFfmpeg(['-ss', String(sourceTime), '-i', src, '-frames:v', '1', '-q:v', '3', outAbs]);
  return outRel;
}

/** 黑尾時刻的黑幀：ffmpeg `color=black` lavfi 來源，尺寸採專案畫布（見上方 extractFrame）。 */
async function extractBlackFrame(projectDir: string, project: Project, t: number): Promise<string> {
  const { width, height } = project.canvas;
  const outRel = join('derived', 'frames', `t${t.toFixed(2)}.jpg`);
  const outAbs = join(projectDir, outRel);
  await mkdir(join(projectDir, 'derived', 'frames'), { recursive: true });
  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${width}x${height}:d=1`,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    outAbs,
  ]);
  return outRel;
}
