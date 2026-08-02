import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 元件測試需要 DOM；純邏輯測試在 jsdom 下也照跑（成本可忽略），
// 因此全域設 jsdom 而不是逐檔 docblock，少一個會被忘記的步驟。
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx'],
    },
  },
});
