import type { JsonData } from '@zukhruf/python';

import { Ratio } from '../../aggregation/ratio.ts';
import type { Scorer } from '../../scorers/scorer.ts';
import type { Comparison } from '../comparison/comparison.ts';
import { Field } from '../comparison/field.ts';
import { dictGet } from '../comparison/json-value.ts';

// The required paths of the schema that the stated value has, over the
// required paths (compute_required_key_recall). A schema that requires none
// gives a ratio with the whole 0 (evaluate.py gives 1). It has no gate: evaluate.py scores it only for a
// parsed value and a valid schema (evaluate.py:296-300), and its caller
// composes that with Penalized.
//
// evaluate.py requires the keys of an item of an array also where the stated
// value has no item, so an empty array, which the schema allows, lacks them:
// a right answer to a case that expects no item scores below a wrong one that
// states an item. With statedItemsOnly the keys of an item are required only
// under an array where the stated value has an item, as the `items` of a JSON
// Schema asks nothing of an array with no item.
export class RequiredKeyRecall implements Scorer<Comparison> {
  readonly #statedItemsOnly: boolean;

  constructor({
    statedItemsOnly = false,
  }: { readonly statedItemsOnly?: boolean } = {}) {
    this.#statedItemsOnly = statedItemsOnly;
  }

  score(comparison: Comparison): Ratio {
    const stated = new Set(comparison.statedFields().map((field) => field.id));
    const required = new Set(
      RequiredKeyRecall.#requiredFields(comparison.schema.value, new Field([]))
        .filter(
          (field) =>
            !this.#statedItemsOnly ||
            RequiredKeyRecall.#items(field).every((item) =>
              stated.has(item.id),
            ),
        )
        .map((field) => field.id),
    );
    return new Ratio(required.intersection(stated).size, required.size);
  }

  // The items that a field lies under: offers[*] and offers[*].tiers[*] for
  // offers[*].tiers[*].name.
  static #items(field: Field): Field[] {
    return field.steps.flatMap((step, at) =>
      step === Field.item ? [new Field(field.steps.slice(0, at + 1))] : [],
    );
  }

  // required_paths of evaluate.py: the required keys of each object schema,
  // through `properties` and `items` only, as fields: evaluate.py writes an
  // item as [], at any position.
  static #requiredFields(schema: JsonData, field: Field): Field[] {
    if (!(schema instanceof Map)) return [];
    const type = schema.get('type');
    const results: Field[] = [];
    if (type === 'object') {
      const properties = dictGet(schema, 'properties', new Map());
      for (const key of RequiredKeyRecall.#iterate(
        dictGet(schema, 'required', []),
      )) {
        const child =
          properties instanceof Map
            ? dictGet(properties, String(key), new Map())
            : new Map();
        const keyField = field.child(String(key));
        results.push(
          keyField,
          ...RequiredKeyRecall.#requiredFields(child, keyField),
        );
      }
    } else if (type === 'array') {
      results.push(
        ...RequiredKeyRecall.#requiredFields(
          dictGet(schema, 'items', new Map()),
          field.child(Field.item),
        ),
      );
    }
    return results;
  }

  // A Python for loop over a list, the keys of a dict, or the characters of a
  // str.
  static #iterate(value: JsonData): readonly JsonData[] {
    if (Array.isArray(value)) return value;
    if (value instanceof Map) return [...value.keys()];
    if (typeof value === 'string') return [...value];
    return [];
  }
}
