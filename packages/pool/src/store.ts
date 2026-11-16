import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { WallClock } from '@zukhruf/async';
import { Notifications } from '@zukhruf/sqlite-notify';
import { WriteAheadLog, open } from '@zukhruf/sqlite-open';
import {
  SqliteJobQueue,
  type SqliteJobQueueOptions,
} from '@zukhruf/sqlite-queue';

import type { WorkerKind } from './worker-kind.ts';

// The least heartbeat that pg-boss accepts (attorney.js:578). A job of a dead
// owner goes back to the store about 11 s after its last touch (ADR 0017).
const HEARTBEAT_SECONDS = 10;

type BossClock = NonNullable<SqliteJobQueueOptions['clock']>;

/**
 * The store of one computer: a SQLite file, which its job queue and its
 * notifications use on one connection, and the folder of the file, where the
 * election keeps its claim files (ADR 0015). Each pass of the queue's
 * supervisor runs every second, and its monitor in each pass, so a job whose
 * heartbeat ended goes back about a second later (ADR 0017).
 */
export class Store implements AsyncDisposable {
  readonly folder: string;
  readonly queue: SqliteJobQueue;
  readonly notifications: Notifications;
  readonly #database: DatabaseSync;

  constructor(address: string, clock: WallClock) {
    if (/^postgres(?:ql)?:\/\//.test(address))
      throw new TypeError(
        'A postgres:// store is not built yet: the store of one computer is the path of a SQLite file (ADR 0025).',
      );
    this.folder = dirname(address);
    mkdirSync(this.folder, { recursive: true });
    // The journal of @zukhruf/sqlite-queue's own file (its ADR 0005).
    this.#database = open(address, {
      journal: new WriteAheadLog({ synchronous: 'full' }),
    });
    this.queue = new SqliteJobQueue({
      database: this.#database,
      clock: bossClock(clock),
      superviseIntervalSeconds: 1,
      monitorIntervalSeconds: 1,
      schedule: false,
    });
    this.notifications = new Notifications({
      database: this.#database,
      clock,
    });
  }

  /** Starts the queue, and creates the queue of the kind's revision with the kind's rules. */
  async start<Input, Output>(kind: WorkerKind<Input, Output>): Promise<void> {
    await this.queue.start();
    await this.queue.createQueue(kind.queue, {
      policy: kind.policy,
      retryLimit: kind.retryLimit,
      expireInSeconds: kind.expireInSeconds,
      heartbeatSeconds: HEARTBEAT_SECONDS,
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.notifications[Symbol.asyncDispose]();
    await this.queue.stop();
    this.#database.close();
  }
}

/** pg-boss's clock, which the queue takes, on the clock of the pool. */
function bossClock(clock: WallClock): BossClock {
  return {
    now: () => clock.Date.now(),
    setTimeout: (callback, ms) => clock.setTimeout(callback, ms),
    clearTimeout: (timer) => clock.clearTimeout(timer),
    setInterval: (callback, ms) => new Interval(clock, callback, ms),
    clearInterval: (interval) => {
      if (interval instanceof Interval) interval.clear();
    },
  };
}

/** A repeating timer made of one timer at a time on the clock. */
class Interval {
  readonly #clock: WallClock;
  #timer: unknown;

  constructor(clock: WallClock, callback: () => void, ms: number) {
    this.#clock = clock;
    const tick = () => {
      this.#timer = clock.setTimeout(tick, ms);
      callback();
    };
    this.#timer = clock.setTimeout(tick, ms);
  }

  clear(): void {
    this.#clock.clearTimeout(this.#timer);
  }
}
