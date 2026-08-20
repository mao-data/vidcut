import { create } from 'zustand';
import {
  clampPps,
  DEFAULT_PX_PER_SECOND,
  fitPps,
  MAX_PX_PER_SECOND,
  MIN_PX_PER_SECOND,
  zoomBoundsFor,
  type ZoomBounds,
} from '../timeline/scale.js';
import { PANEL, type PanelSide } from '../panelResize.js';

const WIDTHS_KEY = 'vidcut.panelWidths';

function loadWidths(): { left: number; right: number } {
  try {
    const raw = localStorage.getItem(WIDTHS_KEY);
    if (raw) {
      const j = JSON.parse(raw) as { left?: number; right?: number };
      // 遷移(2026-08-16):left 預設 260→325。存的值剛好等於**舊預設**視為
      // 「沒自訂過」,吃新預設——否則改了預設的使用者永遠看不到(持久值優先)。
      const left = j.left === 260 ? undefined : j.left;
      return {
        left: Math.min(PANEL.left.max, Math.max(PANEL.left.min, left ?? PANEL.left.default)),
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
  /**
   * 縮放的動態上下限（Plan 9 範圍裁決 #1）。預設是 scale.ts 的靜態 MIN/MAX；
   * 專案總長度／視窗寬度確定後由 `setZoomBounds`（或 `fit`）更新成
   * `zoomBoundsFor()` 算出的值。**何時重算**（載入、resize、加/刪 clip 後是否
   * 重新 fit）是 Task 2 的政策範圍，這裡只負責「clamp 吃得到動態值」。
   */
  zoomBounds: ZoomBounds;
  /** 吸附開關（N） */
  snapEnabled: boolean;
  /** 左（AI 專區）/右（字幕·屬性）面板收合狀態。不持久化。 */
  leftOpen: boolean;
  rightOpen: boolean;
  /** 面板寬度（px）。持久化到 localStorage。 */
  leftWidth: number;
  rightWidth: number;
  /** 拖曳伸縮的寫入口（clamp 由 resolvePanelDrag 做完才進來） */
  setPanelWidth: (side: PanelSide, width: number) => void;
  setPxPerSecond: (v: number) => void;
  /** 以倍率縮放（Ctrl+滾輪） */
  zoomBy: (factor: number) => void;
  /**
   * 重算動態縮放界限（Task 2 的 resize/doc 訂閱層呼叫）；目前的 `pxPerSecond`
   * 若落在新界限外會一併夾回界限內，避免「縮到很小之後專案變短，pps 停在
   * 現已不合法的值」。
   */
  setZoomBounds: (totalSeconds: number, viewportWidth: number) => void;
  toggleSnap: () => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  /**
   * 冪等地展開左欄（AgentStrip 點擊要「指向活動流而且看得到它」，用 toggleLeft
   * 的話本來就開著會被關掉）。已經開著時不 set，避免無謂的 state 通知。
   * 2026-08-16 版面重構前這件事是 `openRight` 在做——活動流那時住在右欄。
   */
  openLeft: () => void;
  /**
   * 冪等地展開右欄（選了東西要「跳到 Properties 分頁而且看得到它」，
   * 用 toggleRight 的話本來就開著會被關掉）。已經開著時不 set，
   * 避免無謂的 state 通知。
   */
  openRight: () => void;
  /** Shift+Z：整條塞進容器 */
  fit: (totalSeconds: number, containerWidth: number) => void;
}

export const useView = create<ViewState>((set, get) => ({
  pxPerSecond: DEFAULT_PX_PER_SECOND,
  zoomBounds: { min: MIN_PX_PER_SECOND, max: MAX_PX_PER_SECOND },
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
  setPxPerSecond: (v) => set({ pxPerSecond: clampPps(v, get().zoomBounds) }),
  zoomBy: (factor) => set({ pxPerSecond: clampPps(get().pxPerSecond * factor, get().zoomBounds) }),
  setZoomBounds: (totalSeconds, viewportWidth) => {
    const bounds = zoomBoundsFor(totalSeconds, viewportWidth);
    set({ zoomBounds: bounds, pxPerSecond: clampPps(get().pxPerSecond, bounds) });
  },
  toggleSnap: () => set({ snapEnabled: !get().snapEnabled }),
  toggleLeft: () => set({ leftOpen: !get().leftOpen }),
  toggleRight: () => set({ rightOpen: !get().rightOpen }),
  openLeft: () => {
    if (!get().leftOpen) set({ leftOpen: true });
  },
  openRight: () => {
    if (!get().rightOpen) set({ rightOpen: true });
  },
  fit: (totalSeconds, containerWidth) =>
    set({
      zoomBounds: zoomBoundsFor(totalSeconds, containerWidth),
      pxPerSecond: fitPps(totalSeconds, containerWidth),
    }),
}));
