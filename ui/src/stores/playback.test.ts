import { describe, it, expect, beforeEach } from 'vitest';
import { usePlayback } from './playback.js';

describe('usePlayback', () => {
  beforeEach(() => usePlayback.setState({ time: 0, playing: false, total: 10 }));

  it('play/pause toggles', () => {
    usePlayback.getState().play();
    expect(usePlayback.getState().playing).toBe(true);
    usePlayback.getState().pause();
    expect(usePlayback.getState().playing).toBe(false);
  });

  it('seek clamps into [0, total]', () => {
    usePlayback.getState().seek(-5);
    expect(usePlayback.getState().time).toBe(0);
    usePlayback.getState().seek(99);
    expect(usePlayback.getState().time).toBe(10);
    usePlayback.getState().seek(4.2);
    expect(usePlayback.getState().time).toBe(4.2);
  });

  it('tick advances time and auto-pauses at end', () => {
    usePlayback.setState({ playing: true });
    usePlayback.getState().tick(9.5, 1.0); // from, dt
    expect(usePlayback.getState().time).toBe(10);
    expect(usePlayback.getState().playing).toBe(false);
  });

  it('trimPreview defaults to null and setTrimPreview writes/clears it', () => {
    expect(usePlayback.getState().trimPreview).toBeNull();
    usePlayback.getState().setTrimPreview({ clipId: 'c1', in: 3.5 });
    expect(usePlayback.getState().trimPreview).toEqual({ clipId: 'c1', in: 3.5 });
    usePlayback.getState().setTrimPreview(null);
    expect(usePlayback.getState().trimPreview).toBeNull();
  });

  it('Plan 14 Task 4: setTrimPreview accepts an optional leadPad field (TrimPreview from plan.ts)', () => {
    usePlayback.getState().setTrimPreview({ clipId: 'c1', in: 0, leadPad: 1.2 });
    expect(usePlayback.getState().trimPreview).toEqual({ clipId: 'c1', in: 0, leadPad: 1.2 });
    usePlayback.getState().setTrimPreview(null);
  });
});
