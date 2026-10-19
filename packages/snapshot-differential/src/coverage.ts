import {
  DeletionPolicy,
  type VanishedRecord,
  type Verdict,
} from './deletion-policy.ts';

// An upstream that holds only part of its records and says which part, as a
// cache does: a vanished key the scan covers was deleted; one it does not
// cover is unknown until a later scan covers it or lists it again.
export class Coverage extends DeletionPolicy {
  readonly #covers: (record: VanishedRecord) => boolean;

  constructor(covers: (record: VanishedRecord) => boolean) {
    super();
    this.#covers = covers;
  }

  override vanished(record: VanishedRecord): Verdict {
    return this.#covers(record) ? 'deleted' : 'unknown';
  }
}
