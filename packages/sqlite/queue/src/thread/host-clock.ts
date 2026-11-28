import type { AttachableClock } from 'pg-boss';

import type { Client } from '@zukhruf/rpc';

import type { HostMethods } from './protocol.ts';

type Timer = { callback: () => void; repeat: boolean };

/** What waits for the engine's statements: the engine's activity once it attached, else nothing. */
type Target = { idle(): Promise<boolean> };

const detached: Target = { idle: async () => false };

/**
 * The host's clock, as the engine in the thread reads it. Each timer is armed
 * on the host's clock and fires when the host says so, and `now()` is the
 * time the host sent last, which comes before each of its messages. The
 * engine attaches to it as to a `TestClock`, so the host's attached clock can
 * wait for the engine's statements through `idle()`.
 */
export class HostClock implements AttachableClock {
  readonly #host: Client<HostMethods>;
  readonly #timers = new Map<number, Timer>();
  #nextTimer = 0;
  #now = 0;
  #target = detached;

  constructor(host: Client<HostMethods>) {
    this.#host = host;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): number {
    return this.#arm(callback, ms, false);
  }

  setInterval(callback: () => void, ms: number): number {
    return this.#arm(callback, ms, true);
  }

  clearTimeout(timer: unknown): void {
    if (typeof timer === 'number' && this.#timers.delete(timer)) {
      this.#host.notify('disarm', [timer]);
    }
  }

  clearInterval(timer: unknown): void {
    this.clearTimeout(timer);
  }

  async attach({
    idle,
  }: {
    idle?: () => Promise<boolean>;
  }): Promise<AsyncDisposable> {
    this.#target = idle ? { idle } : detached;
    return {
      [Symbol.asyncDispose]: async () => {
        this.#target = detached;
      },
    };
  }

  update(now: number) {
    this.#now = now;
  }

  fire(timer: number) {
    const due = this.#timers.get(timer);
    if (!due) return;
    if (!due.repeat) this.#timers.delete(timer);
    due.callback();
  }

  idle(): Promise<boolean> {
    return this.#target.idle();
  }

  #arm(callback: () => void, ms: number, repeat: boolean): number {
    const timer = this.#nextTimer++;
    this.#timers.set(timer, { callback, repeat });
    this.#host.notify('arm', [timer, ms, repeat]);
    return timer;
  }
}
