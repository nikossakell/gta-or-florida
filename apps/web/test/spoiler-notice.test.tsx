/**
 * Spoiler policy (Nov 2026): minor GTA story spoilers may appear in daily rounds, so a short notice is shown
 * discreetly in the landing footer and on About. No modal, checkbox or extra gameplay step.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { Disclaimer, SPOILER_NOTICE } from '../src/components/ui.tsx';
import { About } from '../src/routes/About.tsx';

function withRouter(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({ routeTree: createRootRoute({ component: () => <>{ui}</> }), history: createMemoryHistory({ initialEntries: ['/'] }) });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('spoiler notice', () => {
  it('uses the agreed wording', () => {
    expect(SPOILER_NOTICE).toBe('Some questions may contain minor spoilers from the Grand Theft Auto series.');
  });

  it('is part of the legacy footer disclaimer, next to the existing notices', async () => {
    withRouter(<Disclaimer />);
    expect(await screen.findByText(SPOILER_NOTICE)).toBeTruthy();
    expect(screen.getByText(/Not affiliated with or endorsed by Rockstar Games/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('is repeated in the About page disclaimer', async () => {
    withRouter(<About />);
    expect(await screen.findByText((text) => text.startsWith(SPOILER_NOTICE))).toBeTruthy();
  });
});
