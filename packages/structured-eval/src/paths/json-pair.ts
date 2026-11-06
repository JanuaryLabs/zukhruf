import type { JsonData } from '@zukhruf/python';

import { type JsonCase, fromJavaScript } from './json-case.ts';
import { JsonValue } from './json-value.ts';

// A stated value and its case, as evaluate_record of SOB's evaluate.py sees
// them before it computes its scorers: the parsed candidate, the schema, and
// the leaves of both values. The scorers share it, so each fact is computed
// once.
export class JsonPair {
  readonly testCase: JsonCase;
  // parse_candidate: only a dict or a list counts as parsed, so a parsed value
  // also has a structured root.
  readonly parsed: boolean;
  // The candidate of evaluate.py: None when it is not parsed.
  readonly candidate: JsonData;
  readonly expectedLeaves: ReadonlyMap<string, JsonData>;
  readonly statedLeaves: ReadonlyMap<string, JsonData>;

  constructor(stated: unknown, testCase: JsonCase) {
    const value = JsonPair.#dataOf(stated);
    this.testCase = testCase;
    this.parsed = value instanceof Map || Array.isArray(value);
    this.candidate = this.parsed ? value : null;
    this.expectedLeaves = JsonPair.#leaves(testCase.expected, '');
    this.statedLeaves = this.parsed
      ? JsonPair.#leaves(this.candidate, '')
      : new Map();
  }

  #compliant: boolean | undefined;

  // schema_compliance: parsed, a valid schema, and the candidate agrees with
  // it.
  get compliant(): boolean {
    this.#compliant ??=
      this.parsed &&
      this.testCase.schema.valid &&
      this.testCase.schema.validates(this.candidate);
    return this.#compliant;
  }

  get sharedPaths(): number {
    return new Set(this.expectedLeaves.keys()).intersection(this.statedLeaves)
      .size;
  }

  // What a stated value is to the scorers: a value that JsonValue.parse read,
  // as it is; a string, which is text that was not parsed; or a JavaScript
  // value, read as json.loads reads its JSON text.
  static #dataOf(stated: unknown): JsonData {
    if (stated instanceof JsonValue) return stated.value;
    if (typeof stated === 'string') return stated;
    return fromJavaScript(stated);
  }

  // The leaf paths of evaluate.py: `a.b[0].c`. A dict and a list give their
  // children; any other value is a leaf (null too); a value at an empty path,
  // such as a scalar root, is no leaf; a later equal path takes the value and
  // keeps the first place, as dict.update does.
  static #leaves(
    value: JsonData | undefined,
    prefix: string,
  ): Map<string, JsonData> {
    const leaves = new Map<string, JsonData>();
    if (value instanceof Map) {
      for (const [key, child] of value)
        for (const [path, leaf] of JsonPair.#leaves(
          child,
          prefix ? `${prefix}.${key}` : key,
        ))
          leaves.set(path, leaf);
      return leaves;
    }
    if (Array.isArray(value)) {
      for (const [index, child] of value.entries())
        for (const [path, leaf] of JsonPair.#leaves(
          child,
          `${prefix}[${index}]`,
        ))
          leaves.set(path, leaf);
      return leaves;
    }
    if (prefix && value !== undefined) leaves.set(prefix, value);
    return leaves;
  }
}
