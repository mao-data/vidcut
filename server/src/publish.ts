// 發佈包：把 render 成品打成「手動上傳包」。P0 刻意不接任何平台 API——
// 設計取捨與平台限制數字的出處見 docs/superpowers/specs/2026-08-21-publish-package-p0.md。
// 一支 1080×1920 H.264+AAC master 四平台通吃，所以這裡只做複製與 stat，沒有轉檔。
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { PublishKind, PublishMeta, PublishPlatform, Project, PublishInfo } from '@vidcut/shared';
import { serializeSrt, totalDuration } from '@vidcut/shared';

export const UPLOAD_URLS: Record<PublishPlatform, string> = {
  tiktok: 'https://www.tiktok.com/tiktokstudio/upload',
  youtube: 'https://studio.youtube.com/',
  instagram: 'https://www.instagram.com/',
  facebook: 'https://www.facebook.com/',
};

/**
 * 門檻按（platform, kind）查表；kind 是目標形式（short=Shorts/Reels、video=一般長片）。
 * 超限只產生警告、不擋打包：長片本來就是 YouTube/Facebook 的合法目標。
 * 數字取保守值（帳號等級不同上限不同，寧可多提醒）。
 */
export const PLATFORM_LIMITS: Record<
  PublishPlatform,
  Partial<Record<PublishKind, { maxSeconds: number; maxBytes: number }>>
> = {
  tiktok: { short: { maxSeconds: 600, maxBytes: 4 * 2 ** 30 } },
  instagram: { short: { maxSeconds: 180, maxBytes: 1 * 2 ** 30 } },
  youtube: {
    short: { maxSeconds: 180, maxBytes: 256 * 2 ** 30 },
    video: { maxSeconds: 43_200, maxBytes: 256 * 2 ** 30 },
  },
  facebook: {
    short: { maxSeconds: 90, maxBytes: 4 * 2 ** 30 },
    video: { maxSeconds: 14_400, maxBytes: 10 * 2 ** 30 },
  },
};

/**
 * 解析目標形式：明確指定且平台支援就用它；否則平台預設
 * （youtube→short：vidcut 主產出是直式短片；facebook→video；tiktok/instagram 只有 short）。
 */
export function resolveKind(p: PublishPlatform, kind?: PublishKind): PublishKind {
  if (kind && PLATFORM_LIMITS[p][kind]) return kind;
  return p === 'facebook' ? 'video' : 'short';
}

export function platformWarnings(
  p: PublishPlatform,
  kind: PublishKind,
  seconds: number,
  bytes: number,
): string[] {
  const lim = PLATFORM_LIMITS[p][kind] ?? PLATFORM_LIMITS[p][resolveKind(p)]!;
  const out: string[] = [];
  if (seconds > lim.maxSeconds) {
    out.push(
      p === 'youtube' && kind === 'short'
        ? `video is ${Math.round(seconds)}s — over 180s it uploads as a regular video, not a Short`
        : `video is ${Math.round(seconds)}s, over the ${lim.maxSeconds}s ${kind} guideline`,
    );
  }
  if (bytes > lim.maxBytes) {
    out.push(`file is ${(bytes / 2 ** 30).toFixed(1)} GiB, over the ${lim.maxBytes / 2 ** 30} GiB limit`);
  }
  return out;
}

/** 文案檔內容：title、空行、body、空行、#tag 列——缺的段落連同空行一起省略。 */
export function metaToText(meta: PublishMeta): string {
  const parts: string[] = [];
  if (meta.title) parts.push(meta.title);
  parts.push(meta.body);
  if (meta.hashtags && meta.hashtags.length > 0)
    parts.push(meta.hashtags.map((h) => `#${h}`).join(' '));
  return parts.join('\n\n');
}

const ALL_PLATFORMS: readonly PublishPlatform[] = ['tiktok', 'youtube', 'instagram', 'facebook'];

/**
 * 把最近一次 render 成品打成 output/publish/<stamp>/。只複製與 stat，不轉檔。
 * **不碰 doc**——結果由呼叫端走 setPublish 命令登記（模式同 registerMedia/setCover）。
 * 重打包整個目錄先刪再建，上一輪的平台 txt 不殘留。
 */
export async function buildPublishPackage(
  projectDir: string,
  doc: Project,
  meta: Partial<Record<PublishPlatform, PublishMeta>>,
): Promise<PublishInfo> {
  const platforms = ALL_PLATFORMS.filter((p) => meta[p] !== undefined);
  if (platforms.length === 0)
    throw new Error('give at least one platform (tiktok / youtube / instagram / facebook)');
  const out = doc.render.status === 'done' ? doc.render.lastOutput : undefined;
  const srcVideo = out ? join(projectDir, out) : '';
  if (!out || !existsSync(srcVideo))
    throw new Error('render first: no finished output to package');

  const stamp = basename(out, '.mp4');
  const dirRel = join('output', 'publish', stamp);
  const dirAbs = join(projectDir, dirRel);
  await rm(dirAbs, { recursive: true, force: true });
  await mkdir(dirAbs, { recursive: true });

  const files: string[] = [];
  const put = (name: string) => {
    files.push(join(dirRel, name));
    return join(dirAbs, name);
  };

  await copyFile(srcVideo, put('video.mp4'));
  const coverAbs = doc.render.coverPath ? join(projectDir, doc.render.coverPath) : '';
  if (coverAbs && existsSync(coverAbs)) await copyFile(coverAbs, put('cover.jpg'));
  const srt = serializeSrt(doc.tracks.captions);
  if (srt !== '') await writeFile(put('subtitles.srt'), srt, 'utf8');
  for (const p of platforms) await writeFile(put(`${p}.txt`), metaToText(meta[p]!), 'utf8');

  const seconds = totalDuration(doc);
  const bytes = (await stat(srcVideo)).size;
  const kinds = Object.fromEntries(
    platforms.map((p) => [p, resolveKind(p, meta[p]!.kind)]),
  ) as Record<PublishPlatform, PublishKind>;
  const perPlatform = Object.fromEntries(
    platforms.map((p) => [
      p,
      {
        uploadUrl: UPLOAD_URLS[p],
        textFile: `${p}.txt`,
        kind: kinds[p],
        warnings: platformWarnings(p, kinds[p], seconds, bytes),
      },
    ]),
  );
  const createdAt = new Date().toISOString();
  await writeFile(
    put('manifest.json'),
    JSON.stringify(
      { stamp, createdAt, video: { file: 'video.mp4', seconds, bytes }, platforms: perPlatform },
      null,
      2,
    ),
    'utf8',
  );

  return {
    dir: dirRel,
    stamp,
    platforms: [...platforms],
    files,
    warnings: platforms.flatMap((p) =>
      platformWarnings(p, kinds[p], seconds, bytes).map((w) => `${p}: ${w}`),
    ),
    createdAt,
  };
}
