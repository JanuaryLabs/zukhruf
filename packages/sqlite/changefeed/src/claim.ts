import type { MapState, PartitionContext } from '@zukhruf/checkpoint';

import {
  type TableShape,
  fingerprintFormat,
  tableShapeFormat,
} from './formats.ts';
import type { WalProgress } from './wal-frames.ts';

/** How far the feed read the owner's WAL at its last pass. */
export type Seen = { readonly wal: WalProgress | null };

/** What a watch commits: a claim, or no batch before the watch claims one. */
export interface Commits<W> {
  commit(options?: CommitOptions<W>): Promise<void>;
}

// What a claim saw: the claimed checkpoint until a pass gives a batch, then
// the last batch. Only a batch has a position to commit.
interface Progress {
  /** undefined while the start applies. */
  readonly seen: Seen | undefined;
  position(): WalProgress | null;
}

export type CommitOptions<W> = {
  /** Runs in the transaction of the commit: the host's output commits with the position. */
  readonly write?: W;
  readonly signal?: AbortSignal;
};

/**
 * The partition that one watch claimed, and what its passes gave that no
 * commit saved yet: the map states hold those changes, and the last batch
 * its WAL progress.
 */
export class Claim<W> implements Commits<W> {
  readonly #context: PartitionContext<WalProgress | null, W>;
  readonly tables: MapState<TableShape>;
  #progress: Progress;

  constructor(context: PartitionContext<WalProgress | null, W>) {
    this.#context = context;
    this.tables = context.state('tables', tableShapeFormat);
    const checkpoint = context.checkpoint;
    this.#progress = {
      seen: checkpoint === undefined ? undefined : { wal: checkpoint.position },
      position: () => {
        throw new TypeError('The feed gave no batch to commit');
      },
    };
  }

  /**
   * What the last batch of this watch saw, else what the claimed checkpoint
   * saw; undefined while the start applies.
   */
  seen(): Seen | undefined {
    return this.#progress.seen;
  }

  /** The fingerprint of each key of one table. */
  fingerprints(table: string): MapState<string> {
    return this.#context.state(`table:${table}`, fingerprintFormat);
  }

  give(seen: Seen): void {
    this.#progress = { seen, position: () => seen.wal };
  }

  async commit(options?: CommitOptions<W>): Promise<void> {
    await this.#context.commit(this.#progress.position(), options);
  }
}
