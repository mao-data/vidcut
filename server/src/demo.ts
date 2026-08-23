import { join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { ProjectStore } from './store.js';
import { ingestMediaFully } from './ingest.js';
import { runFfmpeg } from './ffmpeg.js';

const CLIPS = [
  { name: 'n5.mp4', dur: 5, freq: 330, mute: false },
  { name: 'n4.mp4', dur: 4, freq: 392, mute: false },
  { name: 'n3.mp4', dur: 6, freq: 440, mute: true }, // 無音軌 → 驗證 anullsrc 路徑
  { name: 'n2.mp4', dur: 5, freq: 494, mute: false },
  { name: 'n1.mp4', dur: 6, freq: 523, mute: false },
];

/**
 * 常駐標題 overlay PNG：橙色橫幅 + 白色內框。
 *
 * 註：本機 Homebrew ffmpeg 未編入 drawtext/libfreetype，故用 drawbox 畫橫幅而非燒字；
 * 文字燒錄（字幕 burn-in）改由 PNG 字卡在 M4 處理，見 HANDOFF.md。
 *
 * ⚠️ 底色**必須不透明**。`drawbox` 只把顏色混進 RGB，**從不寫 alpha 通道**——底圖設
 * `black@0.0` 的話，整張 alpha 從頭到尾都是 0，畫得再滿也只是一張全透明的 PNG。舊版
 * 正是如此：demo 的標題橫幅在預覽和匯出**都是隱形的**，而 `demo.test.ts` 只斷言
 * overlay 軌存在、不看畫素，所以一路綠燈。實測夾出來的三組對照：
 *   底 black@0.0 + orange@0.85   → alpha (0,0)       ← 舊版
 *   底 black@0.0 + orange 不透明 → alpha (0,0)       ← 證明 drawbox 真的不碰 alpha
 *   底 black@1.0 + orange@0.85   → alpha (255,255)   ← 現況，RGB 與第一列完全相同
 * 第三列的 RGB 與舊版逐值相同，所以補回 alpha 不改變任何顏色，橫幅長相與原設計一致。
 */
export async function writeTitleCard(dir: string): Promise<string> {
  const dest = join(dir, 'title.png');
  await runFfmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=black@1.0:size=800x120,format=rgba',
    '-vf',
    'drawbox=x=0:y=0:w=800:h=120:color=orange@0.85:t=fill,' +
      'drawbox=x=6:y=6:w=788:h=108:color=white@0.9:t=4',
    '-frames:v',
    '1',
    dest,
  ]);
  return dest;
}

/**
 * 建一個可播放的 demo 專案：5 支 lavfi 直式影片（其一無音軌）+ 常駐標題 overlay + 2 條字幕。
 * 用於 M1 手動驗收，不依賴真素材。
 */
export async function buildDemoProject(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });

  for (const c of CLIPS) {
    const args = ['-f', 'lavfi', '-i', `testsrc2=duration=${c.dur}:size=540x960:rate=30`];
    if (!c.mute) args.push('-f', 'lavfi', '-i', `sine=frequency=${c.freq}:duration=${c.dur}`);
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
    if (!c.mute) args.push('-c:a', 'aac', '-shortest');
    args.push(join(dir, c.name));
    await runFfmpeg(args);
  }

  await writeTitleCard(dir);

  const store = await ProjectStore.load(join(dir, 'project.json'));
  for (const [i, c] of CLIPS.entries()) {
    await ingestMediaFully(store, dir, c.name, { label: `No.${5 - i}` });
  }
  store.mutate('ai', 'demo timeline', (d) => {
    d.tracks.video = d.media.map((m) => ({
      id: nanoid(6),
      mediaId: m.id,
      in: 1,
      duration: Math.min(3, m.probe.duration - 1),
      label: m.label,
      volume: 1,
    }));
    d.tracks.overlays = [
      {
        id: nanoid(6),
        imagePath: 'title.png',
        start: 0,
        duration: null,
        position: { x: 0.5, y: 0.06, scale: 1 },
      },
    ];
    d.tracks.captions = [
      {
        id: nanoid(6),
        text: 'First caption',
        start: 1,
        duration: 3,
        style: { fontFamily: 'sans-serif', fontSize: 64, fill: '#fff', stroke: '#000', y: 0.78 },
      },
      {
        id: nanoid(6),
        text: 'Second caption',
        start: 6,
        duration: 4,
        style: { fontFamily: 'sans-serif', fontSize: 64, fill: '#ff0', stroke: '#000', y: 0.78 },
      },
    ];
  });
  await store.flush();
}

// CLI: tsx src/demo.ts <dir>
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dir = resolve(process.argv[2] ?? 'projects/demo');
  await buildDemoProject(dir);
  console.log(`demo project ready at ${dir}`);
}
