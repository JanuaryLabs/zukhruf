import PQueue from 'p-queue';

import type { Startup } from './startup.ts';

// Starts every worker when the pool is constructed, one at a time: each
// creation waits until the previous one settles, as Kubernetes starts the
// pods of an OrderedReady StatefulSet.
export class OrderedReady implements Startup {
  readonly eager = true;
  readonly #queue = new PQueue({ concurrency: 1 });

  turn(settled: Promise<void>): Promise<void> {
    const turn = Promise.withResolvers<void>();
    void this.#queue.add(() => {
      turn.resolve();
      return settled;
    });
    return turn.promise;
  }
}
