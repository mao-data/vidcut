import { create } from 'zustand';
import { clampPps, DEFAULT_PX_PER_SECOND, fitPps } from '../timeline/scale.js';

interface ViewState {
  /** 時間軸縮放：每秒幾像素 */
  pxPerSecond: number;
  /** 吸附開關（N） */
  snapEnabled: boolean;
  /** 左（屬性）/右（字幕·活動）面板收合狀態。不持久化。 */
  leftOpen: boolean;
  rightOpen: boolean;
  setPxPerSecond: (v: number) => void;
  /** 以倍率縮放（Ctrl+滾輪） */
  zoomBy: (factor: number) => void;
  toggleSnap: () => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  /** Shift+Z：整條塞進容器 */
  fit: (totalSeconds: number, containerWidth: number) => void;
}

export const useView = create<ViewState>((set, get) => ({
  pxPerSecond: DEFAULT_PX_PER_SECOND,
  snapEnabled: true,
  leftOpen: true,
  rightOpen: true,
  setPxPerSecond: (v) => set({ pxPerSecond: clampPps(v) }),
  zoomBy: (factor) => set({ pxPerSecond: clampPps(get().pxPerSecond * factor) }),
  toggleSnap: () => set({ snapEnabled: !get().snapEnabled }),
  toggleLeft: () => set({ leftOpen: !get().leftOpen }),
  toggleRight: () => set({ rightOpen: !get().rightOpen }),
  fit: (totalSeconds, containerWidth) => set({ pxPerSecond: fitPps(totalSeconds, containerWidth) }),
}));
