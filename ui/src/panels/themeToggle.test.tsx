import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { Inspector } from './Inspector.js';
import { useTheme } from '../stores/theme.js';
import { seedProject, resetStores } from '../test/fixtures.js';

/**
 * 主題切換器（spec `2026-08-14-dual-theme-design.md` §4）。
 * 位置：Inspector 的 Shortcuts 彈出層尾端——那是唯一一個「設定類」的既有落點，
 * 不必為它在頂欄多開一個常駐控制項。
 *
 * ⚠️ `fixtures.ts` 的 `resetStores()` 會 `localStorage.clear()`，所以驗持久化
 * 的斷言要在 render 之後才讀。
 */

/** 開啟 Shortcuts 彈出層，回傳裡面的主題切換 button */
function openThemeButton(c: HTMLElement): HTMLButtonElement {
  const opener = Array.from(c.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Shortcuts'),
  );
  if (!opener) throw new Error('Shortcuts button not found');
  act(() => {
    fireEvent.click(opener);
  });
  const btn = c.querySelector<HTMLButtonElement>('button[aria-pressed]');
  if (!btn) throw new Error('theme toggle button not found in popover');
  return btn;
}

beforeEach(() => {
  resetStores();
  useTheme.setState({ theme: 'dark' });
  document.documentElement.removeAttribute('data-theme');
  seedProject();
});

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('Shortcuts 彈出層的主題切換器', () => {
  it('暗版時 aria-pressed 是 false', () => {
    const { container } = render(<Inspector />);
    expect(openThemeButton(container).getAttribute('aria-pressed')).toBe('false');
  });

  it('亮版時 aria-pressed 是 true（不是恆 false）', () => {
    act(() => {
      useTheme.getState().setTheme('paper');
    });
    const { container } = render(<Inspector />);
    expect(openThemeButton(container).getAttribute('aria-pressed')).toBe('true');
  });

  it('點擊 dark→paper：store、localStorage、<html> 屬性同時更新', () => {
    const { container } = render(<Inspector />);
    const btn = openThemeButton(container);
    act(() => {
      fireEvent.click(btn);
    });
    expect(useTheme.getState().theme).toBe('paper');
    expect(localStorage.getItem('vidcutTheme')).toBe('paper');
    expect(document.documentElement.getAttribute('data-theme')).toBe('paper');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('再點一次切回 dark：屬性被移除、localStorage 記 dark', () => {
    const { container } = render(<Inspector />);
    const btn = openThemeButton(container);
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

  it('標籤是英文（產品字串禁用中文）', () => {
    const { container } = render(<Inspector />);
    const label = openThemeButton(container).textContent ?? '';
    expect(label.trim()).not.toBe('');
    // CJK 統一表意文字：產品字串一律英文
    expect(label).not.toMatch(/[一-鿿]/);
  });
});
