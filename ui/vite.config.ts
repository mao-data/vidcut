import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:3845', ws: true },
      '/media': 'http://127.0.0.1:3845',
      '/api': 'http://127.0.0.1:3845',
    },
  },
});
