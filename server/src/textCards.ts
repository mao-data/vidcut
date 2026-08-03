// server/src/textCards.ts — 內容定址的字卡快取：同輸入永不重畫；rasterizerId 進 key，換引擎全失效。
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CardGeometry, CardRequest, PillowRasterizer } from './rasterizer.js';

export function cardKey(req: CardRequest, rasterizerId: string): string {
  return createHash('sha1')
    .update(
      JSON.stringify({
        t: req.text,
        k: req.tokens ?? null,
        s: {
          f: req.style.fontFamily,
          z: req.style.fontSize,
          c: req.style.fill,
          o: req.style.stroke ?? null,
          h: req.style.highlight ?? null,
        },
        w: req.width,
        m: req.maxWidthFrac ?? 0.9,
        r: rasterizerId,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

export interface CardResult extends CardGeometry {
  hash: string;
}

export class TextCardService {
  constructor(
    private projectDir: string,
    private rasterizer: PillowRasterizer,
  ) {}

  private dirAbs(): string {
    return join(this.projectDir, 'derived', 'text');
  }
  relBasePath(hash: string): string {
    return join('derived', 'text', `${hash}.base.png`);
  }

  async ensure(req: CardRequest): Promise<CardResult> {
    const hash = cardKey(req, this.rasterizer.id);
    const metaAbs = join(this.dirAbs(), `${hash}.json`);
    try {
      return { hash, ...(JSON.parse(await readFile(metaAbs, 'utf8')) as CardGeometry) };
    } catch {
      // miss → 產卡
    }
    await mkdir(this.dirAbs(), { recursive: true });
    const geo = await this.rasterizer.rasterize(
      req,
      join(this.dirAbs(), `${hash}.base.png`),
      req.tokens?.length ? join(this.dirAbs(), `${hash}.hl.png`) : undefined,
    );
    await writeFile(metaAbs, JSON.stringify(geo));
    return { hash, ...geo };
  }
}
