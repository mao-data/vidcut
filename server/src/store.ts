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
const SAVE_DEBOUNCE_MS = 500;

/**
 * 專案的唯一真相來源。所有變更（AI 或 UI）都走 mutate()，序列化、記歷史、
 * 廣播 patch、debounce 原子落盤。詳見 spec §4。
 */
export class ProjectStore {
  #doc: Project;
  #version = 0;
  #history: HistoryEntry[] = [];
  #listeners = new Set<(e: ChangeEvent) => void>();
  #filePath: string;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #saving: Promise<void> = Promise.resolve();

  private constructor(filePath: string, doc: Project) {
    this.#filePath = filePath;
    this.#doc = freeze(doc, true);
  }

  /** 檔案不存在時從資料夾名推 name 建空專案。 */
  static async load(filePath: string): Promise<ProjectStore> {
    try {
      const raw = await readFile(filePath, 'utf8');
      return new ProjectStore(filePath, JSON.parse(raw) as Project);
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
    this.#history.push({
      version: this.#version,
      label,
      source,
      ts,
      patches: patches as JsonPatch[],
      inversePatches: inversePatches as JsonPatch[],
    });
    if (this.#history.length > HISTORY_MAX) {
      this.#history.splice(0, this.#history.length - HISTORY_MAX);
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
   * 撤回最後 n 筆 mutation，以一筆新 mutation（label 'undo'）廣播。
   * 無可撤回時回 null。注意：撤 undo 自己 = redo 語意（M1 接受此簡化）。
   */
  undo(steps = 1): { version: number } | null {
    const n = Math.min(steps, this.#history.length);
    if (n === 0) return null;
    const inverse = this.#history
      .slice(-n)
      .reverse()
      .flatMap((h) => h.inversePatches);
    const r = this.mutate('human', 'undo', (draft) => {
      applyPatches(draft, inverse as Patch[]);
    });
    return { version: r.version };
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
      await writeFile(tmp, JSON.stringify(this.#doc, null, 2), 'utf8');
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
