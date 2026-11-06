import type { JsonData } from '@zukhruf/python';

import { Ratio } from '../../aggregation/ratio.ts';
import type { JsonPair } from '../json-pair.ts';
import { dictGet } from '../json-value.ts';
import type { Metric } from '../metric.ts';

// The required paths of the schema that the stated value has
// (compute_required_key_recall), and whenNoneRequired when the schema requires
// none (evaluate.py gives 1). It has no gate: evaluate.py scores it only for a
// parsed value and a valid schema (evaluate.py:296-300), and its caller
// composes that with Gated.
export class RequiredKeyRecall implements Metric {
  readonly #whenNoneRequired: number;

  constructor({ whenNoneRequired }: { readonly whenNoneRequired: number }) {
    this.#whenNoneRequired = whenNoneRequired;
  }

  of({ candidate, testCase: { schema } }: JsonPair): number {
    const required = new Set(
      RequiredKeyRecall.#requiredPaths(schema.value, ''),
    );
    if (required.size === 0) return this.#whenNoneRequired;
    const present = new Set(
      [...RequiredKeyRecall.#presentPaths(candidate, '')].map((path) =>
        RequiredKeyRecall.#wildcardPath(path),
      ),
    );
    return new Ratio(required.intersection(present).size, required.size).value;
  }

  // required_paths of evaluate.py: the required keys of each object schema,
  // through `properties` and `items` only.
  static #requiredPaths(schema: JsonData, prefix: string): string[] {
    if (!(schema instanceof Map)) return [];
    const type = schema.get('type');
    const results: string[] = [];
    if (type === 'object') {
      const properties = dictGet(schema, 'properties', new Map());
      for (const key of RequiredKeyRecall.#iterate(
        dictGet(schema, 'required', []),
      )) {
        const child =
          properties instanceof Map
            ? dictGet(properties, String(key), new Map())
            : new Map();
        const path = prefix ? `${prefix}.${String(key)}` : String(key);
        results.push(path, ...RequiredKeyRecall.#requiredPaths(child, path));
      }
    } else if (type === 'array') {
      results.push(
        ...RequiredKeyRecall.#requiredPaths(
          dictGet(schema, 'items', new Map()),
          prefix ? `${prefix}[]` : '[]',
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

  // flatten_present_paths of evaluate.py: every path, of containers too.
  static #presentPaths(
    value: JsonData | undefined,
    prefix: string,
  ): Set<string> {
    const paths = new Set<string>();
    if (prefix) paths.add(prefix);
    if (value instanceof Map)
      for (const [key, child] of value)
        for (const path of RequiredKeyRecall.#presentPaths(
          child,
          prefix ? `${prefix}.${key}` : key,
        ))
          paths.add(path);
    else if (Array.isArray(value))
      for (const [index, child] of value.entries())
        for (const path of RequiredKeyRecall.#presentPaths(
          child,
          `${prefix}[${index}]`,
        ))
          paths.add(path);
    return paths;
  }

  // INDEX_RE of evaluate.py; Python's \d is any Unicode decimal digit.
  static #wildcardPath(path: string): string {
    return path.replaceAll(/\[\p{Nd}+\]/gu, '[]');
  }
}
