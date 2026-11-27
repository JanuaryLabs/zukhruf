import type { SignalOption } from './checkpoint.ts';

type Batch<P> = {
  readonly position: P;
  readonly size: number;
};

type Highest<P> =
  { readonly kind: 'none' } | { readonly kind: 'at'; readonly position: P };

/**
 * The batches that a reader handles out of order, in the order that it read
 * them, after Go's `Jeffail/checkpoint` (ADR 0010). The highest position is
 * the last position below which each batch is done.
 */
class Batches<P> {
  readonly #open: Batch<P>[] = [];
  readonly #done = new Set<Batch<P>>();
  readonly #released = new WeakSet<Batch<P>>();
  #highest: Highest<P> = { kind: 'none' };
  #pending = 0;

  get pending(): number {
    return this.#pending;
  }

  highest(): P | undefined {
    return this.#highest.kind === 'at' ? this.#highest.position : undefined;
  }

  track(position: P, size: number): () => P | undefined {
    const batch: Batch<P> = { position, size };
    this.#open.push(batch);
    this.#pending += size;
    return () => {
      if (!this.#released.has(batch)) {
        this.#released.add(batch);
        this.#done.add(batch);
        this.#pending -= batch.size;
        this.#advance();
      }
      return this.highest();
    };
  }

  #advance(): void {
    for (;;) {
      const first = this.#open[0];
      if (first === undefined || !this.#done.has(first)) return;
      this.#open.shift();
      this.#done.delete(first);
      this.#highest = { kind: 'at', position: first.position };
    }
  }
}

/** A tracker that never waits (`Jeffail/checkpoint`'s `Uncapped`). */
export class UncappedTracker<P> {
  readonly #batches = new Batches<P>();

  /** The size of the batches that are not done. */
  get pending(): number {
    return this.#batches.pending;
  }

  /** The last position below which each batch is done, if one is. */
  highest(): P | undefined {
    return this.#batches.highest();
  }

  /**
   * Records a batch in the order that the reader read it. The function marks
   * it done, and gives the highest position.
   */
  track(position: P, size: number): () => P | undefined {
    return this.#batches.track(position, size);
  }
}

/**
 * A tracker that waits while more than its capacity is not done
 * (`Jeffail/checkpoint`'s `Capped`). A batch larger than the capacity waits
 * until no batch is open.
 */
export class CappedTracker<P> {
  readonly #batches = new Batches<P>();
  readonly #capacity: number;
  readonly #waiting: (() => void)[] = [];

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  get pending(): number {
    return this.#batches.pending;
  }

  highest(): P | undefined {
    return this.#batches.highest();
  }

  async track(
    position: P,
    size: number,
    options?: SignalOption,
  ): Promise<() => P | undefined> {
    while (!this.#fits(size)) await this.#wait(options?.signal);
    options?.signal?.throwIfAborted();
    const done = this.#batches.track(position, size);
    return () => {
      const highest = done();
      for (const wake of this.#waiting.splice(0)) wake();
      return highest;
    };
  }

  #fits(size: number): boolean {
    const pending = this.#batches.pending;
    return pending === 0 || pending + size <= this.#capacity;
  }

  async #wait(signal: AbortSignal | undefined): Promise<void> {
    signal?.throwIfAborted();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const abort = () => reject(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    this.#waiting.push(resolve);
    try {
      await promise;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
}
