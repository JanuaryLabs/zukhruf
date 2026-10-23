import { setImmediate } from 'node:timers/promises';

import type { AttachableClock, Clock, Db } from 'pg-boss';

// pg-boss counts the statements it has in flight so an attached TestClock
// lets them finish before it moves time on (node_modules/pg-boss/dist/
// activity.js:14-95). node:sqlite answers at once, so what this counts are
// the event-loop turns standing in for pg-boss's I/O.
export class Activity {
  // The queue binds clock.now() into its own statements, so the Postgres
  // clock table an attachment writes (clock.js:140-145, 189) has no receiver.
  static readonly #database: Db = {
    executeSql: async () => ({ rows: [] }),
  };
  // Dispose drops the clock table once no target shares the schema
  // (clock.js:158), so this names no schema a PgBoss could use.
  static readonly #schema = 'sqlite job queue';

  #inFlight = 0;
  #started = 0;
  #waiters: Array<() => void> = [];

  // clock.js:10-12; pg-boss's root exports only TestClock and systemClock.
  static isAttachable(clock: Clock): clock is AttachableClock {
    return 'attach' in clock && typeof clock.attach === 'function';
  }

  // index.js:152-154
  attach(clock: AttachableClock): Promise<AsyncDisposable> {
    return clock.attach({
      db: Activity.#database,
      schema: Activity.#schema,
      idle: () => this.idle(),
    });
  }

  // Runs a statement at once, as PGlite runs each in the order it arrives,
  // and settles with its outcome one turn later, as pg-boss's I/O does.
  query<T>(statement: () => T): Promise<T> {
    let outcome: { value: T } | { error: unknown };
    try {
      outcome = { value: statement() };
    } catch (error) {
      outcome = { error };
    }
    return this.#counted(async () => {
      await setImmediate();
      if ('error' in outcome) {
        throw outcome.error;
      }
      return outcome.value;
    });
  }

  // Runs `notification` one counted turn from now: pg-boss wakes its notify
  // workers at start only after the listener's own I/O (notifier.js:55-57).
  deliver(notification: () => void): Promise<void> {
    return this.#counted(async () => {
      await setImmediate();
      notification();
    });
  }

  // Counted while in flight (activity.js:18-33).
  async #counted<T>(work: () => Promise<T>): Promise<T> {
    this.#inFlight++;
    this.#started++;
    try {
      return await work();
    } finally {
      this.#inFlight--;
      if (this.#inFlight === 0) {
        const settled = this.#waiters;
        this.#waiters = [];
        for (const resolve of settled) {
          resolve();
        }
      }
    }
  }

  // activity.js:77-93: true if it had to wait. A caller whose turn just
  // ended runs on in microtasks and may start another before this one ends.
  async idle(): Promise<boolean> {
    let waited = false;
    for (;;) {
      if (this.#inFlight > 0) {
        waited = true;
        await new Promise<void>((resolve) => this.#waiters.push(resolve));
        continue;
      }
      const seen = this.#started;
      await setImmediate();
      if (this.#inFlight === 0 && this.#started === seen) {
        return waited;
      }
      waited = true;
    }
  }
}
