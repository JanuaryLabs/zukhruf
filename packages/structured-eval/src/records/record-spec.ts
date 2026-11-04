import type { Alignment } from './alignment.ts';
import { ByPosition } from './alignments/by-position.ts';
import type { Comparator } from './comparator.ts';
import { Exact } from './comparators/exact.ts';
import { NoSchema } from './schema/no-schema.ts';
import type { SchemaRule } from './schema/schema-rule.ts';

export type RecordSpecOptions = {
  readonly schema?: SchemaRule;
  readonly arrays?: Readonly<Record<string, Alignment>>;
  readonly fields?: Readonly<Record<string, Comparator>>;
  readonly ignore?: readonly string[];
};

const byPosition = new ByPosition();
const exact = new Exact();

// The rules to compare two records of one kind. A field is a path without its
// item positions, such as `offers[].value.amount`; an array is named by its
// field, such as `offers`.
export class RecordSpec {
  readonly schema: SchemaRule;
  readonly #arrays: Readonly<Record<string, Alignment>>;
  readonly #fields: Readonly<Record<string, Comparator>>;
  readonly #ignore: readonly string[];

  constructor(options: RecordSpecOptions = {}) {
    this.schema = options.schema ?? new NoSchema();
    this.#arrays = options.arrays ?? {};
    this.#fields = options.fields ?? {};
    this.#ignore = options.ignore ?? [];
  }

  alignmentOf(field: string): Alignment {
    return this.#arrays[field] ?? byPosition;
  }

  comparatorOf(field: string): Comparator {
    return this.#fields[field] ?? exact;
  }

  // An ignored field is out with all its children: the walk stops at it.
  ignores(field: string): boolean {
    return this.#ignore.includes(field);
  }
}
