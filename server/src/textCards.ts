// server/src/textCards.ts — 內容定址的字卡快取：同輸入永不重畫；rasterizerId 進 key，換引擎全失效。
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CardGeometry, CardRequest, PillowRasterizer } from './rasterizer.js';
import { cardRequestError } from './cardBudget.js';

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

  /** 圖檔存在且非空才算數(0 byte = 上次寫到一半被中斷,一樣要重畫)。 */
  private static async isUsable(abs: string): Promise<boolean> {
    try {
      return (await stat(abs)).size > 0;
    } catch {
      return false;
    }
  }

  async ensure(req: CardRequest): Promise<CardResult> {
    // 最後一道防線：所有產卡路徑都收斂到這裡（HTTP 預覽、cardSync 的字幕、
    // resolveTextCommand 的文字 overlay），所以「會不會撐爆 worker」在這裡擋一定不漏。
    // 上層各自還會先擋一次（HTTP 回 400、命令層回 {ok:false}），是為了給更好的錯誤呈現，
    // 不是因為這裡可以省——少了這行，任何一條新加的產卡路徑都會重新打開這個洞。
    const budgetErr = cardRequestError(req);
    if (budgetErr) throw new Error(budgetErr);
    const hash = cardKey(req, this.rasterizer.id);
    const metaAbs = join(this.dirAbs(), `${hash}.json`);
    const baseAbs = join(this.dirAbs(), `${hash}.base.png`);
    const hlAbs = req.tokens?.length ? join(this.dirAbs(), `${hash}.hl.png`) : undefined;
    try {
      const geo = JSON.parse(await readFile(metaAbs, 'utf8')) as CardGeometry;
      // 命中條件不能只看 .json ——真正被消費的是 PNG。少了 PNG 卻回報命中的話,
      // 因為是內容定址(同輸入永遠算出同一把 key),這張卡就永遠補不回來:
      // 字幕預覽永久退回 DOM 近似;文字 overlay 的 imagePath 指向不存在的檔,
      // render 把它餵給 `ffmpeg -i` 會讓整次匯出失敗。所以圖不在就當 miss 重畫。
      if (
        (await TextCardService.isUsable(baseAbs)) &&
        (!hlAbs || (await TextCardService.isUsable(hlAbs)))
      ) {
        return { hash, ...geo };
      }
    } catch {
      // miss → 產卡
    }
    await mkdir(this.dirAbs(), { recursive: true });
    const geo = await this.rasterizer.rasterize(req, baseAbs, hlAbs);
    await writeFile(metaAbs, JSON.stringify(geo));
    return { hash, ...geo };
  }
}
