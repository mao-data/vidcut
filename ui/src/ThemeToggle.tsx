import { Moon, Sun } from 'lucide-react';
import { useTheme } from './stores/theme.js';

/**
 * 主題切換（spec `2026-08-14-dual-theme-design.md` §4）。
 * 2026-08-16 使用者定案:從 Properties 的 Shortcuts 彈出層搬上 header——舊落點
 * 「藏在彈出層可發現性低」是記錄在案的已知限制,這次正式解掉。
 * icon 顯示的是**按下去會去的那一面**:暗房裡給太陽(去紙面)、紙上給月亮
 * (回暗房);title 是唯一文字標籤(icon-only,英文)。
 * aria-pressed=「目前是否紙主題」,沿彈出層時代的語意——ThemeToggle.test 與
 * theme-toggle-aria mutant 守著這條 a11y 線。
 */
export function ThemeToggle() {
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);
  const on = theme === 'paper';
  return (
    <button
      className="icon-btn"
      aria-pressed={on}
      title={on ? 'Switch to dark theme' : 'Switch to paper theme'}
      onClick={() => setTheme(on ? 'dark' : 'paper')}
    >
      {on ? <Moon size={14} /> : <Sun size={14} />}
    </button>
  );
}
