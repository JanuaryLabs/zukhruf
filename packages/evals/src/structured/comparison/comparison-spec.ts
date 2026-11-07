import type { Alignment } from './alignment.ts';
import { ByPosition } from './alignments/by-position.ts';
import type { Comparator } from './comparator.ts';
import { JsonEquality } from './comparators/json-equality.ts';
import type { Field } from './field.ts';
import { JsonPathQuery } from './json-path-query.ts';

export type ComparisonSpecOptions = {
  // The alignment of each array, by its field, such as `$.offers`. An array
  // that the spec does not name pairs by position.
  readonly arrays?: Readonly<Record<string, Alignment>>;
  // The comparator of every leaf that `fields` does not name.
  readonly comparator?: Comparator;
  // The comparator of one field, such as `$.offers[*].value.amount`.
  readonly fields?: Readonly<Record<string, Comparator>>;
  // The fields that the walk does not compare, each with all its children.
  readonly exclude?: readonly string[];
};

// The rules to compare two values of one kind. A key is a field written as a
// JSONPath query (RFC 9535) of name selectors and the wildcard selector, such
// as `$.offers[*].value.amount` or `$['a.b']`; `$` is the root. A key that is
// not such a query throws a SyntaxError when the spec is built.
export class ComparisonSpec {
  static readonly #byPosition = new ByPosition();

  readonly #comparator: Comparator;
  readonly #arrays: ReadonlyMap<string, Alignment>;
  readonly #fields: ReadonlyMap<string, Comparator>;
  readonly #exclude: ReadonlySet<string>;

  constructor(options: ComparisonSpecOptions = {}) {
    this.#comparator = options.comparator ?? new JsonEquality();
    this.#arrays = ComparisonSpec.#byField(options.arrays ?? {});
    this.#fields = ComparisonSpec.#byField(options.fields ?? {});
    this.#exclude = new Set(
      (options.exclude ?? []).map((key) => new JsonPathQuery(key).field.id),
    );
  }

  alignmentOf(field: Field): Alignment {
    return this.#arrays.get(field.id) ?? ComparisonSpec.#byPosition;
  }

  comparatorOf(field: Field): Comparator {
    return this.#fields.get(field.id) ?? this.#comparator;
  }

  excludes(field: Field): boolean {
    return this.#exclude.has(field.id);
  }

  static #byField<T>(entries: Readonly<Record<string, T>>): Map<string, T> {
    return new Map(
      Object.entries(entries).map(([key, value]) => [
        new JsonPathQuery(key).field.id,
        value,
      ]),
    );
  }
}
