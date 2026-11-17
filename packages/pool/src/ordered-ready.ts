import { Lock } from '@zukhruf/async';

import type { Startup } from './startup.ts';

// Starts every worker when the pool is constructed, one at a time: each
// creation waits until the previous one settles, as Kubernetes starts the
// pods of an OrderedReady StatefulSet.
export class OrderedReady implements Startup {
  readonly eager = true;
  readonly #lock = new Lock();

  async turn(settled: Promise<void>): Promise<void> {
    const held = await this.#lock.acquire({ signal: undefined });
    const free = () => held[Symbol.dispose]();
    void settled.then(free, free);
  }
}
