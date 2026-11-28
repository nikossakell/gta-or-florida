import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiBase } from "../src/api/client.ts";
import { createQueryClient } from "../src/api/queries.ts";
import { PlayScreen } from "../src/routes/Play.tsx";

function renderWith(ui: ReactNode, client: QueryClient) {
  const rootRoute = createRootRoute({ component: () => <>{ui}</> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("Play screen API states", () => {
  it("shows the withdrawn-round message to every visitor and does not retry", async () => {
    const fetchMock = respond(410, {
      error: {
        code: "ROUND_WITHDRAWN",
        message:
          "This round was withdrawn for a content review. Please check back later.",
      },
    });
    // The app's real retry policy (not a test override) must not hammer a withdrawn round.
    renderWith(<PlayScreen id="today" />, createQueryClient());
    expect(await screen.findByText("Round withdrawn")).toBeInTheDocument();
    expect(
      screen.getByText(/withdrawn for a content review/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /browse past rounds/i }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows "No headlines today" for DAILY_NOT_READY without inventing a round', async () => {
    const fetchMock = respond(503, {
      error: {
        code: "DAILY_NOT_READY",
        message: "Today’s round is not ready yet.",
      },
    });
    renderWith(<PlayScreen id="today" />, createQueryClient());
    expect(await screen.findByText("No headlines today")).toBeInTheDocument();
    expect(
      screen.getByText(/don’t recycle or invent questions/),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("calls the Worker with credentials omitted", async () => {
    const fetchMock = respond(503, {
      error: { code: "DAILY_NOT_READY", message: "x" },
    });
    renderWith(<PlayScreen id="today" />, createQueryClient());
    await screen.findByText("No headlines today");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toMatch(/\/api\/challenge\/today$/);
    expect(init.credentials).toBe("omit");
  });
});

describe("apiBase", () => {
  it("accepts https origins and localhost, rejects everything else", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(apiBase("")).toBe("");
    expect(
      apiBase("https://gta-florida-api-production.example.workers.dev/"),
    ).toBe("https://gta-florida-api-production.example.workers.dev");
    expect(apiBase("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(apiBase("http://api.example.org")).toBe("");
    expect(apiBase("javascript:alert(1)")).toBe("");
    warn.mockRestore();
  });
});
