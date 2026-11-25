import type { Metadata } from '../index.ts';

/**
 * A host's metadata reader for a passage store, such as a zod schema's
 * `parse`, that also records the columns of each row it reads and each
 * metadata it gives. A test then sees that a passage carries the very
 * metadata that the reader gave, even where it equals the columns.
 */
export class RecordingMetadata<M extends Metadata> {
  readonly columns: Metadata[] = [];
  readonly #given = new WeakSet<M>();
  readonly #parse: (columns: Metadata) => M;

  constructor(parse: (columns: Metadata) => M) {
    this.#parse = parse;
  }

  readonly read = (columns: Metadata): M => {
    this.columns.push(columns);
    const metadata = this.#parse(columns);
    this.#given.add(metadata);
    return metadata;
  };

  /** Whether the reader gave this metadata. */
  gave(metadata: M): boolean {
    return this.#given.has(metadata);
  }
}
