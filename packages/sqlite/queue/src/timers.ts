import type { Clock } from 'pg-boss';

// A wait that an abort ends early, resolving rather than rejecting.
export type ClockDelay = Promise<void> & { abort(): void };

// pg-boss's waits, scheduled on the configured clock so a test clock fires
// them (node_modules/pg-boss/dist/tools.js:32-77).
export class Timers {
  // clockDelay: rejects with `error` when the wait runs out, if given.
  static delay(
    clock: Clock,
    ms: number,
    error?: string,
    abortController?: AbortController,
  ): ClockDelay {
    const controller = abortController ?? new AbortController();
    const promise = new Promise<void>((resolve, reject) => {
      const handle = clock.setTimeout(() => {
        controller.signal.removeEventListener('abort', onAbort);
        if (error) {
          reject(new Error(error));
        } else {
          resolve();
        }
      }, ms);
      const onAbort = () => {
        clock.clearTimeout(handle);
        resolve();
      };
      if (controller.signal.aborted) {
        onAbort();
      } else {
        controller.signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    return Object.assign(promise, {
      abort: () => {
        if (!controller.signal.aborted) {
          controller.abort();
        }
      },
    });
  }

  // Races `promise` against `seconds` (at least one), rejecting with
  // `message` when they run out. Settling aborts the controller either way,
  // which is how the deadline cancels itself.
  static async resolveWithinSeconds<T>(
    clock: Clock,
    promise: Promise<T>,
    seconds: number,
    message: string,
    abortController: AbortController,
  ): Promise<T | void> {
    const timeout = Math.max(1, seconds) * 1000;
    const deadline = Timers.delay(clock, timeout, message, abortController);
    try {
      return await Promise.race([promise, deadline]);
    } finally {
      deadline.abort();
    }
  }
}
