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
      // 字卡與字型：少了這兩條，:5173 上字卡幾何 fetch 會拿到 SPA fallback 的
      // index.html（HTML 不是 JSON → geo='failed' → 每句字幕永久退回 DOM 近似），
      // @font-face 載到 HTML → 字型失效，POST /text-card/preview 直接 404 →
      // 打字三段式的第二段永遠不會發生。也就是說整個字卡功能在 dev 模式下是死的。
      '/text-card': 'http://127.0.0.1:3845',
      '/fonts': 'http://127.0.0.1:3845',
    },
  },
});
