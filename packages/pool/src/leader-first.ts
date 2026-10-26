import { Latch } from '@zukhruf/async';

import type { Startup } from './startup.ts';

// Starts every worker when the pool is constructed. The first starts alone and
// the others start together once it settles, as when the first worker fills a
// cache that the others then read instead of rebuilding it. A replacement
// after a crash starts at once, since the first creation has settled.
export class LeaderFirst implements Startup {
  readonly eager = true;
  readonly #leader = new Latch();
  // The first creation leads; every later one waits for it.
  #turn = (settled: Promise<void>): Promise<void> => {
    void settled.then(() => this.#leader.open());
    this.#turn = () => this.#leader.wait();
    return Promise.resolve();
  };

  turn(settled: Promise<void>): Promise<void> {
    return this.#turn(settled);
  }
}
