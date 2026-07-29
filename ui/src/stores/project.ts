import { create } from 'zustand';
import { applyPatches, enablePatches, type Patch } from 'immer';
import type { Project, WsServerMsg } from '@vidcut/shared';

enablePatches();

interface ProjectState {
  doc: Project | null;
  version: number;
  connected: boolean;
  setConnected: (b: boolean) => void;
  /** 回 'resync' 表示 patch 版本跳號，呼叫端（ws.ts）需要重新同步 */
  applyServerMsg: (msg: WsServerMsg) => 'ok' | 'resync';
}

export const useProject = create<ProjectState>((set, get) => ({
  doc: null,
  version: 0,
  connected: false,
  setConnected: (b) => set({ connected: b }),
  applyServerMsg: (msg) => {
    if (msg.type === 'full') {
      set({ doc: msg.doc, version: msg.version });
      return 'ok';
    }
    const { doc, version } = get();
    if (!doc || msg.version !== version + 1) return 'resync';
    set({ doc: applyPatches(doc, msg.patches as Patch[]), version: msg.version });
    return 'ok';
  },
}));
