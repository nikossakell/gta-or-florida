import '@fontsource/shrikhand/400.css';
import '@fontsource-variable/archivo/wdth.css';
import './styles.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createQueryClient } from './api/queries.ts';
import { createAppRouter } from './router.tsx';
// Daily Drive redesign: styles, fonts and the pixel engine. With the flag off, vite.config.ts swaps this
// import for an empty module, so the legacy bundle is unchanged.
import './daily-drive/boot.ts';

const queryClient = createQueryClient();
const router = createAppRouter();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
