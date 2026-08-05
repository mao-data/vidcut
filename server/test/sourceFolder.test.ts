import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaAsset } from '@vidcut/shared';
import { scanSourceFolder, listSource } from '../src/sourceFolder.js';
import { tmpDir } from './tmp.js';

async function folderWith(names: string[]): Promise<string> {
  const dir = await tmpDir('vidcut-src-');
  for (const n of names) await writeFile(join(dir, n), 'x');
  return dir;
}

describe('scanSourceFolder', () => {
  it('只回白名單副檔名，依檔名排序', async () => {
    const dir = await folderWith(['b.mp4', 'a.mov', 'notes.txt', 'song.mp3']);
    const files = await scanSourceFolder(dir);
    expect(files.map((f) => f.name)).toEqual(['a.mov', 'b.mp4', 'song.mp3']);
  });

  it('副檔名比對不分大小寫', async () => {
    const dir = await folderWith(['A.MP4', 'B.MoV']);
    const files = await scanSourceFolder(dir);
    expect(files.map((f) => f.name)).toEqual(['A.MP4', 'B.MoV']);
  });

  it('排除隱藏檔', async () => {
    const dir = await folderWith(['.hidden.mp4', 'visible.mp4']);
    const files = await scanSourceFolder(dir);
    expect(files.map((f) => f.name)).toEqual(['visible.mp4']);
  });

  it('不遞迴子資料夾', async () => {
    const dir = await folderWith(['top.mp4']);
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'deep.mp4'), 'x');
    const files = await scanSourceFolder(dir);
    expect(files.map((f) => f.name)).toEqual(['top.mp4']);
  });

  it('帶回檔案大小與 mtime', async () => {
    const dir = await folderWith(['a.mp4']);
    const [f] = await scanSourceFolder(dir);
    expect(f!.size).toBeGreaterThan(0);
    expect(f!.mtime).toBeGreaterThan(0);
  });

  // Dirent.isFile() 對 symlink 回 false（已實測確認），用 isFile() 過濾會靜默漏檔。
  // 使用者用 symlink 組素材夾是常見做法，漏檔又沒有錯誤訊息＝最糟的失敗模式。
  it('收錄指向檔案的 symlink', async () => {
    const real = await tmpDir('vidcut-real-');
    await writeFile(join(real, 'movie.mp4'), 'x');
    const dir = await tmpDir('vidcut-link-');
    await symlink(join(real, 'movie.mp4'), join(dir, 'linked.mp4'));

    const files = await scanSourceFolder(dir);
    expect(files.map((f) => f.name)).toEqual(['linked.mp4']);
    expect(files[0]!.size).toBeGreaterThan(0); // stat 追隨 symlink，不是 lstat
  });

  it('斷掉的 symlink 被略過而不是丟錯', async () => {
    const dir = await tmpDir('vidcut-broken-');
    await symlink(join(dir, 'nowhere.mp4'), join(dir, 'dangling.mp4'));
    await writeFile(join(dir, 'ok.mp4'), 'x');

    const files = await scanSourceFolder(dir);
    expect(files.map((f) => f.name)).toEqual(['ok.mp4']);
  });

  it('接受非 ASCII 與含空白的檔名', async () => {
    const dir = await folderWith(['我的 影片.mp4', 'a b.mov']);
    const files = await scanSourceFolder(dir);
    expect(files.map((f) => f.name).sort()).toEqual(['a b.mov', '我的 影片.mp4'].sort());
  });

  it('略過子目錄本身（即使名字像影片）', async () => {
    const dir = await folderWith(['real.mp4']);
    await mkdir(join(dir, 'fake.mp4'));
    const files = await scanSourceFolder(dir);
    expect(files.map((f) => f.name)).toEqual(['real.mp4']);
  });

  it('目錄不存在時丟錯', async () => {
    await expect(scanSourceFolder('/definitely/not/here')).rejects.toThrow();
  });

  it('傳入的是檔案而非目錄時丟錯', async () => {
    const dir = await folderWith(['a.mp4']);
    await expect(scanSourceFolder(join(dir, 'a.mp4'))).rejects.toThrow();
  });

  // 專門驗證排序邏輯：位元組順序（B<a）與 localeCompare 結果（a<B）不同。
  // 不管 readdir 回傳何種順序，只有執行 .sort(localeCompare) 才能得到正確的升冪序。
  // 用此測試防止 "移除 .sort(...)" 的突變活下來。
  it('localeCompare 與位元組順序不同時仍正確排序', async () => {
    const dir = await folderWith(['B.mp4', 'a.mp4']);
    const files = await scanSourceFolder(dir);
    // B(charCode 66) < a(charCode 97)，但 localeCompare 認為 'a' < 'B'
    // 期望升冪順序：['a.mp4', 'B.mp4']
    expect(files.map((f) => f.name)).toEqual(['a.mp4', 'B.mp4']);
  });
});

describe('listSource', () => {
  it('標記素材夾內哪些檔案已匯入本專案（絕對路徑素材）', async () => {
    const dir = await tmpDir('vidcut-ls-');
    await writeFile(join(dir, 'a.mp4'), 'x');
    await writeFile(join(dir, 'b.mp4'), 'x');
    const media: MediaAsset[] = [
      {
        id: 'm1',
        path: join(dir, 'a.mp4'),
        probe: { duration: 1, width: 10, height: 10, fps: 30, hasAudio: false, rotation: 0 },
      },
    ];
    const r = await listSource(dir, media, '/proj');
    expect(r.dir).toBe(dir);
    expect(r.files.map((f) => [f.name, f.imported])).toEqual([
      ['a.mp4', true],
      ['b.mp4', false],
    ]);
  });

  it('專案內的相對路徑素材也比對得出來（解析後才比）', async () => {
    const projectDir = await tmpDir('vidcut-ls-proj-');
    await writeFile(join(projectDir, 'c.mp4'), 'x');
    const media: MediaAsset[] = [
      {
        id: 'm1',
        path: 'c.mp4', // 相對路徑＝專案內
        probe: { duration: 1, width: 10, height: 10, fps: 30, hasAudio: false, rotation: 0 },
      },
    ];
    const r = await listSource(projectDir, media, projectDir);
    expect(r.files.find((f) => f.name === 'c.mp4')!.imported).toBe(true);
  });
});
