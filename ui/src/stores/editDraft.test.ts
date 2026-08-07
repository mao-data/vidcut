import { describe, it, expect, beforeEach } from 'vitest';
import { useEditDraft } from './editDraft.js';

beforeEach(() => useEditDraft.getState().clear());

describe('editDraft', () => {
  it('setText 建 draft 並清 previewHash', () => {
    useEditDraft.getState().setText('c1', '哈');
    useEditDraft.getState().setPreview('c1', 'h1');
    useEditDraft.getState().setText('c1', '哈囉');
    expect(useEditDraft.getState().caption).toEqual({ id: 'c1', text: '哈囉', previewHash: null });
  });
  it('setPreview 只在 id 吻合時生效(過期回應丟棄)', () => {
    useEditDraft.getState().setText('c1', 'x');
    useEditDraft.getState().setPreview('c2', 'stale');
    expect(useEditDraft.getState().caption?.previewHash).toBeNull();
  });
});
