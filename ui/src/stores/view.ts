import { create } from 'zustand';
import { clampPps, DEFAULT_PX_PER_SECOND, fitPps } from '../timeline/scale.js';
import { PANEL, type PanelSide } from '../panelResize.js';

const WIDTHS_KEY = 'vidcut.panelWidths';

function loadWidths(): { left: number; right: number } {
  try {
    const raw = localStorage.getItem(WIDTHS_KEY);
    if (raw) {
      const j = JSON.parse(raw) as { left?: number; right?: number };
      return {
        left: Math.min(PANEL.left.max, Math.max(PANEL.left.min, j.left ?? PANEL.left.default)),
        right: Math.min(PANEL.right.max, Math.max(PANEL.right.min, j.right ?? PANEL.right.default)),
      };
    }
  } catch {
    // 壞資料就回預設
  }
  return { left: PANEL.left.default, right: PANEL.right.default };
}

function saveWidths(left: number, right: number): void {
  try {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify({ left, right }));
  } catch {
    // Safari 隱私模式等寫入失敗：忽略，寬度只活在這個 session
  }
}

interface ViewState {
  /** 時間軸縮放：每秒幾像素 */
  pxPerSecond: number;
  /** 吸附開關（N） */
  snapEnabled: boolean;
  /** 左（屬性）/右（字幕·活動）面板收合狀態。不持久化。 */
  leftOpen: boolean;
  rightOpen: boolean;
  /** 面板寬度（px）。持久化到 localStorage。 */
  leftWidth: number;
  rightWidth: number;
  /** 拖曳伸縮的寫入口（clamp 由 resolvePanelDrag 做完才進來） */
  setPanelWidth: (side: PanelSide, width: number) => void;
  openPanel: (side: PanelSide, open: boolean) => void;
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
  ...(() => {
    const w = loadWidths();
    return { leftWidth: w.left, rightWidth: w.right };
  })(),
  setPanelWidth: (side, width) => {
    const next =
      side === 'left'
        ? { leftWidth: width, rightWidth: get().rightWidth }
        : { leftWidth: get().leftWidth, rightWidth: width };
    set(side === 'left' ? { leftWidth: width } : { rightWidth: width });
    saveWidths(next.leftWidth, next.rightWidth);
  },
  openPanel: (side, open) => set(side === 'left' ? { leftOpen: open } : { rightOpen: open }),
  setPxPerSecond: (v) => set({ pxPerSecond: clampPps(v) }),
  zoomBy: (factor) => set({ pxPerSecond: clampPps(get().pxPerSecond * factor) }),
  toggleSnap: () => set({ snapEnabled: !get().snapEnabled }),
  toggleLeft: () => set({ leftOpen: !get().leftOpen }),
  toggleRight: () => set({ rightOpen: !get().rightOpen }),
  fit: (totalSeconds, containerWidth) => set({ pxPerSecond: fitPps(totalSeconds, containerWidth) }),
}));
