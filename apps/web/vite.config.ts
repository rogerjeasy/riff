import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const api = process.env.RIFF_API_TARGET ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // Keep the browser's Host so the server's same-origin guard sees the console origin.
    proxy: {
      '/directory': { target: api, changeOrigin: false, xfwd: true },
      '/peer': { target: api, changeOrigin: false, xfwd: true },
      '/api': { target: api, changeOrigin: false, xfwd: true },
      '/auth': { target: api, changeOrigin: false, xfwd: true },
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true, changeOrigin: false, xfwd: true },
    },
  },
  build: {
    manifest: true,
    rolldownOptions: {
      input: {
        console: resolve(import.meta.dirname, 'index.html'),
        overlay: resolve(import.meta.dirname, 'overlay/index.html'),
        dock: resolve(import.meta.dirname, 'dock/index.html'),
      },
    },
  },
});
