import { delay } from "./delay";

export interface RetryOptions {
  /** Total attempts, including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Full jitter: each delay is uniform in [0, capped backoff). */
  jitter: boolean;
  shouldRetry: (error: unknown) => boolean;
}

export const defaultRetryOptions: RetryOptions = {
  maxAttempts: 4,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
  jitter: true,
  shouldRetry: () => true,
};

export function backoff(attempt: number, opts: RetryOptions): number {
  const capped = Math.min(opts.baseDelayMs * 2 ** attempt, opts.maxDelayMs);
  return opts.jitter ? Math.random() * capped : capped;
}

export async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = defaultRetryOptions,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!opts.shouldRetry(error)) break;
      if (attempt < opts.maxAttempts) await delay(backoff(attempt, opts));
    }
  }
  throw lastError;
}
