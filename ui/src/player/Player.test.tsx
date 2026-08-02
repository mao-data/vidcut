import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { Player } from './Player.js';
import { usePlayback } from '../stores/playback.js';
import { useProject } from '../stores/project.js';
import { demoProject, seedProject, resetStores } from '../test/fixtures.js';

/** 把 playhead 移到 t（走真正的 store action）。 */
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

function audioEls(c: HTMLElement): HTMLAudioElement[] {
  return Array.from(c.querySelectorAll('audio'));
}
function videoEls(c: HTMLElement): HTMLVideoElement[] {
  return Array.from(c.querySelectorAll('video'));
}

/**
 * 逐元素 spy。play/pause 的預設 stub 掛在 prototype 上（jsdom 未實作），
 * 是所有媒體元素共用的——要判斷「這一個元素有沒有被播」必須遮蔽成實例屬性，
 * 否則 video 的呼叫會被算到 audio 頭上。
 */
function watch(el: HTMLMediaElement) {
  return { play: vi.spyOn(el, 'play'), pause: vi.spyOn(el, 'pause') };
}

describe('Player', () => {
  beforeEach(() => {
    resetStores();
    seedProject();
  });

  it('renders nothing until a project arrives', () => {
    useProject.setState({ doc: null });
    const { container } = render(<Player />);
    expect(container.querySelector('video')).toBeNull();
  });

  it('mounts one <audio> per audio item, pointing at that media', () => {
    const { container } = render(<Player />);
    const els = audioEls(container);
    expect(els).toHaveLength(1);
    // a1 用 m2，m2 有 proxy → 走 proxy
    expect(els[0]!.getAttribute('src')).toBe('/media/derived/m2/proxy.mp4');
  });

  it('plays an audio item only while the playhead is inside its window', () => {
    const { container } = render(<Player />);
    const spy = watch(audioEls(container)[0]!);
    play();

    // a1 窗 = start 2 → 7
    seek(1); // 窗外
    expect(spy.play).not.toHaveBeenCalled();

    seek(3); // 窗內
    expect(spy.play).toHaveBeenCalled();

    seek(8); // 窗外（尾端）
    expect(spy.pause).toHaveBeenCalled();
  });

  it('sets audio volume from the item volume and fade envelope', () => {
    const doc = demoProject();
    doc.tracks.audio[0] = { ...doc.tracks.audio[0]!, fadeIn: 2, fadeOut: 1 };
    seedProject(doc);
    const { container } = render(<Player />);
    const el = audioEls(container)[0]!;
    play();

    seek(4); // rel=2 → 淡入結束，全音量 0.8
    expect(el.volume).toBeCloseTo(0.8);

    seek(3); // rel=1，fadeIn=2 → 增益 0.5
    expect(el.volume).toBeCloseTo(0.4);

    seek(6.5); // remain=0.5，fadeOut=1 → 增益 0.5
    expect(el.volume).toBeCloseTo(0.4);
  });

  it('mutes the video element when the clip volume is 0 (extract-audio case)', () => {
    const doc = demoProject();
    doc.tracks.video[0] = { ...doc.tracks.video[0]!, volume: 0 };
    seedProject(doc);
    const { container } = render(<Player />);
    play();
    seek(3); // 在 c1 內

    const active = videoEls(container)[0]!;
    expect(active.muted).toBe(true);
  });

  it('ducks the video track while a ducking audio item plays', () => {
    const doc = demoProject();
    doc.tracks.audio[0] = { ...doc.tracks.audio[0]!, ducking: true };
    seedProject(doc);
    const { container } = render(<Player />);
    play();

    const active = videoEls(container)[0]!;
    seek(1); // ducking 項尚未開始 → 原音量
    expect(active.volume).toBeCloseTo(1);

    seek(3); // ducking 中 → 0.25
    expect(active.volume).toBeCloseTo(0.25);
  });

  it('does not play a frozen clip (holds the still frame)', () => {
    const { container } = render(<Player />);
    const spies = videoEls(container).map(watch);
    play();
    seek(7); // c2 = 6–10s，frozen

    const idx = videoEls(container).findIndex((v) => v.style.opacity === '1');
    expect(videoEls(container)[idx]!.muted).toBe(true);
    expect(spies[idx]!.pause).toHaveBeenCalled();
  });

  it('shows overlays and captions only inside their time window', () => {
    const { container } = render(<Player />);

    seek(2); // ovAbs 1–4；cap1 1–4
    expect(container.querySelector('img[src="/media/assets/title.png"]')).not.toBeNull();
    expect(container.textContent).toContain('first line');

    seek(5); // 兩者都出窗；cap2 5–8 進窗
    expect(container.querySelector('img[src="/media/assets/title.png"]')).toBeNull();
    expect(container.textContent).not.toContain('first line');
    expect(container.textContent).toContain('second');
  });

  it('anchored overlays follow their clip (c2 starts at 6s, offset .5)', () => {
    const { container } = render(<Player />);
    seek(6.7); // 6.5–8.5 窗內
    expect(container.querySelector('img[src="/media/assets/badge.png"]')).not.toBeNull();
    seek(6.2); // 窗前
    expect(container.querySelector('img[src="/media/assets/badge.png"]')).toBeNull();
  });

  it('highlights karaoke tokens up to the playhead', () => {
    const { container } = render(<Player />);
    seek(5.5); // 第 1 個 token 進行中
    // 詞間空格由元件補在 span 內，故比對用 trim
    const spans = Array.from(container.querySelectorAll('span'));
    const second = spans.find((s) => s.textContent?.trim() === 'second')!;
    const line = spans.find((s) => s.textContent?.trim() === 'line')!;
    expect(second.style.color).toBe('rgb(251, 191, 36)'); // highlight #fbbf24
    expect(line.style.color).toBe('rgb(255, 255, 255)'); // 尚未唸到 → fill
  });
});
