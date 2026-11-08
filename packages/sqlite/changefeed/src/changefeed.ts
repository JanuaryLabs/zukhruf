import { ChangeWatcher, type WallClock } from '@zukhruf/async';
import { DataVersion } from '@zukhruf/sqlite-data-version';
import { Snapshot } from '@zukhruf/sqlite-snapshot';

import type { Batch } from './batch.ts';
import { pass, requireWal } from './pass.ts';
import type { Position } from './position.ts';
import type { Start } from './start.ts';

export type WatchOptions = {
  /** Milliseconds between two polls of the data version. */
  readonly interval: number;
  /** Stops the poll. The loop then rejects with `signal.reason`. */
  readonly signal: AbortSignal;
  /** The clock of the poll: `globalThis` in production, a fake clock in a test. */
  readonly clock: WallClock;
};

export type ChangefeedOptions<B extends Batch = Batch> = {
  /**
   * Where the feed keeps what it saw. The feed owns it, and disposes it. Its
   * kind sets the batches: a PositionFile gives a SequencedBatch.
   */
  readonly position: Position<B>;
  /** What the first pass gives, until the position is saved once. */
  readonly start: Start;
};

/**
 * A change event for each changed row of each table of a SQLite database
 * that another process owns.
 */
export class Changefeed<B extends Batch = Batch> implements Disposable {
  readonly #path: string;
  readonly #version: DataVersion;
  readonly #position: Position<B>;
  readonly #start: Start;
  readonly #resources: DisposableStack;

  constructor(databasePath: string, { position, start }: ChangefeedOptions<B>) {
    using resources = new DisposableStack();
    // The feed owns its position also when the database fails to open.
    this.#position = resources.use(position);
    this.#start = start;
    this.#path = databasePath;
    this.#version = resources.use(new DataVersion(databasePath));
    {
      using snapshot = new Snapshot(databasePath);
      requireWal(snapshot);
    }
    this.#resources = resources.move();
  }

  /**
   * Batches of change events. The feed saves the position of a batch when
   * the loop asks for the next one.
   */
  async *watch({
    interval,
    signal,
    clock,
  }: WatchOptions): AsyncGenerator<B, void, undefined> {
    // The data version is a local read: a check that takes the whole
    // interval is stuck.
    const watcher = new ChangeWatcher([this.#version], {
      interval,
      timeout: interval,
      clock,
    });
    for await (const outcomes of watcher.watch(signal)) {
      const outcome = outcomes.get(this.#version);
      // The feed cannot go on without its data version.
      if (outcome?.state === 'failed') throw outcome.error;
      if (outcome?.state !== 'changed') continue;
      const { events, update } = await pass(
        this.#path,
        this.#position,
        this.#start,
      );
      if (events.length === 0) {
        // A pass with no events, a baseline too, has no batch to deliver.
        this.#position.save(update);
        continue;
      }
      yield this.#position.batch(events);
      // The loop may not have applied a batch that an abort stopped.
      signal.throwIfAborted();
      this.#position.save(update);
    }
    // The poll ends only when the signal aborts.
    signal.throwIfAborted();
  }

  [Symbol.dispose](): void {
    this.#resources.dispose();
  }
}
