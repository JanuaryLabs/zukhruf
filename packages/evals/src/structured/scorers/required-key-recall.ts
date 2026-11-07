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
export class RequiredKeyRecall implements Scorer<Comparison> {
  score(comparison: Comparison): Ratio {
    const required = new Set(
      RequiredKeyRecall.#requiredFields(
        comparison.schema.value,
        new Field([]),
      ).map((field) => field.id),
    );
    const stated = new Set(comparison.statedFields().map((field) => field.id));
    return new Ratio(required.intersection(stated).size, required.size);
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
