import { describe, it, expect } from 'vitest';
import { applyPatches, produceWithPatches, enablePatches } from 'immer';
import type { JsonPatch, Project } from '@vidcut/shared';
import { analyzeAiPatches } from './aiPatches.js';
import { demoProject } from '../test/fixtures.js';

enablePatches();

/** 用 immer 產生「真的」patch（跟 server 端同一形狀），避免手捏 patch 跟現實脫節。 */
function mutate(
  doc: Project,
  recipe: (d: Project) => void,
): { patches: JsonPatch[]; next: Project } {
  const [next, patches] = produceWithPatches(doc, recipe);
  return { next, patches: patches as JsonPatch[] };
}

describe('analyzeAiPatches', () => {
  it('whole-array replace: new ids are added, modified ids touched, untouched ids neither', () => {
    const prev = demoProject(); // captions: cap1, cap2
    const { patches, next } = mutate(prev, (d) => {
      d.tracks.captions = [
        { ...d.tracks.captions[0]!, text: 'rewritten' }, // cap1 改內容
        d.tracks.captions[1]!, // cap2 原封不動
        { ...d.tracks.captions[0]!, id: 'capN1', start: 8 },
        { ...d.tracks.captions[0]!, id: 'capN2', start: 9 },
      ];
    });
    const fx = analyzeAiPatches(patches, prev, next);
    expect(fx.added.sort()).toEqual(['capN1', 'capN2']);
    expect(fx.touched).toEqual(['cap1']);
    expect(fx.added).not.toContain('cap2');
    expect(fx.touched).not.toContain('cap2');
  });

  it('single-field patch marks that item touched', () => {
    const prev = demoProject();
    const { patches, next } = mutate(prev, (d) => {
      d.tracks.captions[0]!.start = 2.5;
    });
    const fx = analyzeAiPatches(patches, prev, next);
    expect(fx.touched).toEqual(['cap1']);
    expect(fx.added).toEqual([]);
  });

  it('main-track reorder marks the clips whose position changed', () => {
    const prev = demoProject(); // c1, c2
    const { patches, next } = mutate(prev, (d) => {
      d.tracks.video.reverse();
    });
    const fx = analyzeAiPatches(patches, prev, next);
    expect(fx.touched.sort()).toEqual(['c1', 'c2']);
    expect(fx.added).toEqual([]);
  });

  it('an add op yields the new id in added', () => {
    const prev = demoProject();
    const { patches, next } = mutate(prev, (d) => {
      d.tracks.overlays.push({
        id: 'ovNew',
        imagePath: 'x.png',
        start: 4,
        duration: 2,
        position: { x: 0.5, y: 0.1, scale: 1 },
      });
    });
    const fx = analyzeAiPatches(patches, prev, next);
    expect(fx.added).toEqual(['ovNew']);
    expect(fx.touched).toEqual([]);
  });

  it('removed items appear in neither list (nothing to animate)', () => {
    const prev = demoProject();
    const { patches, next } = mutate(prev, (d) => {
      d.tracks.captions.splice(0, 1); // 刪 cap1
    });
    const fx = analyzeAiPatches(patches, prev, next);
    expect(fx.added).not.toContain('cap1');
    expect(fx.touched).not.toContain('cap1');
  });

  it('minStart is the earliest timeline start among added and touched', () => {
    const prev = demoProject();
    const { patches, next } = mutate(prev, (d) => {
      d.tracks.captions[1]!.start = 6; // cap2 → 6s
      d.tracks.audio[0]!.start = 4; // a1 → 4s（最早）
    });
    const fx = analyzeAiPatches(patches, prev, next);
    expect(fx.minStart).toBe(4);
  });

  it('clip edits use the cumulative timeline start of the clip', () => {
    const prev = demoProject(); // c1: 0–6, c2: 6–10
    const { patches, next } = mutate(prev, (d) => {
      d.tracks.video[1]!.duration = 3; // 改 c2
    });
    const fx = analyzeAiPatches(patches, prev, next);
    expect(fx.touched).toEqual(['c2']);
    expect(fx.minStart).toBe(6); // c2 的時間軸起點
  });

  it('non-track patches produce an empty result', () => {
    const prev = demoProject();
    const { patches, next } = mutate(prev, (d) => {
      d.render.status = 'running';
      d.canvas.fit = 'blur';
    });
    const fx = analyzeAiPatches(patches, prev, next);
    expect(fx).toEqual({ touched: [], added: [], minStart: null });
  });

  it('round-trips with applyPatches (same patch shape the UI store consumes)', () => {
    const prev = demoProject();
    const { patches, next } = mutate(prev, (d) => {
      d.tracks.captions[0]!.text = 'x';
    });
    expect(applyPatches(prev, patches as never)).toEqual(next);
  });
});
