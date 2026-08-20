import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectStore } from '../src/store.js';
import { ingestMedia } from '../src/ingest.js';
import { probe, runFfmpeg } from '../src/ffmpeg.js';
import { makeAudio, makeVideo } from './fixtures.js';
import { tmpDir } from './tmp.js';

// 只給下面「proxy 編碼後失敗」那條測試用：讓 id 可預測，好在 mkdir 之後、
// ffmpeg 寫 proxy.mp4 之前，預先把該路徑佔成一個目錄，逼真正的 ffmpeg 寫檔失敗
// （EISDIR）。其餘測試不設 nanoidOverride，走真正隨機 id，行為不受影響。
let nanoidOverride: string | null = null;
vi.mock('nanoid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nanoid')>();
  return {
    ...actual,
    nanoid: (size?: number) => nanoidOverride ?? actual.nanoid(size),
  };
});

async function setup() {
  const dir = await tmpDir('vidcut-ingest-');
  const store = await ProjectStore.load(join(dir, 'project.json'));
  return { dir, store };
}

describe('ingestMedia', () => {
  it('produces proxy + filmstrip + peaks and registers the asset', async () => {
    const { dir, store } = await setup();
    await makeVideo(dir, 'src.mp4', { duration: 4, withAudio: true });
    const id = await ingestMedia(store, dir, 'src.mp4', { label: 'N1' });

    const asset = store.doc.media.find((m) => m.id === id)!;
    expect(asset.label).toBe('N1');
    expect(asset.probe.hasAudio).toBe(true);

    const proxy = await probe(join(dir, asset.proxyPath!));
    expect(proxy.height).toBe(960);
    expect(proxy.hasAudio).toBe(true);

    expect((await stat(join(dir, asset.filmstripPath!))).size).toBeGreaterThan(0);
    // 短片（遠低於 JPEG 65500px 上限的天花板）逐秒一格，與 filmstripPlan 的短片分支一致
    expect(asset.filmstripTiles).toBe(Math.ceil(asset.probe.duration));

    const peaks = JSON.parse(await readFile(join(dir, asset.peaksPath!), 'utf8')) as {
      samplesPerBucket: number;
      sampleRate: number;
      peaks: number[];
      rms?: number[];
    };
    expect(peaks.sampleRate).toBe(8000);
    // 100 桶/秒（8000 ÷ 80）；4 秒 ≈ 400 桶
    expect(peaks.sampleRate / peaks.samplesPerBucket).toBe(100);
    expect(peaks.peaks.length).toBeGreaterThan(300);
    expect(Math.max(...peaks.peaks)).toBeLessThanOrEqual(1);

    // RMS：與 peaks 等長、逐桶 ≤ peak
    expect(peaks.rms).toBeDefined();
    expect(peaks.rms!.length).toBe(peaks.peaks.length);
    for (let i = 0; i < peaks.peaks.length; i++) {
      expect(peaks.rms![i]!).toBeLessThanOrEqual(peaks.peaks[i]! + 1e-9);
    }
    // 正弦波 RMS ≈ peak/√2 ≈ 0.707：抽最響的桶（≥80% 最大峰值）驗證比值合理
    const maxPeak = Math.max(...peaks.peaks);
    expect(maxPeak).toBeGreaterThan(0);
    const loud = peaks.peaks
      .map((p, i) => [p, peaks.rms![i]!] as const)
      .filter(([p]) => p >= maxPeak * 0.8);
    expect(loud.length).toBeGreaterThan(0);
    for (const [p, r] of loud) expect(r / p).toBeGreaterThan(0.4);
  }, 60_000);

  it('injects silent audio track for mute sources', async () => {
    const { dir, store } = await setup();
    await makeVideo(dir, 'mute.mp4', { withAudio: false });
    const id = await ingestMedia(store, dir, 'mute.mp4');
    const asset = store.doc.media.find((m) => m.id === id)!;
    expect(asset.probe.hasAudio).toBe(false); // 原始檔的事實
    expect((await probe(join(dir, asset.proxyPath!))).hasAudio).toBe(true); // proxy 一定有音軌
  }, 60_000);

  it('accepts audio-only files: no proxy/filmstrip, peaks generated, hasVideo false', async () => {
    const { dir, store } = await setup();
    await makeAudio(dir, 'vo.wav', { duration: 2 });
    const id = await ingestMedia(store, dir, 'vo.wav', { label: 'VO' });

    const asset = store.doc.media.find((m) => m.id === id)!;
    expect(asset.probe.hasVideo).toBe(false);
    expect(asset.probe.hasAudio).toBe(true);
    expect(asset.probe.audioChannels).toBe(1);
    expect(asset.proxyPath).toBeUndefined();
    expect(asset.filmstripPath).toBeUndefined();

    const peaks = JSON.parse(await readFile(join(dir, asset.peaksPath!), 'utf8')) as {
      peaks: number[];
    };
    expect(peaks.peaks.length).toBeGreaterThan(100); // 2 秒 ≈ 200 桶
    expect(Math.max(...peaks.peaks)).toBeGreaterThan(0);
  }, 60_000);

  it('records audioChannels for video sources (render 的 mono 升混修正靠它)', async () => {
    const { dir, store } = await setup();
    await makeVideo(dir, 'v.mp4', { duration: 2, withAudio: true });
    const id = await ingestMedia(store, dir, 'v.mp4');
    const asset = store.doc.media.find((m) => m.id === id)!;
    expect(asset.probe.hasVideo).toBe(true);
    expect(asset.probe.audioChannels).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('is idempotent per relPath', async () => {
    const { dir, store } = await setup();
    await makeVideo(dir, 'src.mp4', {});
    const a = await ingestMedia(store, dir, 'src.mp4');
    const b = await ingestMedia(store, dir, 'src.mp4');
    expect(b).toBe(a);
    expect(store.doc.media).toHaveLength(1);
  }, 60_000);

  it('可以 ingest 專案資料夾外的絕對路徑，原檔不被複製', async () => {
    const outside = await tmpDir('vidcut-outside-');
    const src = join(outside, 'external.mp4');
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x568:rate=30:duration=2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      src,
    ]);

    const dir = await tmpDir('vidcut-proj-');
    const store = await ProjectStore.load(join(dir, 'project.json'));
    const id = await ingestMedia(store, dir, src);

    const m = store.doc.media.find((x) => x.id === id)!;
    expect(m.path).toBe(src); // 絕對路徑原樣保存
    expect(existsSync(join(dir, 'external.mp4'))).toBe(false); // 沒有複製進專案
    expect(m.proxyPath).toBeDefined();
    expect(existsSync(join(dir, m.proxyPath!))).toBe(true); // 衍生檔仍在專案內
  }, 60_000);

  it('同一個絕對路徑重複 ingest 回同一個 id', async () => {
    const outside = await tmpDir('vidcut-outside2-');
    const src = join(outside, 'dup.mp4');
    await runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x568:rate=30:duration=2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      src,
    ]);
    const dir = await tmpDir('vidcut-proj2-');
    const store = await ProjectStore.load(join(dir, 'project.json'));
    const a = await ingestMedia(store, dir, src);
    const b = await ingestMedia(store, dir, src);
    expect(b).toBe(a);
    expect(store.doc.media).toHaveLength(1);
  }, 60_000);

  it('ingest 失敗不留下半成品 derived 目錄', async () => {
    const outside = await tmpDir('vidcut-bad-');
    const bad = join(outside, 'not-a-video.mp4');
    await writeFile(bad, 'this is not a video');

    const dir = await tmpDir('vidcut-bad-proj-');
    const store = await ProjectStore.load(join(dir, 'project.json'));

    await expect(ingestMedia(store, dir, bad)).rejects.toThrow();
    expect(store.doc.media).toHaveLength(0);
    // derived 下不應留任何目錄
    const derived = join(dir, 'derived');
    const left = existsSync(derived) ? await readdir(derived) : [];
    expect(left).toEqual([]);
  }, 60_000);

  // 上面那條「半成品」測試裡，壞檔在 probe() 就丟錯，發生在 mkdir(derivedAbs) 之前，
  // 所以從未建立 derived/<id> 目錄——它驗證的是「探測失敗」路徑本來就沒有半成品可留，
  // 跟 Task brief Step 3 要修的「mkdir 之後、proxy/filmstrip/peaks 任一步失敗」完全是
  // 不同分支：把 Step 3 的 try/catch 拿掉，上面那條測試仍然全綠（見 task-7-report.md 的
  // 紅綠證據）。這條測試補上真正會走到 mkdir 之後才失敗的路徑，用來證明 try/catch 真的
  // 有殺傷力：把 proxy.mp4 的輸出路徑預先佔成一個目錄，逼 ffmpeg 寫檔時丟 EISDIR。
  it('（補 Step 3 的殺傷力）proxy 編碼寫檔失敗時，mkdir 之後才建立的 derived 目錄也會被清掉', async () => {
    const { dir, store } = await setup();
    await makeVideo(dir, 'src.mp4', { duration: 1, withAudio: true });

    nanoidOverride = 'fixedid1';
    try {
      // 搶先把 ffmpeg 要寫的 proxy.mp4 佔成目錄，逼真正的 ffmpeg 進程寫檔失敗
      await mkdir(join(dir, 'derived', 'fixedid1', 'proxy.mp4'), { recursive: true });

      await expect(ingestMedia(store, dir, 'src.mp4')).rejects.toThrow();
      expect(store.doc.media).toHaveLength(0);
      expect(existsSync(join(dir, 'derived', 'fixedid1'))).toBe(false);
    } finally {
      nanoidOverride = null;
    }
  }, 60_000);
});

// peaks 那步會在系統 temp 開一個 vidcut-pcm-* 目錄放中間產物 a.pcm。算完 peaks.json
// 之後那個 .pcm 就沒用了——但它曾經從來沒被刪過，於是**產品程式碼**每匯入一支素材就
// 漏一個目錄（大小約每分鐘影片 1MB），永遠不會自己消失。實測這台機器一天累積出上千個。
//
// 量測方式：server/src 裡只有 ingest.ts 用 tmpdir()，所以把 TMPDIR 指到一個空的沙箱
// 目錄，ingest 跑完後那個沙箱**必須是空的**——不必去數全域 temp（會被別的程序干擾）。
describe('ingestMedia 的 PCM 暫存目錄清理', () => {
  async function withTmpSandbox<T>(fn: () => Promise<T>): Promise<[string[], T | Error]> {
    const sandbox = await tmpDir('vidcut-tmpsandbox-');
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = sandbox;
    let out: T | Error;
    try {
      out = await fn();
    } catch (e) {
      out = e as Error;
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
    return [await readdir(sandbox), out];
  }

  it('匯入成功後不留下 vidcut-pcm-* 暫存目錄', async () => {
    const { dir, store } = await setup();
    await makeVideo(dir, 'src.mp4', { duration: 1, withAudio: true });

    const [left, out] = await withTmpSandbox(() => ingestMedia(store, dir, 'src.mp4'));

    expect(out).not.toBeInstanceOf(Error); // 先確認走的是成功路徑
    expect(left).toEqual([]);
  }, 60_000);

  it('peaks.json 寫入失敗時，先前建立的 PCM 暫存目錄一樣會被清掉', async () => {
    const { dir, store } = await setup();
    await makeVideo(dir, 'src.mp4', { duration: 1, withAudio: true });

    nanoidOverride = 'fixedid2';
    try {
      // 搶先把 peaks.json 佔成目錄 → writeFile 丟 EISDIR。這個失敗點刻意選在
      // mkdtemp 之後，才驗得到「中途丟錯時暫存目錄有沒有被清」這條路徑。
      await mkdir(join(dir, 'derived', 'fixedid2', 'peaks.json'), { recursive: true });

      const [left, out] = await withTmpSandbox(() => ingestMedia(store, dir, 'src.mp4'));

      expect(out).toBeInstanceOf(Error); // 先確認真的走到失敗路徑
      expect(store.doc.media).toHaveLength(0);
      expect(left).toEqual([]);
    } finally {
      nanoidOverride = null;
    }
  }, 60_000);
});
