import type { EditorContextData } from '@vidcut/shared';

const EMPTY: EditorContextData = { selection: null, playhead: 0, range: null };

/**
 * 人在 UI 的 ephemeral 脈絡（選取、playhead、拖選範圍）。
 * UI 經 WS {type:'context'} 更新，get_editor_context 工具讀取。
 * 非 project.json 一部分，不落盤。
 */
export class EditorContext {
  #data: EditorContextData = EMPTY;

  set(data: EditorContextData): void {
    this.#data = data;
  }

  get(): EditorContextData {
    return this.#data;
  }
}
