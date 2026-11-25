import type { Metadata, StoredPassage } from './passage.ts';

/** Reads passages of the passage contract by id, and the neighbours of a passage in its source. */
export interface PassageStore<M extends Metadata = Metadata> {
  /** Gives each passage that the store holds; an id it does not hold is absent. */
  get(ids: readonly string[]): Promise<ReadonlyMap<string, StoredPassage<M>>>;
  neighbours(options: {
    readonly source: string;
    readonly seq: number;
    readonly windowSize: number;
  }): Promise<StoredPassage<M>[]>;
}
