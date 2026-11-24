import { createRoot } from 'react-dom/client';
import { DevPanel } from './DevPanel.tsx';
import './dev.css';

/** Separate React root: the panel can't reach the app's router, query cache or game state. */
export function mountDevPanel(): void {
  const host = document.createElement('div');
  host.id = 'dd-dev';
  document.body.appendChild(host);
  createRoot(host).render(<DevPanel />);
}
