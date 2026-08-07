import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyProject } from '@vidcut/shared';
import { useProject } from './project.js';
import { useActivity } from './activity.js';

describe('useProject store', () => {
  beforeEach(() => {
    useProject.setState({ doc: null, version: 0, connected: false });
    useActivity.setState({ entries: [] });
  });

  it('full replaces doc and seeds activity from history', () => {
    const doc = createEmptyProject('p', 'demo');
    useProject.getState().applyServerMsg({
      type: 'full',
      version: 3,
      doc,
      history: [{ version: 3, label: 'seed', source: 'ai', ts: '2026-07-29T00:00:00Z' }],
    });
    expect(useProject.getState().doc?.name).toBe('demo');
    expect(useProject.getState().version).toBe(3);
    expect(useActivity.getState().entries).toHaveLength(1);
  });

  it('patch applies incrementally and appends activity', () => {
    const doc = createEmptyProject('p', 'demo');
    useProject.getState().applyServerMsg({ type: 'full', version: 1, doc, history: [] });
    useProject.getState().applyServerMsg({
      type: 'patch',
      version: 2,
      source: 'human',
      label: 'rename',
      ts: '2026-07-29T00:00:01Z',
      patches: [{ op: 'replace', path: ['name'], value: 'renamed' }],
    });
    expect(useProject.getState().doc?.name).toBe('renamed');
    expect(useProject.getState().version).toBe(2);
    expect(useActivity.getState().entries.at(-1)).toMatchObject({
      label: 'rename',
      source: 'human',
    });
  });

  it('gapped patch version triggers resync request instead of applying', () => {
    const doc = createEmptyProject('p', 'demo');
    useProject.getState().applyServerMsg({ type: 'full', version: 1, doc, history: [] });
    const wanted = useProject.getState().applyServerMsg({
      type: 'patch',
      version: 5,
      source: 'ai',
      label: 'x',
      ts: '2026-07-29T00:00:02Z',
      patches: [{ op: 'replace', path: ['name'], value: 'skip' }],
    });
    expect(wanted).toBe('resync');
    expect(useProject.getState().doc?.name).toBe('demo');
  });

  it('textCards stores capId → hash and returns ok (no resync loop)', () => {
    const doc = createEmptyProject('p', 'demo');
    useProject.getState().applyServerMsg({ type: 'full', version: 1, doc, history: [] });
    const result = useProject.getState().applyServerMsg({
      type: 'textCards',
      entries: [
        { id: 'cap1', hash: 'aaa111' },
        { id: 'cap2', hash: 'bbb222' },
      ],
    });
    expect(result).toBe('ok');
    expect(useProject.getState().captionCards).toEqual({ cap1: 'aaa111', cap2: 'bbb222' });
    // version 未跟著這則旁路訊息前進——它不是 patch
    expect(useProject.getState().version).toBe(1);
  });
});
