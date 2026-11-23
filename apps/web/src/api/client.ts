import type {
  AnswerRequest,
  AnswerResponse,
  ApiErrorBody,
  ArchiveResponse,
  ChallengeResponse,
  FinishRequest,
  FinishResponse,
} from '@gof/core';

/** Client-side error codes in addition to the server's ApiErrorCode values. */
export type ClientErrorCode = 'FEED_TIMEOUT' | 'NETWORK' | 'BAD_RESPONSE';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }

  /** 4xx errors won't fix themselves by retrying. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

const TIMEOUT_MS = 10_000;

/**
 * API origin from the build (Cloudflare Pages: VITE_API_BASE_URL per Preview/Production).
 * Only https origins (or http on localhost) are accepted; anything else falls back to same-origin.
 */
export function apiBase(raw: string | undefined = import.meta.env.VITE_API_BASE_URL): string {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol === 'https:' || (local && url.protocol === 'http:')) return url.origin;
  } catch {
    // fall through
  }
  console.warn('Ignoring invalid VITE_API_BASE_URL; using same-origin /api');
  return '';
}

const API_BASE = apiBase();

export function withTimeout(signal?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  if (!signal) return timeout;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      // Public API: no cookies or credentials, ever.
      credentials: 'omit',
      headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
      signal: withTimeout(init.signal),
    });
  } catch (error) {
    const name = (error as Error).name;
    if (name === 'TimeoutError') throw new ApiError('FEED_TIMEOUT', 'The server took too long to respond.');
    if (name === 'AbortError') throw error;
    throw new ApiError('NETWORK', 'Could not reach the server.');
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError('BAD_RESPONSE', `Unexpected response (HTTP ${res.status}).`, res.status);
  }
  if (!res.ok) {
    const err = (body as Partial<ApiErrorBody>)?.error;
    throw new ApiError(err?.code ?? 'BAD_RESPONSE', err?.message ?? `HTTP ${res.status}`, res.status);
  }
  return body as T;
}

/** Talks to the Cloudflare Worker API (apps/worker). */
export const httpApi = {
  challenge: (id: 'today' | string, signal?: AbortSignal) =>
    request<ChallengeResponse>(`/api/challenge/${encodeURIComponent(id)}`, signal ? { signal } : {}),
  archive: (signal?: AbortSignal) => request<ArchiveResponse>('/api/archive', signal ? { signal } : {}),
  answer: (challengeId: string, body: AnswerRequest) =>
    request<AnswerResponse>(`/api/challenge/${encodeURIComponent(challengeId)}/answer`, { method: 'POST', body: JSON.stringify(body) }),
  finish: (challengeId: string, body: FinishRequest) =>
    request<FinishResponse>(`/api/challenge/${encodeURIComponent(challengeId)}/finish`, { method: 'POST', body: JSON.stringify(body) }),
};
