import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * 主題 store（spec `2026-08-14-dual-theme-design.md` §4）。
 *
 * ⚠️ 這個 store 的初始化是**模組載入時的副作用**（讀 localStorage / matchMedia、
 * 立刻套到 `<html>`），所以測「初始化優先序」不能只 import 一次——每個 case 都要
 * 先佈好環境，再 `vi.resetModules()` 重新 import 一份新的模組實例。
 *
 * **最高驗收標準是「暗版視覺零變化」**：`dark` 時 `<html>` 必須**沒有**
 * `data-theme` 屬性（不是 `data-theme="dark"`），這樣預設 DOM 與這個功能存在前
 * 逐位元組相同。下面的斷言釘死這一點。
 */

/** 佈好環境後重新載入 store 模組（觸發它的初始化副作用） */
async function loadStore(): Promise<typeof import('./theme.js')> {
  vi.resetModules();
  return import('./theme.js');
}

/** 把 matchMedia 換成「只有指定 query 為真」的版本 */
function stubMatchMedia(trueQuery: string | null): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: trueQuery !== null && query === trueQuery,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const realMatchMedia = window.matchMedia;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  stubMatchMedia(null);
});

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: realMatchMedia,
  });
  document.documentElement.removeAttribute('data-theme');
});

describe('useTheme 初始化優先序', () => {
  it('沒有任何線索時預設暗版', async () => {
    const { useTheme } = await loadStore();
    expect(useTheme.getState().theme).toBe('dark');
  });

  it('localStorage 有 paper 就用 paper', async () => {
    localStorage.setItem('vidcutTheme', 'paper');
    const { useTheme } = await loadStore();
    expect(useTheme.getState().theme).toBe('paper');
  });

  it('localStorage 有 dark 就用 dark', async () => {
    localStorage.setItem('vidcutTheme', 'dark');
    const { useTheme } = await loadStore();
    expect(useTheme.getState().theme).toBe('dark');
  });

  it('系統偏好 light 時（且無 localStorage）用 paper', async () => {
    stubMatchMedia('(prefers-color-scheme: light)');
    const { useTheme } = await loadStore();
    expect(useTheme.getState().theme).toBe('paper');
  });

  it('localStorage 蓋過系統偏好——存 dark、系統說 light，結果是 dark', async () => {
    localStorage.setItem('vidcutTheme', 'dark');
    stubMatchMedia('(prefers-color-scheme: light)');
    const { useTheme } = await loadStore();
    expect(useTheme.getState().theme).toBe('dark');
  });

  it('localStorage 壞值忽略，回退到系統偏好', async () => {
    localStorage.setItem('vidcutTheme', 'neon');
    stubMatchMedia('(prefers-color-scheme: light)');
    const { useTheme } = await loadStore();
    expect(useTheme.getState().theme).toBe('paper');
  });

  it('localStorage 壞值且系統偏好暗 → dark', async () => {
    localStorage.setItem('vidcutTheme', 'DARK');
    const { useTheme } = await loadStore();
    expect(useTheme.getState().theme).toBe('dark');
  });

  it('jsdom 沒有 matchMedia 時不爆炸（optional chain）', async () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: undefined,
    });
    const { useTheme } = await loadStore();
    expect(useTheme.getState().theme).toBe('dark');
  });
});

describe('模組載入時立即套用到 <html>（避免首繪閃錯主題）', () => {
  it('初始為 dark 時不留下 data-theme 屬性', async () => {
    document.documentElement.setAttribute('data-theme', 'paper');
    localStorage.setItem('vidcutTheme', 'dark');
    await loadStore();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('初始為 paper 時 <html> 帶 data-theme="paper"', async () => {
    localStorage.setItem('vidcutTheme', 'paper');
    await loadStore();
    expect(document.documentElement.getAttribute('data-theme')).toBe('paper');
  });
});

describe('setTheme', () => {
  it('paper：寫 state、寫 localStorage、設 data-theme', async () => {
    const { useTheme } = await loadStore();
    useTheme.getState().setTheme('paper');
    expect(useTheme.getState().theme).toBe('paper');
    expect(localStorage.getItem('vidcutTheme')).toBe('paper');
    expect(document.documentElement.getAttribute('data-theme')).toBe('paper');
  });

  it('dark：**移除** data-theme 屬性（暗版 DOM 必須與此功能存在前完全相同）', async () => {
    localStorage.setItem('vidcutTheme', 'paper');
    const { useTheme } = await loadStore();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(true);
    useTheme.getState().setTheme('dark');
    expect(useTheme.getState().theme).toBe('dark');
    expect(localStorage.getItem('vidcutTheme')).toBe('dark');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('重複呼叫同一個值是冪等的', async () => {
    const { useTheme } = await loadStore();
    useTheme.getState().setTheme('paper');
    useTheme.getState().setTheme('paper');
    expect(useTheme.getState().theme).toBe('paper');
    expect(document.documentElement.getAttribute('data-theme')).toBe('paper');
    useTheme.getState().setTheme('dark');
    useTheme.getState().setTheme('dark');
    expect(useTheme.getState().theme).toBe('dark');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('來回切換：paper→dark→paper 屬性跟著來回', async () => {
    const { useTheme } = await loadStore();
    useTheme.getState().setTheme('paper');
    expect(document.documentElement.getAttribute('data-theme')).toBe('paper');
    useTheme.getState().setTheme('dark');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    useTheme.getState().setTheme('paper');
    expect(document.documentElement.getAttribute('data-theme')).toBe('paper');
  });
});
