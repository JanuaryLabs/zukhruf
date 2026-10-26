import type { Startup } from './startup.ts';

// Starts every worker when the pool is constructed, all at the same time.
export class Parallel implements Startup {
  readonly eager = true;

  turn(): Promise<void> {
    return Promise.resolve();
  }
}
