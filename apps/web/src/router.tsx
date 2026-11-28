import { isIsoDate } from '@gof/core';
import { createRootRoute, createRoute, createRouter, Outlet, useParams, useSearch } from '@tanstack/react-router';
import { About, NotFound } from './routes/About.tsx';
import { Archive } from './routes/Archive.tsx';
import { DriveLanding } from './daily-drive/screens/DriveLanding.tsx';
import { PlayScreen } from './routes/Play.tsx';
import { ResultsScreen } from './routes/Results.tsx';

const rootRoute = createRootRoute({
  component: () => (
    <>
      <a href="#content" className="skip">
        Skip to content
      </a>
      <div id="content">
        <Outlet />
      </div>
    </>
  ),
  notFoundComponent: NotFound,
});

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: DriveLanding });

const playTodayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/play',
  component: () => <PlayScreen id="today" />,
});

function PlayDate() {
  const { date } = useParams({ from: '/play/$date' });
  const { replay } = useSearch({ from: '/play/$date' });
  if (!isIsoDate(date)) return <NotFound />;
  return <PlayScreen key={`${date}:${replay ? 'r' : 's'}`} id={date} practice={replay === true} />;
}

const playDateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/play/$date',
  validateSearch: (search: Record<string, unknown>): { replay?: boolean } =>
    search.replay === true || search.replay === 'true' ? { replay: true } : {},
  component: PlayDate,
});

function ResultsRoute() {
  const { date } = useParams({ from: '/results/$date' });
  if (!isIsoDate(date)) return <NotFound />;
  return <ResultsScreen date={date} />;
}

const resultsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/results/$date', component: ResultsRoute });
const archiveRoute = createRoute({ getParentRoute: () => rootRoute, path: '/archive', component: Archive });
const aboutRoute = createRoute({ getParentRoute: () => rootRoute, path: '/about', component: About });

const routeTree = rootRoute.addChildren([indexRoute, playTodayRoute, playDateRoute, resultsRoute, archiveRoute, aboutRoute]);

export function createAppRouter() {
  return createRouter({
    routeTree,
    // Serve from a sub-path such as https://user.github.io/gta-or-florida/
    basepath: import.meta.env.BASE_URL.replace(/\/+$/, '') || '/',
    defaultPreload: 'intent',
    scrollRestoration: true,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
