import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.API_URL ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Read VITE_* variables from the repo-root .env (only VITE_* reach the browser).
  envDir: '../..',
  server: {
    port: 5173,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
  preview: {
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Keep fonts as files: the API's CSP allows them from 'self'.
    assetsInlineLimit: 0,
  },
});
