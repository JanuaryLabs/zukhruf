import type { Clock } from '@zukhruf/async';
import type { Client } from '@zukhruf/rpc';

import type { HostMethods } from './protocol.ts';

/**
 * The host's clock, as the notifications in the thread read it. Each timer is
 * armed on the host's clock and fires when the host says so, and
 * `performance.now()` is the time the host sent last, which comes before each
 * of its messages.
 */
export class HostClock implements Clock {
  readonly #host: Client<HostMethods>;
  readonly #timers = new Map<number, () => void>();
  #nextTimer = 0;
  #now = 0;
  readonly performance = { now: () => this.#now };

  constructor(host: Client<HostMethods>) {
    this.#host = host;
  }

  setTimeout(callback: () => void, ms: number): number {
    const timer = this.#nextTimer++;
    this.#timers.set(timer, callback);
    this.#host.notify('arm', [timer, ms]);
    return timer;
  }

  clearTimeout(timer: unknown): void {
    if (typeof timer === 'number' && this.#timers.delete(timer)) {
      this.#host.notify('disarm', [timer]);
    }
  }

  update(now: number) {
    this.#now = now;
  }

  fire(timer: number) {
    const callback = this.#timers.get(timer);
    if (!callback) return;
    this.#timers.delete(timer);
    callback();
  }
}
