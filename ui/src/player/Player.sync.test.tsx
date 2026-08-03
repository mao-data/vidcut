import { describe, it, expect, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { Player } from './Player.js';
import { usePlayback } from '../stores/playback.js';
import { seedProject, resetStores } from '../test/fixtures.js';

/**
 * spec 2026-08-02-preview-audio-sync B2：播放中小漂移調 playbackRate（絕不寫
 * currentTime，seek 是雜音來源）、大漂移才 seek；暫停時維持精準 snap。
 * a1 音訊窗 = start 2 → 7、in 1（sourceTime = in + (time - start)）。
 */

function seek(t: number) {
  act(() => {
    usePlayback.getState().seek(t);
  });
}
function play() {
  act(() => {
    usePlayback.getState().play();
  });
}

describe('Player 時鐘同步（rate-nudge）', () => {
  beforeEach(() => {
    resetStores();
    seedProject();
  });

  it('播放中小漂移：audio 只調 playbackRate，不寫 currentTime', () => {
    const { container } = render(<Player />);
    play();
    seek(3); // sourceTime=2，el 從 0 → 首次大漂移 seek 到 2
    const el = container.querySelector('audio')!;
    expect(el.currentTime).toBe(2);

    el.currentTime = 1.9; // 模擬落後 0.1s
    seek(3.0001);
    expect(el.currentTime).toBe(1.9); // 不許 seek
    expect(el.playbackRate).toBeCloseTo(1.05, 3); // 0.1×0.5 加速追
  });

  it('播放中大漂移：audio 硬 seek 且 playbackRate 復位 1', () => {
    const { container } = render(<Player />);
    play();
    seek(3);
    const el = container.querySelector('audio')!;
    el.currentTime = 1.9;
    seek(3.0001);
    expect(el.playbackRate).toBeCloseTo(1.05, 3); // 先進入調速狀態

    el.currentTime = 0.4; // 漂移 1.6s
    seek(3.0002);
    expect(el.currentTime).toBeCloseTo(2.0002, 3);
    expect(el.playbackRate).toBe(1);
  });

  it('暫停時維持精準 snap（拖 playhead 要立即到位）', () => {
    const { container } = render(<Player />);
    seek(3); // 未 play
    const el = container.querySelector('audio')!;
    el.currentTime = 1.9;
    seek(3.0001);
    expect(el.currentTime).toBeCloseTo(2.0001, 3); // 直接 snap，不調速
    expect(el.playbackRate).toBe(1);
  });

  it('播放中小漂移：active video 同樣只調 playbackRate', () => {
    const { container } = render(<Player />);
    play();
    seek(3); // c1 的 in=2 → sourceTime = 2 + 3 = 5
    const vid = container.querySelectorAll('video')[0]!;
    expect(vid.currentTime).toBe(5); // 首次 mount 對齊
    vid.currentTime = 4.9; // 落後 0.1s
    seek(3.0001);
    expect(vid.currentTime).toBe(4.9);
    expect(vid.playbackRate).toBeCloseTo(1.05, 3);
  });
});
