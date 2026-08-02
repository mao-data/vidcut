import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { Player } from '../player/Player.js';
import { Activity } from './Activity.js';
import { useEditFx } from '../stores/editFx.js';
import { usePlayback } from '../stores/playback.js';
import { useActivity } from '../stores/activity.js';
import { seedProject, resetStores } from '../test/fixtures.js';

describe('AI edit fx in the preview player', () => {
  beforeEach(() => {
    resetStores();
    seedProject();
  });
  afterEach(() => act(() => useEditFx.getState().clear()));

  it('AI-added captions and overlays mount with the entrance class', () => {
    const { container } = render(<Player />);
    act(() => usePlayback.getState().seek(2)); // cap1（1–4s）與 ovAbs（1–4s）都在窗內
    act(() =>
      useEditFx.getState().trigger({ touched: [], added: ['cap1', 'ovAbs'], minStart: null }),
    );
    const overlay = container.querySelector('img[src="/media/assets/title.png"]')!;
    expect(overlay.className).toContain('fx-enter');
    // 取「最深」的匹配 div——querySelectorAll 是文件順序，祖先容器會先匹配到
    const hits = Array.from(container.querySelectorAll('div')).filter((d) =>
      d.textContent?.includes('first line'),
    );
    const caption = hits.find((d) => !hits.some((o) => o !== d && d.contains(o)))!;
    expect(caption.className).toContain('fx-enter');
  });

  it('items not added by the AI carry no entrance class', () => {
    const { container } = render(<Player />);
    act(() => usePlayback.getState().seek(2));
    expect(container.querySelector('.fx-enter')).toBeNull();
  });
});

describe('AI edit fx in the activity feed', () => {
  beforeEach(() => {
    resetStores();
    seedProject();
  });

  it('rows younger than 3s slide in; older rows do not', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T10:00:10Z'));
    act(() => {
      useActivity.getState().seed([
        { version: 1, label: 'old edit', source: 'ai', ts: '2026-08-02T10:00:00Z' },
        { version: 2, label: 'fresh edit', source: 'ai', ts: '2026-08-02T10:00:09Z' },
      ]);
    });
    const { container } = render(<Activity />);
    const row = (text: string) =>
      Array.from(container.querySelectorAll('div')).find((d) => d.textContent?.endsWith(text))!;
    expect(row('fresh edit').className).toContain('fx-slidein');
    expect(row('old edit').className).not.toContain('fx-slidein');
    vi.useRealTimers();
  });
});
