import pRetry, { type Options } from 'p-retry';

/**
 * Options for {@link retryUntilReady} — p-retry's full option surface: `retries`
 * (attempt-count bound), `maxRetryTime` (wall-clock budget, monotonic clock),
 * `minTimeout` / `factor` / `maxTimeout` (interval & backoff), `randomize`,
 * `signal` (external abort), `onFailedAttempt`, `shouldRetry`, `unref`.
 */
export type RetryUntilReadyOptions = Options;

const READINESS_DEFAULTS = {
  retries: Number.POSITIVE_INFINITY,
  factor: 1,
  minTimeout: 250,
  maxRetryTime: 30_000,
} satisfies Options;

/**
 * Retry `fn` until it stops throwing or the budget runs out — the readiness
 * idiom on top of p-retry. The probe throws while the service is down; it
 * keeps re-running it until it doesn't, then resolves with its value.
 *
 * Defaults are tuned for polling a service into existence: a fixed 250ms
 * interval (no exponential backoff) and a 30s wall-clock budget. The retry
 * timer is deliberately NOT unref'd — a readiness wait must keep the event loop
 * alive until it resolves, or it would never settle in a standalone script. On timeout it rejects with the operation's last error (so
 * the failure says *why* the service never came up). Note: p-retry does not
 * retry a non-network `TypeError`, so a bug in the probe aborts immediately
 * instead of looping out the budget.
 *
 * It is for readiness where no test context exists, such as the wait
 * strategy of a server that writes no ready line. A test that polls an assertion uses
 * `waitFor(check, { signal: t.signal })`, which ends at the test's limit.
 *
 * Override any p-retry option to reshape the budget:
 * - `{ maxRetryTime: 60_000 }` — a longer wall-clock window
 * - `{ retries: 120, maxRetryTime: Infinity }` — bound by attempt count instead
 * - `{ minTimeout: 1000, factor: 2 }` — exponential backoff
 * - `{ signal }` — cancel from outside (e.g. a test timeout)
 *
 * @example
 * ```typescript
 * // Wait up to 60s for Postgres to accept queries:
 * await retryUntilReady(
 *   async () => {
 *     await exec(['pg_isready', '-U', user]);
 *     await exec(['psql', '-U', user, '-c', 'SELECT 1']);
 *   },
 *   { maxRetryTime: 60_000 },
 * );
 * ```
 */
export function retryUntilReady<T>(
  fn: (attemptNumber: number) => PromiseLike<T> | T,
  options: RetryUntilReadyOptions = {},
): Promise<T> {
  return pRetry(fn, { ...READINESS_DEFAULTS, ...options });
}
