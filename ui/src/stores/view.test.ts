import { describe, it, expect, beforeEach } from 'vitest';
import { useView } from './view.js';

/**
 * 涵蓋兩個冪等展開：
 *   `openLeft`  AgentStrip 點擊要「指向活動流而且看得到它」（活動流 2026-08-16
 *               版面重構後住在左邊的 AI 專區）
 *   `openRight` 選了東西要「跳到 Properties 分頁而且看得到它」
 * 兩者都不能用 `toggle*`——本來就開著的話會被關掉，正好相反的效果。
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

describe('useView.openLeft（冪等展開）', () => {
  it('收合時展開', () => {
    useView.setState({ leftOpen: false });
    useView.getState().openLeft();
    expect(useView.getState().leftOpen).toBe(true);
  });

  it('已經開著時維持開著——不是 toggle', () => {
    useView.getState().openLeft();
    expect(useView.getState().leftOpen).toBe(true);
    useView.getState().openLeft();
    expect(useView.getState().leftOpen).toBe(true);
  });

  it('不動右欄', () => {
    useView.setState({ leftOpen: false, rightOpen: false });
    useView.getState().openLeft();
    expect(useView.getState().rightOpen).toBe(false);
  });

  it('已經開著時不通知訂閱者（避免無謂重繪）', () => {
    let notified = 0;
    const un = useView.subscribe(() => {
      notified += 1;
    });
    useView.getState().openLeft();
    useView.getState().openLeft();
    expect(notified).toBe(0);
    un();
  });
});
