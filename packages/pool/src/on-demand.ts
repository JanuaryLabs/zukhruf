import type { Startup } from './startup.ts';

// Starts a worker only when a job needs one, so a pool nobody uses costs
// nothing.
export class OnDemand implements Startup {
  readonly eager = false;

  turn(): Promise<void> {
    return Promise.resolve();
  }
}
