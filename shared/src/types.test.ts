import { describe, it, expect } from 'vitest';
import { createEmptyProject } from './types.js';

describe('createEmptyProject', () => {
  it('builds a schema-v1 project with fixed canvas and empty tracks', () => {
    const p = createEmptyProject('p1', 'demo');
    expect(p.schemaVersion).toBe(1);
    expect(p.canvas).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect(p.tracks.video).toEqual([]);
    expect(p.tracks.overlays).toEqual([]);
    expect(p.tracks.captions).toEqual([]);
    expect(p.tracks.audio).toEqual([]);
    expect(p.review).toBeNull();
    expect(p.render.status).toBe('idle');
    // JSON-safe（無 Infinity/undefined）
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});
