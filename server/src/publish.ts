// 發佈包：把 render 成品打成「手動上傳包」。P0 刻意不接任何平台 API——
// 設計取捨與平台限制數字的出處見 docs/superpowers/specs/2026-08-21-publish-package-p0.md。
// 一支 1080×1920 H.264+AAC master 四平台通吃，所以這裡只做複製與 stat，沒有轉檔。
import type { PublishKind, PublishMeta, PublishPlatform } from '@vidcut/shared';

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
