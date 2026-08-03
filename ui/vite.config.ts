import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 軟體版本的單一來源是 root package.json（標頭顯示用；專案修訂號是另一回事）
const appVersion = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  server: {
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:3845', ws: true },
      '/media': 'http://127.0.0.1:3845',
      '/api': 'http://127.0.0.1:3845',
      '/assets': 'http://127.0.0.1:3845',
    },
  },
});
