/**
 * Imported by main.tsx before the first render. Only when DAILY_DRIVE is on: otherwise vite.config.ts
 * replaces this module with boot-off.ts.
 * Fonts are self-hosted (@fontsource): the production CSP only allows fonts from 'self'.
 */
import '@fontsource/press-start-2p/latin-400.css';
import '@fontsource/silkscreen/latin-400.css';
import '@fontsource/silkscreen/latin-700.css';
import '@fontsource/rubik/latin-400.css';
import '@fontsource/rubik/latin-500.css';
import '@fontsource/rubik/latin-600.css';
import '@fontsource/rubik/latin-700.css';
import './css/daily-drive.css';
import * as engine from './engine/pixel-engine.js';
import { provideEngine } from './engine.ts';
import { prefersReducedMotion } from './lib/motion.ts';

engine.setReducedMotion(prefersReducedMotion);
provideEngine(engine);
document.documentElement.classList.add('dd');

if (import.meta.env.DEV) {
  // Preview tools: development builds only (this branch is removed from production bundles).
  void import('./dev/mount.tsx').then((m) => m.mountDevPanel());
}
