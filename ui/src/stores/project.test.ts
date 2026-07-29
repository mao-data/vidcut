import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyProject } from '@vidcut/shared';
import { useProject } from './project.js';

describe('useProject store', () => {
  beforeEach(() => useProject.setState({ doc: null, version: 0, connected: false }));

  it('full replaces doc', () => {
    const doc = createEmptyProject('p', 'demo');
    useProject.getState().applyServerMsg({ type: 'full', version: 3, doc });
    expect(useProject.getState().doc?.name).toBe('demo');
    expect(useProject.getState().version).toBe(3);
  });

  it('patch applies incrementally when version is consecutive', () => {
    const doc = createEmptyProject('p', 'demo');
    useProject.getState().applyServerMsg({ type: 'full', version: 1, doc });
    useProject.getState().applyServerMsg({
      type: 'patch',
      version: 2,
      source: 'ai',
      label: 'rename',
      patches: [{ op: 'replace', path: ['name'], value: 'renamed' }],
    });
    expect(useProject.getState().doc?.name).toBe('renamed');
    expect(useProject.getState().version).toBe(2);
  });

  it('gapped patch version triggers resync request instead of applying', () => {
    const doc = createEmptyProject('p', 'demo');
    useProject.getState().applyServerMsg({ type: 'full', version: 1, doc });
    const wanted = useProject.getState().applyServerMsg({
      type: 'patch',
      version: 5,
      source: 'ai',
      label: 'x',
      patches: [{ op: 'replace', path: ['name'], value: 'skip' }],
    });
    expect(wanted).toBe('resync'); // caller（ws.ts）負責真的發 resync
    expect(useProject.getState().doc?.name).toBe('demo'); // 未套用
  });
});
