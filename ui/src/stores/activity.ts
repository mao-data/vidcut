import { create } from 'zustand';
import type { HistoryBrief } from '@vidcut/shared';

const MAX_ENTRIES = 200;

interface ActivityState {
  entries: HistoryBrief[];
  /** 收 full 時整批灌入（取代） */
  seed: (entries: HistoryBrief[]) => void;
  /** 收 patch 時逐筆加入（依 version 去重） */
  push: (entry: HistoryBrief) => void;
}

export const useActivity = create<ActivityState>((set, get) => ({
  entries: [],
  seed: (entries) => set({ entries: entries.slice(-MAX_ENTRIES) }),
  push: (entry) => {
    const { entries } = get();
    if (entries.some((e) => e.version === entry.version)) return;
    const next = [...entries, entry];
    set({ entries: next.slice(-MAX_ENTRIES) });
  },
}));
