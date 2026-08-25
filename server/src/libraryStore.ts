import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LibraryAsset } from '@vidcut/shared';

/** library.json 的落盤形狀。 */
interface LibraryFile {
  assets: LibraryAsset[];
}

export interface LibraryFilter {
  query?: string;
  tag?: string;
  kind?: LibraryAsset['kind'];
}

/** list() 的元素：asset + 執行期算出的 broken（索引有記錄但 files/ 缺檔）。不落盤。 */
export type LibraryListing = LibraryAsset & { broken: boolean };

/**
 * 跨專案素材庫的唯一真相來源（spec 2026-08-21）。獨立於任何專案：
 * 變更不進 undo、不走 Command——它不是專案狀態。所有庫變更走 mutate()。
 *
 * 併發模型：這個工作區常態多 session 同開，每次 mutate 先重讀再套用再原子寫，
 * 檔案層級最後寫贏。單人本地庫可接受；不做鎖（spec 明文記錄此取捨）。
 */
export class LibraryStore {
  #dir: string;
  #assets: LibraryAsset[] = [];

  private constructor(dir: string) {
    this.#dir = dir;
  }

  /**
   * 載入（目錄不存在則建立）。library.json 損毀（parse 失敗）時**丟錯**而不是
   * 靜默清空——清空再寫回等於丟掉整個索引。呼叫端（index.ts）降級成「無素材庫」
   * 並警告，其餘功能照常（同字型表先例）。
   */
  static async load(dir: string): Promise<LibraryStore> {
    const s = new LibraryStore(dir);
    await mkdir(join(dir, 'files'), { recursive: true });
    await mkdir(join(dir, 'derived'), { recursive: true });
    await s.#reload();
    return s;
  }

  get dir(): string {
    return this.#dir;
  }

  get(id: string): LibraryAsset | undefined {
    return this.#assets.find((a) => a.id === id);
  }

  /** 去重靠它：一個 hash 永遠只有一筆 asset（addToLibrary 保證）。 */
  byHash(hash: string): LibraryAsset | undefined {
    return this.#assets.find((a) => a.hash === hash);
  }

  fileAbs(a: LibraryAsset): string {
    return join(this.#dir, a.file);
  }

  derivedAbs(a: LibraryAsset): string {
    return join(this.#dir, 'derived', a.hash);
  }

  list(f: LibraryFilter = {}): LibraryListing[] {
    let out = this.#assets;
    if (f.kind) out = out.filter((a) => a.kind === f.kind);
    if (f.tag) out = out.filter((a) => a.tags.includes(f.tag!));
    if (f.query) {
      const q = f.query.toLowerCase();
      out = out.filter((a) => `${a.label} ${a.tags.join(' ')}`.toLowerCase().includes(q));
    }
    // broken 執行期算不落盤：檔案在不在是檔案系統的事實，快取它只會製造過期資訊
    return out.map((a) => ({ ...a, broken: !existsSync(this.fileAbs(a)) }));
  }

  /** 改 label/tags。id 不存在丟錯（錯誤字樣 `no library asset` 是 HTTP 404 的判據）。 */
  async updateAsset(id: string, patch: { label?: string; tags?: string[] }): Promise<LibraryAsset> {
    let updated: LibraryAsset | undefined;
    await this.mutate((assets) => {
      const a = assets.find((x) => x.id === id);
      if (!a) throw new Error(`no library asset ${id}`);
      if (patch.label !== undefined) a.label = patch.label;
      if (patch.tags !== undefined) a.tags = patch.tags;
      updated = a;
    });
    return updated!;
  }

  /**
   * 刪除：索引先寫、檔案後刪（反過來的話索引寫失敗會留下指向已刪檔案的記錄）。
   * a.file 先驗形狀再 rm——索引正常只會有 files/<hash>.<ext>，但 rm 前多驗一步，
   * 防止手改壞的索引讓我們刪到庫外的路徑。
   */
  async removeAsset(id: string): Promise<void> {
    await this.#reload(); // 這個工作區常態多 session 同開：別的 session 剛加的 asset 也要能刪
    const a = this.get(id);
    if (!a) throw new Error(`no library asset ${id}`);
    if (!/^files\/[0-9a-f]{64}\.[A-Za-z0-9]+$/.test(a.file.replaceAll('\\', '/'))) {
      throw new Error(`refusing to delete suspicious file path: ${a.file}`);
    }
    await this.mutate((assets) => {
      const i = assets.findIndex((x) => x.id === id);
      if (i === -1) throw new Error(`no library asset ${id}`);
      assets.splice(i, 1);
    });
    await rm(this.fileAbs(a), { force: true });
    await rm(this.derivedAbs(a), { recursive: true, force: true });
  }

  /** 所有庫變更的唯一路徑：重讀 → 套用 → 原子寫（temp+rename）。fn 丟錯則不落盤。 */
  async mutate(fn: (assets: LibraryAsset[]) => void): Promise<void> {
    await this.#reload();
    const next = structuredClone(this.#assets);
    fn(next);
    const tmp = join(this.#dir, '.library.json.tmp');
    await writeFile(tmp, JSON.stringify({ assets: next } satisfies LibraryFile, null, 2), 'utf8');
    await rename(tmp, join(this.#dir, 'library.json'));
    this.#assets = next;
  }

  /**
   * 公開重讀：讀路徑（list/get/byHash）預設吃記憶體快照（load 時或上次 mutate 後），
   * 這個工作區常態多 session 同開——A session 剛 addToLibrary，B session 的記憶體快照
   * 還是舊的，list_library/import 就會看不到 A 剛加的 asset。讀入口（HTTP GET、MCP
   * list_library、prepareFromLibrary）在讀之前呼叫這個方法，確保讀到的是最新落盤狀態。
   */
  async reload(): Promise<void> {
    await this.#reload();
  }

  async #reload(): Promise<void> {
    try {
      const raw = await readFile(join(this.#dir, 'library.json'), 'utf8');
      this.#assets = (JSON.parse(raw) as LibraryFile).assets ?? [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#assets = []; // 還沒有索引＝空庫，正常初始
        return;
      }
      throw e;
    }
  }
}
