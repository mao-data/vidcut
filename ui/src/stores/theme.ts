import { create } from 'zustand';

/**
 * 主題（spec `2026-08-14-dual-theme-design.md` §4）：`dark` ＝暗房（現行、預設），
 * `paper` ＝分鏡紙桌面（階段 ③ 才 craft）。
 */
export type Theme = 'dark' | 'paper';

const KEY = 'vidcutTheme';

/**
 * **`dark` 一定要移除屬性、不是設成 `data-theme="dark"`。**
 * 暗版是 `:root` 的預設值，沒有屬性時整份 DOM 與這個功能存在前逐位元組相同——
 * 這是階段 ② 的最高驗收標準（截圖零像素差）的實作面保證。
 */
function apply(t: Theme): void {
  const el = document.documentElement;
  if (t === 'paper') el.setAttribute('data-theme', 'paper');
  else el.removeAttribute('data-theme');
}

/**
 * 初始值優先序：localStorage（只認兩個字面值，壞值當沒有）→ 系統偏好 light → dark。
 * `matchMedia` 走 optional chain：jsdom 與舊環境不保證有它，這裡炸掉會讓整個 UI 白屏。
 */
function initialTheme(): Theme {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    // Safari 隱私模式等讀取失敗：當作沒存過
  }
  if (stored === 'dark' || stored === 'paper') return stored;
  if (window.matchMedia?.('(prefers-color-scheme: light)')?.matches) return 'paper';
  return 'dark';
}

interface ThemeState {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const initial = initialTheme();
// 模組載入時就套用（main.tsx 在 render 之前 import 這個模組）：等 React 掛載才套
// 會先繪一幀錯的主題。
apply(initial);

export const useTheme = create<ThemeState>((set) => ({
  theme: initial,
  setTheme: (t) => {
    set({ theme: t });
    try {
      localStorage.setItem(KEY, t);
    } catch {
      // 寫入失敗：主題只活在這個 session
    }
    apply(t);
  },
}));
