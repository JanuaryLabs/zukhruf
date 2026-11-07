import type { JsonData } from '@zukhruf/python';

import type { JsonSchema, Validation } from '../schema/json-schema.ts';
import type { Case } from '../scoring/case.ts';
import type { Field } from './field.ts';
import type { ItemPairs } from './item-pairs.ts';
import type { LeafPair } from './leaf-pair.ts';
import type { Path } from './path.ts';

// What a comparison holds of the whole stated value, also when it holds the
// leaf pairs of one field only.
type Whole = {
  readonly stated: JsonData;
  readonly statedPaths: readonly Path[];
  validation?: Validation;
};

// The result of the walk for one stated value and its case: the leaf pairs,
// the item pairs of each array, and if the stated value is parsed. The
// scorers share it, so each fact is computed once.
export class Comparison {
  readonly case: Case;
  // parse_candidate of SOB's evaluate.py: only an object or an array counts
  // as parsed.
  readonly parsed: boolean;
  // The stated value when it is parsed, else null (the candidate of
  // evaluate.py).
  readonly stated: JsonData;
  #whole: Whole;
  readonly #leaves: readonly LeafPair[];
  readonly #arrays: readonly ItemPairs[];

  constructor(
    testCase: Case,
    stated: JsonData,
    leaves: readonly LeafPair[],
    statedPaths: readonly Path[],
    arrays: readonly ItemPairs[],
  ) {
    this.case = testCase;
    this.parsed = stated instanceof Map || Array.isArray(stated);
    this.stated = this.parsed ? stated : null;
    this.#whole = { stated, statedPaths };
    this.#leaves = leaves;
    this.#arrays = arrays;
  }

  // The leaf pairs: the expected leaves in the order of the expected value,
  // as evaluate.py reads them. With nullIsMissing, a null side is no value,
  // so a pair keeps only its other side, and a pair of two nulls goes.
  leaves(
    { nullIsMissing }: { readonly nullIsMissing: boolean } = {
      nullIsMissing: false,
    },
  ): readonly LeafPair[] {
    if (!nullIsMissing) return this.#leaves;
    return this.#leaves.flatMap((pair): LeafPair[] => {
      const expected =
        pair.expected?.value === null ? undefined : pair.expected;
      const stated = pair.stated?.value === null ? undefined : pair.stated;
      if (expected !== undefined && stated !== undefined) return [pair];
      if (expected !== undefined) return [{ expected }];
      if (stated !== undefined) return [{ stated }];
      return [];
    });
  }

  // The item pairs of each array that the walk reached, on either side.
  arrays(): readonly ItemPairs[] {
    return this.#arrays;
  }

  // The fields of the leaf pairs and of the item pairs, each once, in the
  // order the walk reached them.
  fields(): readonly Field[] {
    const fields = new Map<string, Field>();
    for (const pair of this.#leaves) {
      const field = (pair.expected ?? pair.stated).path.field;
      if (!fields.has(field.id)) fields.set(field.id, field);
    }
    for (const { field } of this.#arrays)
      if (!fields.has(field.id)) fields.set(field.id, field);
    return [...fields.values()];
  }

  // The comparison of one field: its leaf pairs and its item pairs. The
  // facts of the whole stated value stay, so a gate such as SchemaCompliance
  // still reads the whole record.
  only(field: Field): Comparison {
    const comparison = new Comparison(
      this.case,
      this.#whole.stated,
      this.#leaves.filter(
        (pair) => (pair.expected ?? pair.stated).path.field.id === field.id,
      ),
      this.#whole.statedPaths,
      this.#arrays.filter((items) => items.field.id === field.id),
    );
    comparison.#whole = this.#whole;
    return comparison;
  }

  // The field of each value of the stated value under its root, of objects
  // and arrays too.
  statedFields(): readonly Field[] {
    return this.#whole.statedPaths.map((path) => path.field);
  }

  // The JSON Schema of the case. A scorer that reads it throws for a case
  // without one.
  get schema(): JsonSchema {
    const { schema } = this.case;
    if (schema === undefined)
      throw new Error(
        'The case has no JSON Schema: give its case reader one, for the scorers that read the schema',
      );
    return schema;
  }

  // schema_compliance of evaluate.py: parsed, a valid schema, and the stated
  // value agrees with it.
  get compliant(): boolean {
    return this.parsed && this.schema.valid && this.validation.valid;
  }

  // What the validator says about the stated value; the schema must be
  // valid.
  get validation(): Validation {
    this.#whole.validation ??= this.schema.validate(this.#whole.stated);
    return this.#whole.validation;
  }
}
