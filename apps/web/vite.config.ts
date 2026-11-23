import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const apiTarget = process.env.API_URL ?? 'http://127.0.0.1:8787';

/**
 * Public base path. "/" for a root domain; "/<repo>/" for a GitHub Pages
 * project site (the Pages workflow sets BASE_PATH from actions/configure-pages).
 */
function basePath(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}/` : '/';
}

/**
 * Cloudflare Pages headers (security headers + CSP). connect-src allows exactly the
 * configured Worker API origin. Pages serves index.html for unknown paths (SPA) on its own
 * because the build has no 404.html.
 */
export function pagesHeaders(apiOrigin: string): string {
  const connect = ["'self'", apiOrigin].filter(Boolean).join(' ');
  return [
    '/*',
    '  X-Content-Type-Options: nosniff',
    '  X-Frame-Options: DENY',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  Cross-Origin-Opener-Policy: same-origin',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=()',
    `  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src ${connect}; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`,
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
  ].join('\n');
}

function cloudflarePagesHeaders(apiBase: string | undefined): Plugin {
  let origin = '';
  try {
    origin = apiBase ? new URL(apiBase).origin : '';
  } catch {
    origin = '';
  }
  return {
    name: 'cloudflare-pages-headers',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: pagesHeaders(origin) });
    },
  };
}

export default defineConfig(({ mode }) => {
  // `--mode pages`: fully static build for GitHub Pages (reads pre-generated JSON, no /api).
  const pages = mode === 'pages';
  const env = loadEnv(mode, '../..', 'VITE_');
  const apiBase = process.env.VITE_API_BASE_URL ?? env.VITE_API_BASE_URL;
  return {
    base: basePath(process.env.BASE_PATH),
    plugins: [react(), tailwindcss(), ...(pages ? [] : [cloudflarePagesHeaders(apiBase)])],
    // Read VITE_* variables from the repo-root .env (only VITE_* reach the browser).
    envDir: '../..',
    server: {
      port: 5173,
      proxy: { '/api': { target: apiTarget, changeOrigin: false } },
    },
    preview: pages ? {} : { proxy: { '/api': { target: apiTarget, changeOrigin: false } } },
    build: {
      // dist/       → Cloudflare Pages (talks to the Worker API)
      // dist-pages/ → legacy fully static demo (pre-generated JSON; Netlify until cutover)
      outDir: pages ? 'dist-pages' : 'dist',
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: !pages,
      // Keep fonts as files: the CSP (public/_headers) allows them from 'self'.
      assetsInlineLimit: 0,
    },
  };
});
