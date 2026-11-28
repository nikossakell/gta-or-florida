/**
 * Imported by main.tsx before the first render: fonts, styles and the pixel engine.
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

if (import.meta.env.DEV) {
  // Preview tools: development builds only (this branch is removed from production bundles).
  void import('./dev/mount.tsx').then((m) => m.mountDevPanel());
}
