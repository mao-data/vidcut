import { describe, it, expect, beforeEach } from 'vitest';
import { useView } from './view.js';

/**
 * 目前只涵蓋 `openRight`——AgentStrip 點擊要「切到 Activity 分頁而且看得到它」，
 * 用 `toggleRight` 的話右欄本來開著就會被關掉（正好相反的效果）。
 * 其餘 view state（縮放/吸附/寬度）由 `panelResize.test.ts` 與元件測試涵蓋。
 */

beforeEach(() => {
  useView.setState({ leftOpen: true, rightOpen: true });
});

describe('useView.openRight（冪等展開）', () => {
  it('收合時展開', () => {
    useView.setState({ rightOpen: false });
    useView.getState().openRight();
    expect(useView.getState().rightOpen).toBe(true);
  });

  it('已經開著時維持開著——不是 toggle', () => {
    useView.getState().openRight();
    expect(useView.getState().rightOpen).toBe(true);
    useView.getState().openRight();
    expect(useView.getState().rightOpen).toBe(true);
  });

  it('不動左欄', () => {
    useView.setState({ leftOpen: false, rightOpen: false });
    useView.getState().openRight();
    expect(useView.getState().leftOpen).toBe(false);
  });

  it('已經開著時不通知訂閱者（避免無謂重繪）', () => {
    let notified = 0;
    const un = useView.subscribe(() => {
      notified += 1;
    });
    useView.getState().openRight();
    useView.getState().openRight();
    expect(notified).toBe(0);
    un();
  });
});
