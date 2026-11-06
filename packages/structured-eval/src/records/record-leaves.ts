import { isRecord } from '../shared/is-record.ts';
import type { RecordSpec } from './record-spec.ts';
import { hasValue } from './values.ts';

// One step from a record to a value: a key, or the position of an item.
export type Step = string | number;

export type RecordLeaf = {
  readonly steps: readonly Step[];
  readonly field: string;
  readonly value: unknown;
};

// The values of one record that are not objects or arrays, with the steps to
// each, leaving out the fields that the spec ignores. A record that is itself
// such a value, such as unparsed text, is one leaf at no steps.
export class RecordLeaves {
  readonly #spec: RecordSpec;

  constructor(spec: RecordSpec) {
    this.#spec = spec;
  }

  of(record: unknown): Generator<RecordLeaf> {
    return this.#leaves(record, [], '');
  }

  *#leaves(
    value: unknown,
    steps: readonly Step[],
    field: string,
  ): Generator<RecordLeaf> {
    if (field !== '' && this.#spec.ignores(field)) return;
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries())
        yield* this.#leaves(item, [...steps, index], `${field}[]`);
      return;
    }
    if (isRecord(value)) {
      for (const [key, item] of Object.entries(value))
        yield* this.#leaves(
          item,
          [...steps, key],
          field === '' ? key : `${field}.${key}`,
        );
      return;
    }
    if (hasValue(value)) yield { steps, field, value };
  }
}
