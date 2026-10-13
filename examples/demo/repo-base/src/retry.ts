import { sleep } from "./sleep";

export interface RetryOptions {
  /** Retries after the first attempt. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const defaultRetryOptions: RetryOptions = {
  retries: 3,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
};

export function backoff(attempt: number, opts: RetryOptions): number {
  return Math.min(opts.baseDelayMs * 2 ** attempt, opts.maxDelayMs);
}

export async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = defaultRetryOptions,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < opts.retries) await sleep(backoff(attempt, opts));
    }
  }
  throw lastError;
}
