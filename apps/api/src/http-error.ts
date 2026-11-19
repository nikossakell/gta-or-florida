import type { ApiErrorCode } from '@gof/core';

export class HttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly headers: Record<string, string>;

  constructor(status: number, code: ApiErrorCode, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
