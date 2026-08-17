import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { ThemeToggle } from './ThemeToggle.js';
import { useTheme } from './stores/theme.js';
import { resetStores } from './test/fixtures.js';

/**
 * 主題切換器（spec `2026-08-14-dual-theme-design.md` §4）。
 * 2026-08-16 自 `panels/themeToggle.test.tsx` 搬家:切換器從 Shortcuts 彈出層
 * 搬上 header,測試直接 render 元件、不再需要開彈出層的 helper。五條斷言
 * 逐條保留;唯一實質調整是「標籤是英文」——按鈕改 icon-only,文字標籤在
 * `title`,斷言改驗 title(意圖不變:有非空的英文無障礙標籤)。
 *
 * ⚠️ `fixtures.ts` 的 `resetStores()` 會 `localStorage.clear()`,所以驗持久化
 * 的斷言要在 render 之後才讀。
 */

function themeButton(c: HTMLElement): HTMLButtonElement {
  const btn = c.querySelector<HTMLButtonElement>('button[aria-pressed]');
  if (!btn) throw new Error('theme toggle button not found');
  return btn;
}

beforeEach(() => {
  resetStores();
  useTheme.setState({ theme: 'dark' });
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('header 的主題切換器', () => {
  it('暗版時 aria-pressed 是 false', () => {
    const { container } = render(<ThemeToggle />);
    expect(themeButton(container).getAttribute('aria-pressed')).toBe('false');
  });

  it('亮版時 aria-pressed 是 true（不是恆 false）', () => {
    act(() => {
      useTheme.getState().setTheme('paper');
    });
    const { container } = render(<ThemeToggle />);
    expect(themeButton(container).getAttribute('aria-pressed')).toBe('true');
  });

  it('點擊 dark→paper：store、localStorage、<html> 屬性同時更新', () => {
    const { container } = render(<ThemeToggle />);
    const btn = themeButton(container);
    act(() => {
      fireEvent.click(btn);
    });
    expect(useTheme.getState().theme).toBe('paper');
    expect(localStorage.getItem('vidcutTheme')).toBe('paper');
    expect(document.documentElement.getAttribute('data-theme')).toBe('paper');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('再點一次切回 dark：屬性被移除、localStorage 記 dark', () => {
    const { container } = render(<ThemeToggle />);
    const btn = themeButton(container);
    act(() => {
      fireEvent.click(btn);
    });
    act(() => {
      fireEvent.click(btn);
    });
    expect(useTheme.getState().theme).toBe('dark');
    expect(localStorage.getItem('vidcutTheme')).toBe('dark');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('title 是非空英文標籤（icon-only,產品字串禁用中文）', () => {
    const { container } = render(<ThemeToggle />);
    const title = themeButton(container).getAttribute('title') ?? '';
    expect(title.trim()).not.toBe('');
    // CJK 統一表意文字：產品字串一律英文
    expect(title).not.toMatch(/[一-鿿]/);
  });
});
