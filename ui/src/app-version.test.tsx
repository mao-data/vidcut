import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App.js';
import { Activity } from './panels/Activity.js';
import { useProject } from './stores/project.js';
import { seedProject, resetStores } from './test/fixtures.js';
import * as ws from './ws.js';

/**
 * spec 2026-08-03-version-undo-redo B1/B2/B5：
 * 標頭顯示軟體版本（非修訂號）、進度讀旁路、Redo 入口。
 */

describe('標頭版本語意（B1；2026-08-16 使用者定案修訂）', () => {
  beforeEach(() => {
    resetStores();
    seedProject();
  });

  // 原斷言是「顯示軟體 semver、不顯示修訂號」。2026-08-16 使用者定案把
  // `v{版本} · {專案名}` 整個從 header 移除——「修訂號不上門面」這半條精神
  // 續留並加嚴成「任何版本字樣都不上門面」;守這條的 header-shows-rev mutant
  // 因目標碼消失一併退役(見 EVIDENCE.md 本日補記)。
  it('標頭不顯示任何版本字樣（軟體版本與修訂號都不上門面）', () => {
    useProject.setState({ version: 149 });
    const { container } = render(<App />);
    const header = container.querySelector('header')!;
    expect(header.textContent).not.toMatch(/v\d+\.\d+\.\d+/);
    expect(header.textContent).not.toContain('v149');
  });
});

describe('渲染進度旁路（B2/B5）', () => {
  beforeEach(() => {
    resetStores();
    seedProject();
  });

  it('renderProgress 訊息更新進度，且不動 doc/version', () => {
    const before = useProject.getState().version;
    useProject.getState().applyServerMsg({ type: 'renderProgress', progress: 0.42 });
    const s = useProject.getState();
    expect(s.renderProgress).toBe(0.42);
    expect(s.version).toBe(before); // 暫態訊息不推進版本
  });

  it('渲染完成的 patch 會清掉暫態進度', () => {
    useProject.getState().applyServerMsg({ type: 'renderProgress', progress: 0.9 });
    useProject.getState().applyServerMsg({
      type: 'patch',
      version: useProject.getState().version + 1,
      patches: [{ op: 'replace', path: ['render'], value: { status: 'done', progress: 1 } }],
      source: 'ai',
      label: 'render done',
      ts: new Date().toISOString(),
    });
    expect(useProject.getState().renderProgress).toBeNull();
  });
});

describe('Redo 入口（B5）', () => {
  beforeEach(() => {
    resetStores();
    seedProject();
  });

  it('Activity 的 Redo 鈕送出 redo 命令', async () => {
    const spy = vi.spyOn(ws, 'sendCommand').mockImplementation(() => {});
    render(<Activity />);
    await userEvent.click(screen.getByRole('button', { name: /redo/i }));
    expect(spy).toHaveBeenCalledWith({ name: 'redo', steps: 1 });
    spy.mockRestore();
  });
});
