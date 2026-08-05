// ESLint 9 flat config。以型別安全與一致性為主，交由 Prettier 管格式。
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

export default [
  {
    // `.claude/**`：別的 session 的 worktree 會被放在 `.claude/worktrees/<name>/`，
    // 那是**整個 repo 的另一份拷貝**——不排掉的話 lint 會去 lint 別人做到一半的程式碼，
    // 於是 `npm run lint` 的紅綠取決於「此刻剛好有沒有人開著 worktree」（實測同一份工作
    // 樹在 20 分鐘內從 34 個錯 → 0 個錯 → 又回到 34 個錯）。那種紅跟你的改動無關，
    // 而且會讓 `lint && format:check` 這種 `&&` 串永遠跑不到後面那個。
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'projects/**',
      '_skill_extracted/**',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  {
    // Node 腳本（突變引擎、關卡腳本、瀏覽器驗證腳本）：宣告用到的 Node globals
    files: ['scripts/**/*.mjs', 'ui/e2e/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // TypeScript 自己就會檢查未定義變數（含 DOM/Node globals），關掉重複且會誤報的 no-undef。
      'no-undef': 'off',
    },
  },
  prettier,
];
