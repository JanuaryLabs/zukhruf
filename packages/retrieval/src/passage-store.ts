import type { Metadata, StoredPassage } from './passage.ts';

/**
 * Reads passages of the passage contract by id, and the neighbours of a
 * passage in its source. Each call takes an optional `signal`, which it
 * passes to every async call it makes, and rejects with the signal's reason
 * when it aborts (ADR 0017).
 */
export interface PassageStore<M extends Metadata = Metadata> {
  /** Gives each passage that the store holds; an id it does not hold is absent. */
  get(
    ids: readonly string[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<ReadonlyMap<string, StoredPassage<M>>>;
  neighbours(options: {
    readonly source: string;
    readonly seq: number;
    readonly windowSize: number;
    readonly signal?: AbortSignal;
  }): Promise<StoredPassage<M>[]>;
}
