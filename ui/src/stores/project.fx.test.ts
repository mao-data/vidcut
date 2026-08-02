import { describe, it, expect, beforeEach } from 'vitest';
import { produceWithPatches, enablePatches } from 'immer';
import type { JsonPatch, Project } from '@vidcut/shared';
import { useProject } from './project.js';
import { useEditFx } from './editFx.js';
import { demoProject, resetStores } from '../test/fixtures.js';

enablePatches();

function patchesFor(doc: Project, recipe: (d: Project) => void): JsonPatch[] {
  const [, patches] = produceWithPatches(doc, recipe);
  return patches as JsonPatch[];
}

describe('project store → editFx wiring', () => {
  let doc: Project;
  beforeEach(() => {
    resetStores();
    useEditFx.getState().clear();
    doc = demoProject();
    useProject.getState().applyServerMsg({ type: 'full', version: 1, doc, history: [] });
  });

  it('an AI patch triggers the edit-fx layer with the touched ids', () => {
    const patches = patchesFor(doc, (d) => {
      d.tracks.captions[0]!.start = 2.5;
    });
    useProject.getState().applyServerMsg({
      type: 'patch',
      version: 2,
      patches,
      source: 'ai',
      label: 'edit caption',
      ts: new Date(0).toISOString(),
    });
    const fx = useEditFx.getState();
    expect(fx.window).toBe(true);
    expect(fx.touched.has('cap1')).toBe(true);
  });

  it('a human patch does not trigger the edit-fx layer', () => {
    const patches = patchesFor(doc, (d) => {
      d.tracks.captions[0]!.start = 2.5;
    });
    useProject.getState().applyServerMsg({
      type: 'patch',
      version: 2,
      patches,
      source: 'human',
      label: 'edit caption',
      ts: new Date(0).toISOString(),
    });
    expect(useEditFx.getState().window).toBe(false);
  });

  it('the doc still applies correctly when fx triggers (no interference)', () => {
    const patches = patchesFor(doc, (d) => {
      d.tracks.captions[0]!.start = 2.5;
    });
    useProject.getState().applyServerMsg({
      type: 'patch',
      version: 2,
      patches,
      source: 'ai',
      label: 'edit caption',
      ts: new Date(0).toISOString(),
    });
    expect(useProject.getState().doc!.tracks.captions[0]!.start).toBe(2.5);
    expect(useProject.getState().version).toBe(2);
  });
});
