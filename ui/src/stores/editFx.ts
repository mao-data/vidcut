import { create } from 'zustand';
import type { AiFx } from '../fx/aiPatches.js';

/** 光暈/進場動畫窗長度：最後一次 AI 變更後 1.6s 收窗（動畫最長 1s 的光暈跑得完） */
const FX_WINDOW_MS = 1600;

export interface EditFxState {
  /** AI 變更動畫窗開著（軌道容器掛 ai-anim 的依據） */
  window: boolean;
  /** 每次 trigger 遞增；元件用奇偶交替 keyframe 名稱讓光暈可重播 */
  stamp: number;
  touched: Set<string>;
  /** id → 進場序（--fx-i 的 stagger 索引） */
  added: Map<string, number>;
  /** 本輪自動捲動目標（秒）；消費後清掉 */
  minStart: number | null;
  trigger: (fx: AiFx) => void;
  consumeScroll: () => number | null;
  clear: () => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;

export const useEditFx = create<EditFxState>((set, get) => ({
  window: false,
  stamp: 0,
  touched: new Set<string>(),
  added: new Map<string, number>(),
  minStart: null,

  trigger: (fx) => {
    if (fx.touched.length === 0 && fx.added.length === 0) return;
    const s = get();
    // 窗內連發：合併 ids、重置計時器（動畫從當前狀態接著走，不重開窗）
    const touched = new Set(s.window ? s.touched : []);
    for (const id of fx.touched) touched.add(id);
    const added = new Map(s.window ? s.added : []);
    for (const id of fx.added) if (!added.has(id)) added.set(id, added.size);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => get().clear(), FX_WINDOW_MS);
    set({ window: true, stamp: s.stamp + 1, touched, added, minStart: fx.minStart });
  },

  consumeScroll: () => {
    const v = get().minStart;
    if (v !== null) set({ minStart: null });
    return v;
  },

  clear: () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    set({
      window: false,
      stamp: 0,
      touched: new Set<string>(),
      added: new Map<string, number>(),
      minStart: null,
    });
  },
}));
