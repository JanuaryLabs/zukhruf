import type { Passage } from './passage.ts';

/** Reads passages of the passage contract by id, and the neighbours of a passage in its source. */
export interface PassageStore {
  /** Gives each passage that the store holds; an id it does not hold is absent. */
  get(ids: readonly string[]): Promise<ReadonlyMap<string, Passage>>;
  neighbours(options: {
    readonly source: string;
    readonly seq: number;
    readonly windowSize: number;
  }): Promise<Passage[]>;
}
