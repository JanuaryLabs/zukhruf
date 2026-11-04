import { type JsonCase, fromJavaScript } from './json-case.ts';
import { type JsonData, JsonValue, isDict, isList } from './json-value.ts';
import { flattenLeafPaths } from './leaf-paths.ts';

// What a stated value is to the metrics: a value that JsonValue.parse read, as
// it is; a string, which is text that was not parsed; or a JavaScript value,
// read as json.loads reads its JSON text.
const dataOf = (stated: unknown): JsonData => {
  if (stated instanceof JsonValue) return stated.value;
  if (typeof stated === 'string') return stated;
  return fromJavaScript(stated);
};

// A stated value and its case, as evaluate_record of SOB's evaluate.py sees
// them before it computes its metrics: the parsed candidate, the schema, and
// the leaves of both values. The metrics share it, so each fact is computed
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
    const value = dataOf(stated);
    this.testCase = testCase;
    this.parsed = isDict(value) || isList(value);
    this.candidate = this.parsed ? value : null;
    this.expectedLeaves = flattenLeafPaths(testCase.expected);
    this.statedLeaves = this.parsed
      ? flattenLeafPaths(this.candidate)
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
    let shared = 0;
    for (const path of this.expectedLeaves.keys())
      if (this.statedLeaves.has(path)) shared++;
    return shared;
  }
}
