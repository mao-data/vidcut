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
  /** undo/redo 套用中的旗標：其產生的 mutation 不得再進堆疊（防遞迴/自我污染） */
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
   */
  revertSince(version: number): { version: number } | null {
    const entries = this.#history.filter((h) => h.version > version);
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
