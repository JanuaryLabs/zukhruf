import { ChangeWatcher, type WallClock } from '@zukhruf/async';
import type { ConsumerGroup } from '@zukhruf/checkpoint';
import { DataVersion } from '@zukhruf/sqlite-data-version';
import { Snapshot } from '@zukhruf/sqlite-snapshot';

import type { ChangeEvent } from './change-event.ts';
import { Claim, type CommitOptions, type Commits } from './claim.ts';
import { walProgressFormat } from './formats.ts';
import { pass, requireWal } from './pass.ts';
import type { Start } from './start.ts';

export type WatchOptions = {
  /** Milliseconds between two polls of the data version. */
  readonly interval: number;
  /** Stops the poll. The loop then rejects with `signal.reason`. */
  readonly signal: AbortSignal;
  /** The clock of the poll: `globalThis` in production, a fake clock in a test. */
  readonly clock: WallClock;
};

export type ChangefeedOptions<W> = {
  /**
   * The consumer group that keeps the feed's checkpoint. The host owns its
   * store; the feed never closes it.
   */
  readonly checkpoints: ConsumerGroup<W>;
  /** The name of the owner's database in the group: one stream, partition '0'. */
  readonly stream: string;
  /** What the first pass gives while the partition has no checkpoint. */
  readonly start: Start;
};

/**
 * A change event for each changed row of each table of a SQLite database
 * that another process owns.
 */
export class Changefeed<W> implements Disposable {
  readonly #path: string;
  readonly #version: DataVersion;
  readonly #checkpoints: ConsumerGroup<W>;
  readonly #stream: string;
  readonly #start: Start;
  // The claim of the last watch, which commits its batches.
  #claim: Commits<W> = {
    commit: () =>
      Promise.reject(new TypeError('The feed gave no batch to commit')),
  };

  constructor(
    databasePath: string,
    { checkpoints, stream, start }: ChangefeedOptions<W>,
  ) {
    this.#path = databasePath;
    this.#checkpoints = checkpoints;
    this.#stream = stream;
    this.#start = start;
    using resources = new DisposableStack();
    this.#version = resources.use(new DataVersion(databasePath));
    {
      using snapshot = new Snapshot(databasePath);
      requireWal(snapshot);
    }
    resources.move();
  }

  /**
   * The change events of each pass, an empty batch too. The watch claims the
   * stream's partition, which fences each older claim, and goes on from its
   * checkpoint. A batch is saved only by a commit.
   */
  async *watch({
    interval,
    signal,
    clock,
  }: WatchOptions): AsyncGenerator<readonly ChangeEvent[], void, undefined> {
    const claim = new Claim(
      await this.#checkpoints.claim(
        { stream: this.#stream, partition: '0' },
        walProgressFormat,
        { signal },
      ),
    );
    this.#claim = claim;
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
      yield await pass(this.#path, claim, this.#start);
    }
    // The poll ends only when the signal aborts.
    signal.throwIfAborted();
  }

  /**
   * Saves every batch that the watch gave so far, all or none, as Kafka's
   * commitSync saves the offsets of the last poll. With `write`, the host's
   * output commits in the same transaction. A feed that a newer claim fenced
   * throws CheckpointFencedError and runs no write. Rejects with a TypeError
   * before the watch gave a batch.
   */
  commit(options?: CommitOptions<W>): Promise<void> {
    return this.#claim.commit(options);
  }

  [Symbol.dispose](): void {
    this.#version[Symbol.dispose]();
  }
}
