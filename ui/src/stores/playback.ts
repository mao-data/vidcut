import { create } from 'zustand';

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
}));
