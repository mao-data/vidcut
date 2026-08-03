import { create } from 'zustand';
import { applyPatches, enablePatches, type Patch } from 'immer';
import type { Project, WsServerMsg } from '@vidcut/shared';
import { useActivity } from './activity.js';
import { useEditFx } from './editFx.js';
import { analyzeAiPatches } from '../fx/aiPatches.js';

enablePatches();

interface ProjectState {
  doc: Project | null;
  version: number;
  connected: boolean;
  /** 渲染中的暫態進度（走旁路 WS 訊息，不進 doc/版本）；非渲染中為 null */
  renderProgress: number | null;
  setConnected: (b: boolean) => void;
  /** 回 'resync' 表示 patch 版本跳號，呼叫端（ws.ts）需要重新同步 */
  applyServerMsg: (msg: WsServerMsg) => 'ok' | 'resync';
}

export const useProject = create<ProjectState>((set, get) => ({
  doc: null,
  version: 0,
  connected: false,
  renderProgress: null,
  setConnected: (b) => set({ connected: b }),
  applyServerMsg: (msg) => {
    if (msg.type === 'full') {
      set({ doc: msg.doc, version: msg.version });
      useActivity.getState().seed(msg.history);
      return 'ok';
    }
    if (msg.type === 'commandError') {
      // 由 ws.ts 轉給 toast；這裡不改狀態
      return 'ok';
    }
    if (msg.type === 'renderProgress') {
      set({ renderProgress: msg.progress });
      return 'ok';
    }
    const { doc, version } = get();
    if (!doc || msg.version !== version + 1) return 'resync';
    const next = applyPatches(doc, msg.patches as Patch[]);
    // 渲染狀態一有變（done/error/start），暫態進度就過期
    const touchesRender = msg.patches.some((p) => p.path[0] === 'render');
    set({ doc: next, version: msg.version, ...(touchesRender ? { renderProgress: null } : {}) });
    // AI 的變更走動畫層（光暈/進場/捲動）；人的操作已有拖曳 preview，不重複動畫
    if (msg.source === 'ai') {
      useEditFx.getState().trigger(analyzeAiPatches(msg.patches, doc, next));
    }
    useActivity
      .getState()
      .push({ version: msg.version, label: msg.label, source: msg.source, ts: msg.ts });
    return 'ok';
  },
}));
