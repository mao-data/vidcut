import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDemoProject } from '../src/demo.js';
import { ProjectStore } from '../src/store.js';

describe('buildDemoProject', () => {
  it(
    'creates a playable 5-clip project with overlay and captions',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'vidcut-demo-'));
      await buildDemoProject(dir);
      const store = await ProjectStore.load(join(dir, 'project.json'));
      // 5 支影片；overlay PNG 走 imagePath 直接引用，不進 media
      expect(store.doc.media.length).toBe(5);
      expect(store.doc.tracks.video).toHaveLength(5);
      expect(store.doc.tracks.overlays.length).toBeGreaterThan(0);
      expect(store.doc.tracks.captions.length).toBeGreaterThan(0);
      for (const m of store.doc.media) {
        expect(m.proxyPath).toBeTruthy();
      }
    },
    180_000,
  );
});
