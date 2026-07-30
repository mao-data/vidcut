import { create } from 'zustand';
import { clampPps, DEFAULT_PX_PER_SECOND, fitPps } from '../timeline/scale.js';

interface ViewState {
  /** 時間軸縮放：每秒幾像素 */
  pxPerSecond: number;
  /** 吸附開關（N） */
  snapEnabled: boolean;
  setPxPerSecond: (v: number) => void;
  /** 以倍率縮放（Ctrl+滾輪） */
  zoomBy: (factor: number) => void;
  toggleSnap: () => void;
  /** Shift+Z：整條塞進容器 */
  fit: (totalSeconds: number, containerWidth: number) => void;
}

export const useView = create<ViewState>((set, get) => ({
  pxPerSecond: DEFAULT_PX_PER_SECOND,
  snapEnabled: true,
  setPxPerSecond: (v) => set({ pxPerSecond: clampPps(v) }),
  zoomBy: (factor) => set({ pxPerSecond: clampPps(get().pxPerSecond * factor) }),
  toggleSnap: () => set({ snapEnabled: !get().snapEnabled }),
  fit: (totalSeconds, containerWidth) => set({ pxPerSecond: fitPps(totalSeconds, containerWidth) }),
}));
