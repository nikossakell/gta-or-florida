import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.API_URL ?? 'http://127.0.0.1:8787';

/**
 * Public base path. "/" for a root domain; "/<repo>/" for a GitHub Pages
 * project site (the Pages workflow sets BASE_PATH from actions/configure-pages).
 */
function basePath(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}/` : '/';
}

export default defineConfig(({ mode }) => {
  // `--mode pages`: fully static build for GitHub Pages (reads pre-generated JSON, no /api).
  const pages = mode === 'pages';
  return {
    base: basePath(process.env.BASE_PATH),
    plugins: [react(), tailwindcss()],
    // Read VITE_* variables from the repo-root .env (only VITE_* reach the browser).
    envDir: '../..',
    server: {
      port: 5173,
      proxy: { '/api': { target: apiTarget, changeOrigin: false } },
    },
    preview: pages ? {} : { proxy: { '/api': { target: apiTarget, changeOrigin: false } } },
    build: {
      // Separate folder so the Node server (which serves dist/) never exposes static answer files.
      outDir: pages ? 'dist-pages' : 'dist',
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: !pages,
      // Keep fonts as files: the API's CSP allows them from 'self'.
      assetsInlineLimit: 0,
    },
  };
});
