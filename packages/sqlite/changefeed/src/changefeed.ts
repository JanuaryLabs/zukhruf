import { pollChanges } from '@zukhruf/async';
import { DataVersion } from '@zukhruf/sqlite-data-version';
import { Snapshot } from '@zukhruf/sqlite-snapshot';

import type { ChangeEvent } from './change-event.ts';
import { pass, requireWal } from './pass.ts';
import { PositionFile } from './position-file.ts';
import { PositionInMemory } from './position-in-memory.ts';
import type { Position } from './position.ts';

export type WatchOptions = {
  /** Milliseconds between two polls of the data version. */
  readonly interval: number;
  /** Stops the poll. The loop then rejects with `signal.reason`. */
  readonly signal: AbortSignal;
};

// One run of watch: the position it compares with, and whether its first
// pass is a baseline that gives no batch.
type Run = { readonly position: Position; readonly baseline: boolean };

/**
 * A change event for each changed row of each table of a SQLite database
 * that another process owns. With a position path the feed is durable and
 * goes on from its last saved batch; without one it observes from now.
 */
export class Changefeed implements Disposable {
  readonly #path: string;
  readonly #version: DataVersion;
  readonly #run: () => Run;
  readonly #resources: DisposableStack;

  constructor(databasePath: string, positionPath?: string) {
    using resources = new DisposableStack();
    this.#path = databasePath;
    this.#version = resources.use(new DataVersion(databasePath));
    {
      using snapshot = new Snapshot(databasePath);
      requireWal(snapshot);
    }
    if (positionPath === undefined) {
      this.#run = () => ({ position: new PositionInMemory(), baseline: true });
    } else {
      const file = resources.use(new PositionFile(positionPath));
      this.#run = () => ({ position: file, baseline: false });
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
  }: WatchOptions): AsyncGenerator<ChangeEvent[], void, undefined> {
    const { position, baseline } = this.#run();
    let silent = baseline;
    for await (const changed of pollChanges(
      new Map([['database', async () => this.#version.current]]),
      { interval, signal },
    )) {
      if (changed.size === 0) continue;
      const { events, update } = await pass(this.#path, position);
      if (silent || events.length === 0) {
        // A baseline, or a pass with no events, has no batch to deliver.
        position.save(update);
        silent = false;
        continue;
      }
      yield events;
      // The loop may not have applied a batch that an abort stopped.
      signal.throwIfAborted();
      position.save(update);
    }
    // The poll ends only when the signal aborts.
    signal.throwIfAborted();
  }

  [Symbol.dispose](): void {
    this.#resources.dispose();
  }
}
