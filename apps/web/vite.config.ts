import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': process.env.RIFF_API_TARGET ?? 'http://127.0.0.1:8787' },
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
