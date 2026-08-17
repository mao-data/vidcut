import { create } from 'zustand';
import { applyPatches, enablePatches, type Patch } from 'immer';
import type { Project, WsServerMsg } from '@vidcut/shared';
import { useActivity } from './activity.js';
import { useAgent } from './agent.js';
import { useChat } from './chat.js';
import { useEditFx } from './editFx.js';
import { analyzeAiPatches } from '../fx/aiPatches.js';

enablePatches();

/** 模組級常數 fallback——selector 不得回傳新 reference（見 CLAUDE.md 鐵則） */
const NO_CARDS: Record<string, string> = {};

interface ProjectState {
  doc: Project | null;
  version: number;
  connected: boolean;
  /** 渲染中的暫態進度（走旁路 WS 訊息，不進 doc/版本）；非渲染中為 null */
  renderProgress: number | null;
  /** capId → text-card hash（Task 11：預覽字幕直出用） */
  captionCards: Record<string, string>;
  setConnected: (b: boolean) => void;
  /** 回 'resync' 表示 patch 版本跳號，呼叫端（ws.ts）需要重新同步 */
  applyServerMsg: (msg: WsServerMsg) => 'ok' | 'resync';
}

export const useProject = create<ProjectState>((set, get) => ({
  doc: null,
  version: 0,
  connected: false,
  renderProgress: null,
  captionCards: NO_CARDS,
  setConnected: (b) => {
    // 斷線 → 清空進行中的 AI 呼叫。少了這行，server 死掉時 UI 會**永遠**卡在
    // working（那些 end 訊息再也不會來），比完全不顯示還糟。
    if (!b) useAgent.getState().clear();
    set({ connected: b });
  },
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
    if (msg.type === 'textCards') {
      // 早期 return 是關鍵:若落到下面 patch 分支,msg.version 是 undefined,
      // 會被判成 'resync' 觸發再廣播,形成無限迴圈(Task 4 修過的坑)。
      set({ captionCards: Object.fromEntries(msg.entries.map((e) => [e.id, e.hash])) });
      return 'ok';
    }
    if (msg.type === 'chat') {
      // 與 textCards/agentActivity 同類的旁路（不動 doc/version/history——聊天不是編輯）。
      // 早期 return 同樣是關鍵：落到下面 patch 分支的話 msg.version 是 undefined
      // → 判成 'resync' → 無限迴圈。
      useChat.getState().receive(msg.messages);
      return 'ok';
    }
    if (msg.type === 'agentActivity') {
      // 與 textCards 同類的暫態旁路（不動 doc/version/history）。早期 return 同樣是關鍵：
      // 落到下面 patch 分支的話 msg.version 是 undefined → 判成 'resync' → 無限迴圈。
      useAgent.getState().apply(msg);
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
