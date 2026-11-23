import { httpApi } from './client.ts';
import { createStaticApi } from './static.ts';

/**
 * `vite build --mode pages` → static JSON files (GitHub Pages, no server).
 * Any other mode → the Cloudflare Worker API (VITE_API_BASE_URL, or same-origin /api in dev).
 * Decided at build time, so the unused client is tree-shaken away.
 */
export const isStaticSite = import.meta.env.MODE === 'pages';

export const api: typeof httpApi = isStaticSite ? createStaticApi(import.meta.env.BASE_URL) : httpApi;

export { ApiError } from './client.ts';
