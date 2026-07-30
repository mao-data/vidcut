import { create } from 'zustand';

export type SelectionKind = 'clip' | 'overlay' | 'caption' | 'audio';
export interface Selection {
  kind: SelectionKind;
  id: string;
}

interface SelectionState {
  selected: Selection | null;
  select: (sel: Selection | null) => void;
}

export const useSelection = create<SelectionState>((set) => ({
  selected: null,
  select: (sel) => set({ selected: sel }),
}));
