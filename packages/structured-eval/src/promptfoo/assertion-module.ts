import { fileURLToPath } from 'node:url';

import type { ScorerAssertion } from './scorer-assertion.ts';

// A promptfoo javascript assertion that holds only JSON: its value is a file
// reference to one function of an assertion module (promptfoo 0.125.1,
// AssertionSchema).
export type FileAssertion = {
  readonly type: 'javascript';
  readonly metric: string;
  readonly weight: number;
  readonly threshold: number;
  readonly value: string;
};

// The module that promptfoo loads the function of each scorer assertion from
// (ADR 0013). promptfoo stores the config of an eval as JSON, and --resume
// and --retry-errors build the run from that stored config, so a function in
// the config is lost and its assertion scores 0. A config holds the file
// references that assert gives, and promptfoo loads each function from the
// default export of the module: importModule reads file://<module>:<name> on
// the default export when the module has one (promptfoo 0.125.1,
// dist/src/esm-B4NX_h4K.js:205-224). So the module gives functions as its
// default export, and url is the module's own import.meta.url.
//
// The reference holds the absolute path of the module. promptfoo 0.125.1
// splits a file reference at its first colon
// (dist/src/evaluator-BxCmvGtv.js:5683-5686), so on Windows the drive of the
// path ends the path: a defect of promptfoo.
export class AssertionModule<Name extends string> {
  // promptfoo reads a function by the name in its reference, so the names are
  // keys, and assert holds the type of each name.
  readonly functions: Readonly<Record<string, ScorerAssertion['value']>>;
  readonly #path: string;
  readonly #assertions: Readonly<Record<Name, ScorerAssertion>>;

  constructor(
    url: string,
    assertions: Readonly<Record<Name, ScorerAssertion>>,
  ) {
    this.#path = fileURLToPath(url);
    this.#assertions = assertions;
    this.functions = Object.fromEntries(
      Object.entries<ScorerAssertion>(assertions).map(([name, assertion]) => [
        name,
        assertion.value,
      ]),
    );
  }

  // One assertion for each name. The name is the metric, unless its scorer
  // assertion gives one.
  assert(...names: Name[]): FileAssertion[] {
    return names.map((name) => {
      const { metric = name, weight, threshold } = this.#assertions[name];
      return {
        type: 'javascript',
        metric,
        weight,
        threshold,
        value: `file://${this.#path}:${name}`,
      };
    });
  }
}
