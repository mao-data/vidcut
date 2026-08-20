import { enablePatches, produceWithPatches, applyPatches, freeze, type Patch } from 'immer';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import {
  createEmptyProject,
  type JsonPatch,
  type MutationSource,
  type Project,
} from '@vidcut/shared';

enablePatches();

export interface HistoryEntry {
  version: number;
  label: string;
  source: MutationSource;
  ts: string;
  patches: JsonPatch[];
  inversePatches: JsonPatch[];
  /**
   * 這筆變更是「系統對某個既有物件補記的衍生事實」，不是使用者/AI 的編輯意圖——
   * `revertSince`（審核退回）跳過它，不把它算進要反轉的範圍。目前唯一的寫入者是
   * `updateMediaDerived`（見 commands.ts 該 case 的註解）：background ingest 階段
   * （A1/A2）寫入 proxy/filmstrip/peaks 路徑時，若這筆恰好落在「審核開始之後、
   * 退回發生之前」的時間窗，一般的 revertSince 會把它當成該輪審核的一部分反轉掉
   * ——doc 上的欄位被抹除，但 `derived/<id>/` 底下的檔案仍在磁碟上，而且沒有任何
   * 機制會重跑那個階段（A1/A2 刻意不重試），素材因此永久降級。
   *
   * 與 `#replaying`／`runWithoutUndo` 是**正交**的兩個旗標：後者管「要不要進使用者的
   * undo/redo 堆疊」，這個管「審核退回要不要反轉它」。`updateMediaDerived` 兩邊都不進，
   * 但只有**這個**是靠明講的 `excludeFromRevert` 選項；undo 排除是**白拿的**——
   * 它動的是 `media` 路徑，`isUndoable()` 只認 `tracks`／`canvas` 開頭的 patch，
   * 媒體補丁天生就落在 undo 範圍外，不需要（也沒有）額外旗標去關掉它。
   */
  excludeFromRevert?: boolean;
}

export interface ChangeEvent {
  version: number;
  patches: JsonPatch[];
  source: MutationSource;
  label: string;
  ts: string;
}

const HISTORY_MAX = 200;
const UNDO_MAX = 200;
const SAVE_DEBOUNCE_MS = 500;

/** 落盤格式 = doc + 修訂號（load 時剝離，doc 本體不帶 rev）。 */
type ProjectFile = Project & { rev?: number };

/** 可撤回 = 只動編輯面（軌道/畫布）。render/review/cover/media 狀態不進 undo。 */
function isUndoable(patches: JsonPatch[]): boolean {
  return (
    patches.length > 0 && patches.every((p) => p.path[0] === 'tracks' || p.path[0] === 'canvas')
  );
}

/**
 * 專案的唯一真相來源。所有變更（AI 或 UI）都走 mutate()，序列化、記歷史、
 * 廣播 patch、debounce 原子落盤。詳見 spec §4。
 */
export class ProjectStore {
  #doc: Project;
  #version = 0;
  #history: HistoryEntry[] = [];
  /** 游標式 undo：只收「可撤回的編輯」；undo 把 entry 移去 redo、redo 移回來 */
  #undoStack: HistoryEntry[] = [];
  #redoStack: HistoryEntry[] = [];
  /**
   * 「這次 mutation 不進 undo/redo 堆疊」的旗標。兩種用途：
   *  - undo/redo 重放本身（防遞迴／自我污染）；
   *  - 系統層的衍生資料修復（見 runWithoutUndo）。
   */
  #replaying = false;
  #listeners = new Set<(e: ChangeEvent) => void>();
  #filePath: string;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #saving: Promise<void> = Promise.resolve();

  private constructor(filePath: string, doc: Project, rev = 0) {
    this.#filePath = filePath;
    this.#doc = freeze(doc, true);
    this.#version = rev;
  }

  /** 檔案不存在時從資料夾名推 name 建空專案。 */
  static async load(filePath: string): Promise<ProjectStore> {
    try {
      const raw = await readFile(filePath, 'utf8');
      const { rev, ...doc } = JSON.parse(raw) as ProjectFile;
      return new ProjectStore(filePath, doc as Project, rev ?? 0);
    } catch {
      const name = basename(dirname(filePath)) || 'untitled';
      return new ProjectStore(filePath, createEmptyProject(name, name));
    }
  }

  get doc(): Project {
    return this.#doc;
  }

  get version(): number {
    return this.#version;
  }

  history(): ReadonlyArray<HistoryEntry> {
    return this.#history;
  }

  mutate(
    source: MutationSource,
    label: string,
    recipe: (draft: Project) => void,
    opts?: { excludeFromRevert?: boolean },
  ): { version: number; patches: JsonPatch[] } {
    const [next, patches, inversePatches] = produceWithPatches(this.#doc, recipe);
    if (patches.length === 0) return { version: this.#version, patches: [] };
    this.#doc = next;
    this.#version += 1;
    const ts = new Date().toISOString();
    const entry: HistoryEntry = {
      version: this.#version,
      label,
      source,
      ts,
      patches: patches as JsonPatch[],
      inversePatches: inversePatches as JsonPatch[],
      ...(opts?.excludeFromRevert ? { excludeFromRevert: true } : {}),
    };
    this.#history.push(entry);
    if (this.#history.length > HISTORY_MAX) {
      this.#history.splice(0, this.#history.length - HISTORY_MAX);
    }
    // 游標式 undo：新的可撤回編輯進堆疊並清 redo（分叉）；undo/redo 重放不進
    if (!this.#replaying && isUndoable(entry.patches)) {
      this.#undoStack.push(entry);
      if (this.#undoStack.length > UNDO_MAX) this.#undoStack.shift();
      this.#redoStack = [];
    }
    this.#scheduleSave();
    const evt: ChangeEvent = {
      version: this.#version,
      patches: patches as JsonPatch[],
      source,
      label,
      ts,
    };
    for (const cb of this.#listeners) cb(evt);
    return { version: this.#version, patches: patches as JsonPatch[] };
  }

  /**
   * 游標式 undo：每步 pop 一筆「可撤回編輯」套用 inverse（連按一路往回退），
   * pop 出的 entry 進 redo 堆疊。非編輯（render/review/cover）不在範圍。
   * 無可撤回時回 null。
   */
  undo(source: MutationSource, steps = 1): { version: number } | null {
    let last: { version: number } | null = null;
    for (let i = 0; i < steps; i++) {
      const e = this.#undoStack.pop();
      if (!e) break;
      this.#replaying = true;
      try {
        last = this.mutate(source, `undo: ${e.label}`, (draft) => {
          applyPatches(draft, e.inversePatches as Patch[]);
        });
      } finally {
        this.#replaying = false;
      }
      this.#redoStack.push(e);
    }
    return last;
  }

  /** redo：對稱地把最後被撤回的編輯套回去。 */
  redo(source: MutationSource, steps = 1): { version: number } | null {
    let last: { version: number } | null = null;
    for (let i = 0; i < steps; i++) {
      const e = this.#redoStack.pop();
      if (!e) break;
      this.#replaying = true;
      try {
        last = this.mutate(source, `redo: ${e.label}`, (draft) => {
          applyPatches(draft, e.patches as Patch[]);
        });
      } finally {
        this.#replaying = false;
      }
      this.#undoStack.push(e);
    }
    return last;
  }

  /**
   * 一筆回滾 version 之後的全部變更（審核退回用）。走歷史而非 undo 堆疊——
   * 回滾範圍含非編輯 mutation，且不應動到使用者的 undo/redo 游標。
   *
   * ⚠️ **跳過 `excludeFromRevert` 的 entry**（見該欄位在 `HistoryEntry` 的註解）：
   * background ingest 階段（A1/A2）可能剛好在 `sinceVersion` 之後、退回發生之前
   * 把 proxy/filmstrip/peaks 寫回某支素材——那支素材本身多半是審核開始「之前」就
   * 登記的（`registerMedia` 在 sinceVersion 之前），只是背景轉檔還沒跑完。若照舊
   * 反轉這幾筆，doc 上的欄位會被抹掉，但 `derived/<id>/` 底下的檔案仍在磁碟上，
   * 而且沒有任何機制會重跑那個階段——素材因此永久降級（可用但畫質/縮圖/波形
   * 永遠比原本該有的差）。這些欄位是「檔案系統上的既成事實」，不是這輪審核想
   * 撤銷的編輯意圖，跳過它們才是正確的回滾範圍。
   *
   * 邊界情況（刻意維持現況）：若回滾點落在**該素材的 `registerMedia` 之前**，
   * 那筆本身會被反轉，整支素材連同其 derived 欄位一起從 doc 消失——這是對的
   * （doc 前後一致），孤兒檔案的清理不在這個範圍內。
   */
  revertSince(version: number): { version: number } | null {
    const entries = this.#history.filter((h) => h.version > version && !h.excludeFromRevert);
    if (entries.length === 0) return null;
    const inverse = entries.reverse().flatMap((h) => h.inversePatches);
    this.#replaying = true;
    try {
      return this.mutate('human', 'review rollback', (draft) => {
        applyPatches(draft, inverse as Patch[]);
      });
    } finally {
      this.#replaying = false;
    }
  }

  /**
   * 在 `fn` 期間發生的 mutation **不進 undo 堆疊、也不清 redo**，其餘完全照常
   * （記歷史、廣播 patch、落盤）。給「系統修復衍生資料」用，不是給編輯用。
   *
   * 為什麼需要：字卡是內容定址的，`imagePath` 烤在 doc 裡，光柵器版本一升就得回頭
   * 重寫（見 textOverlays.ts 的 refreshTextOverlayCards）。那是一次**維護**，不是使用者
   * 做過的編輯——走一般 mutate 的話它會變成開檔後 undo 堆疊裡唯一的一筆，使用者
   * 反射性按一次 Cmd+Z 撤掉的就是它，`imagePath` 被還原回舊 hash；若 `derived/` 已被
   * 清過，那個檔案根本不存在，`ffmpeg -i` 讀不到就是整支匯出失敗。撤銷一件自己
   * 從沒做過的事，還撤出一個壞掉的專案，沒有任何道理。
   *
   * **`fn` 必須是同步的**：旗標在 `finally` 就還原，回傳 Promise 的話 await 之後
   * 產生的 mutation 已經不在保護範圍內（而且中間夾的使用者編輯會被誤標成不可撤銷）。
   * 現在唯一的呼叫端包的是 `applyCommand`，它是同步的（產卡那段 async 前置刻意留在
   * 命令層外，見 resolveTextCommand 的註解）。
   */
  runWithoutUndo<T>(fn: () => T): T {
    const prev = this.#replaying;
    this.#replaying = true;
    try {
      return fn();
    } finally {
      this.#replaying = prev;
    }
  }

  onChange(cb: (e: ChangeEvent) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #scheduleSave(): void {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      void this.#save();
    }, SAVE_DEBOUNCE_MS);
  }

  #save(): Promise<void> {
    this.#saving = this.#saving.then(async () => {
      await mkdir(dirname(this.#filePath), { recursive: true });
      const tmp = join(dirname(this.#filePath), `.project.json.tmp`);
      const file: ProjectFile = { ...this.#doc, rev: this.#version };
      await writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
      await rename(tmp, this.#filePath);
    });
    return this.#saving;
  }

  /** 立刻落盤（測試/關機用）。 */
  async flush(): Promise<void> {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    await this.#save();
  }
}
