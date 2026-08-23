import { create } from 'zustand';
import type { TrimPreview } from '../player/plan.js';

interface PlaybackState {
  time: number;
  playing: boolean;
  /** Player 依 doc 更新 */
  total: number;
  setTotal: (t: number) => void;
  play: () => void;
  pause: () => void;
  seek: (t: number) => void;
  /** 主時鐘推進：from + dt，撞到片尾自動暫停 */
  tick: (from: number, dt: number) => void;
  /**
   * final-review Fix 2：Timeline 是否有進行中的 pointer 拖曳（任何一種 drag
   * mode——trim/move/cap/aud/ov，不只 trim）。Timeline 元件的 `drag` ref 是
   * component-local，App 的 `[`/`]` 鍵盤 trim handler 沒有別的管道知道「使用者
   * 手上正抓著把手」，若不設防會在同一個手勢中間再送一次衝突的命令。放在
   * `usePlayback`（而不是新開一個 store）是因為拖曳狀態本來就是播放/時間軸手勢
   * 的一部分，Timeline 與 App 兩邊本來就已經 import 這個 store。
   * Timeline 在每個拖曳啟動 handler（onTrimStart/onMoveStart/onAudDrag/…）設
   * true，`teardownDrag`（onPointerUp／onPointerCancel 共用）一律清回 false。
   */
  dragActive: boolean;
  setDragActive: (v: boolean) => void;
  /**
   * Plan 12 Task 2（裁決 3）：main-track trim-in 拖曳中，player 該顯示的新首幀來源
   * 覆蓋——只影響 player 的 time→source 映射（`planAt`），**不進 doc、不是
   * command、不進 history**。Timeline 在 trim-in 的 rAF 節流回呼（與 scheduleFollow
   * 同一節奏，不是逐 pointermove 都寫）裡寫入，`teardownDrag`（pointerup／
   * pointercancel 共用）一律清回 null。只認 clipId 相符的那個 clip；其餘 clip
   * 的映射不受影響。Plan 14 Task 4：型別改吃 `plan.ts` 匯出的 `TrimPreview`
   * （新增可選 `leadPad`）——單一真相來源，不在這裡另開一份窄化的形狀，否則
   * `setTrimPreview` 會拒收 leadPad 欄位，Timeline.tsx 的 trim-in 分支就傳不進去。
   */
  trimPreview: TrimPreview;
  setTrimPreview: (v: TrimPreview) => void;
}

export const usePlayback = create<PlaybackState>((set, get) => ({
  time: 0,
  playing: false,
  total: 0,
  setTotal: (total) => set({ total }),
  play: () => set({ playing: true }),
  pause: () => set({ playing: false }),
  seek: (t) => set({ time: Math.min(Math.max(t, 0), get().total) }),
  tick: (from, dt) => {
    const t = from + dt;
    if (t >= get().total) set({ time: get().total, playing: false });
    else set({ time: t });
  },
  dragActive: false,
  setDragActive: (v) => set({ dragActive: v }),
  trimPreview: null,
  setTrimPreview: (v) => set({ trimPreview: v }),
}));
