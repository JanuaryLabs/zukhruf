import { EventEmitter } from 'node:events';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { type Clock, Latch } from '@zukhruf/async';
import { WriteAheadLog, open } from '@zukhruf/sqlite-open';
import { transaction } from '@zukhruf/sqlite-transaction';

import { integer, integerOrNull, text } from './columns.ts';
import { DisposedError } from './disposed-error.ts';
import { checkChannel, checkPayload } from './limits.ts';
import { Listening, type QueuedNotification } from './listening.ts';
import { QueueFullError } from './queue-full-error.ts';
import { HIGHEST_ID, notifySchema } from './schema.ts';
import { Steps } from './steps.ts';
import { Wakes } from './wakes.ts';

export type NotificationsOptions = FileOptions | ConnectionOptions;

export interface FileOptions {
  path: string;
  database?: never;
  clock: Clock;
  maxQueuedNotifications?: number;
}

export interface ConnectionOptions {
  database: DatabaseSync;
  path?: never;
  clock: Clock;
  maxQueuedNotifications?: number;
}

/** The `Notification` of `pg` (node-postgres): the same fields and types. */
export interface Notification {
  processId: number;
  channel: string;
  payload: string;
}

// Postgres's default queue holds at least this many notifications of the
// largest payload, one for each page (ADR 0005).
const DEFAULT_MAX_QUEUED = 1_048_576;
// A trim at most once a second deletes at most this many rows, about 2 ms
// (research 20i).
const TRIM_INTERVAL = 1000;
const TRIM_LIMIT = 10_000;

/** Postgres's LISTEN and NOTIFY for one SQLite file, among the programs of one computer. */
export class Notifications
  extends EventEmitter<{ notification: [Notification]; error: [unknown] }>
  implements AsyncDisposable
{
  readonly #database: DatabaseSync;
  readonly #owned: boolean;
  readonly #path: string;
  readonly #clock: Clock;
  readonly #maxQueued: number;
  readonly #wakes: Wakes;
  readonly #ends: StatementSync;
  readonly #insert: StatementSync;
  readonly #addresses: StatementSync;
  readonly #trim: StatementSync;
  readonly #removeChannels: StatementSync;
  readonly #removeListener: StatementSync;
  // The channels as the calls asked, at once: unlisten stops a channel before
  // its row is removed.
  readonly #wanted = new Set<string>();
  // listen, unlisten and dispose change the listener one after another.
  readonly #steps = new Steps();
  #listener: Listener = { kind: 'idle' };
  #lastTrim = -Infinity;
  #lifetime: Lifetime = { kind: 'open' };

  constructor(options: NotificationsOptions) {
    super();
    this.#clock = options.clock;
    this.#maxQueued = options.maxQueuedNotifications ?? DEFAULT_MAX_QUEUED;
    if (options.database === undefined) {
      this.#database = open(options.path, {
        journal: new WriteAheadLog({ synchronous: 'full' }),
      });
      this.#owned = true;
    } else {
      this.#database = options.database;
      this.#owned = false;
    }
    const path = this.#database.location();
    if (path === null) {
      if (this.#owned) this.#database.close();
      throw new TypeError(
        'A database in memory has no file that another program can open; give a database on a file.',
      );
    }
    this.#path = path;
    try {
      notifySchema.apply(this.#database);
    } catch (error) {
      if (this.#owned) this.#database.close();
      throw error;
    }
    const database = this.#database;
    this.#ends = database.prepare(
      `SELECT ${HIGHEST_ID} AS highest, (SELECT min(position) FROM zukhruf_notify_listener) AS lowest`,
    );
    this.#insert = database.prepare(
      'INSERT INTO zukhruf_notify_queue (channel, payload, process_id) VALUES (?, ?, ?)',
    );
    this.#addresses = database.prepare(
      'SELECT l.id, l.address FROM zukhruf_notify_listener l JOIN zukhruf_notify_channel c ON c.listener = l.id WHERE c.channel = ?',
    );
    this.#trim = database.prepare(
      `DELETE FROM zukhruf_notify_queue WHERE id IN (SELECT id FROM zukhruf_notify_queue WHERE id <= coalesce((SELECT min(position) FROM zukhruf_notify_listener), ${HIGHEST_ID}) ORDER BY id LIMIT ${TRIM_LIMIT})`,
    );
    this.#removeChannels = database.prepare(
      'DELETE FROM zukhruf_notify_channel WHERE listener = ?',
    );
    this.#removeListener = database.prepare(
      'DELETE FROM zukhruf_notify_listener WHERE id = ?',
    );
    this.#wakes = new Wakes(
      (id) => {
        if (this.#listener.kind !== 'listening') return false;
        const { listening } = this.#listener;
        if (listening.id !== id) return false;
        listening.read();
        return true;
      },
      (error) => this.emit('error', error),
    );
  }

  /** Resolves when the registration has committed; each notification that commits after it comes to `notification`. */
  async listen(channel: string): Promise<void> {
    checkChannel(channel);
    this.#assertOpen();
    this.#wanted.add(channel);
    await this.#steps.run(async () => {
      if (!this.#wanted.has(channel)) return;
      try {
        if (this.#listener.kind === 'listening') {
          this.#listener.listening.add(channel);
          return;
        }
        const listening = await Listening.register(channel, {
          path: this.#path,
          clock: this.#clock,
          deliver: (row) => this.#deliver(row),
          fail: (error) => this.emit('error', error),
        });
        this.#listener = { kind: 'listening', listening };
      } catch (error) {
        this.#wanted.delete(channel);
        throw error;
      }
    });
  }

  /** Stops the notifications of the channel at once; the last one removes the listener's row and closes its socket. */
  async unlisten(channel: string): Promise<void> {
    checkChannel(channel);
    this.#assertOpen();
    this.#wanted.delete(channel);
    await this.#steps.run(async () => {
      if (this.#listener.kind !== 'listening') return;
      if (await this.#listener.listening.remove(channel))
        this.#listener = { kind: 'idle' };
    });
  }

  /**
   * Inserts the notification in the current transaction of the sending
   * connection, or in a BEGIN IMMEDIATE transaction of its own. The wakes go
   * out on the next microtask, after the transaction ended (ADR 0004).
   */
  notify(channel: string, payload = ''): void {
    checkChannel(channel);
    checkPayload(payload);
    this.#assertOpen();
    const dead = this.#wakes.dead();
    const listeners = transaction(
      this.#database,
      () => {
        for (const id of dead.keys()) {
          this.#removeChannels.run(id);
          this.#removeListener.run(id);
        }
        // The highest id minus the lowest position: two reads of indexes,
        // exact, where a count(*) scans the table (research 20i).
        const ends = this.#ends.get();
        const lowest = integerOrNull(ends, 'lowest');
        if (
          lowest !== null &&
          integer(ends, 'highest') - lowest >= this.#maxQueued
        )
          throw new QueueFullError();
        this.#insert.run(channel, payload, process.pid);
        const read = this.#addresses.all(channel).map((row) => ({
          id: text(row, 'id'),
          address: text(row, 'address'),
        }));
        this.#trimAtMostOnceASecond();
        return read;
      },
      { mode: 'immediate' },
    );
    this.#wakes.sent(dead, listeners);
  }

  /** Writes the wakes that are due, ends the connections to other listeners, removes this listener's rows, closes its socket and the connections that it opened. */
  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#lifetime.kind === 'open') {
      const ended = new Latch<PromiseSettledResult<void>>();
      this.#lifetime = { kind: 'disposed', ended };
      const [outcome] = await Promise.allSettled([this.#dispose()]);
      ended.open(outcome);
    }
    const outcome = await this.#lifetime.ended.wait();
    if (outcome.status === 'rejected') throw outcome.reason;
  }

  async #dispose(): Promise<void> {
    this.#wanted.clear();
    await this.#steps.run(async () => {
      try {
        await this.#wakes.close();
        if (this.#listener.kind === 'listening') {
          const { listening } = this.#listener;
          this.#listener = { kind: 'idle' };
          await listening.end();
        }
      } finally {
        if (this.#owned) this.#database.close();
      }
    });
  }

  #trimAtMostOnceASecond(): void {
    const now = this.#clock.performance.now();
    if (now - this.#lastTrim < TRIM_INTERVAL) return;
    this.#lastTrim = now;
    this.#trim.run();
  }

  // A notification listener that throws sends its error to `error`, and the
  // next notifications of the read still come.
  #deliver(row: QueuedNotification): void {
    if (!this.#wanted.has(row.channel)) return;
    try {
      this.emit('notification', {
        processId: row.processId,
        channel: row.channel,
        payload: row.payload,
      });
    } catch (error) {
      this.emit('error', error);
    }
  }

  #assertOpen(): void {
    if (this.#lifetime.kind === 'disposed') throw new DisposedError();
  }
}

type Listener =
  | { readonly kind: 'idle' }
  | { readonly kind: 'listening'; readonly listening: Listening };

type Lifetime =
  | { readonly kind: 'open' }
  | {
      readonly kind: 'disposed';
      readonly ended: Latch<PromiseSettledResult<void>>;
    };
