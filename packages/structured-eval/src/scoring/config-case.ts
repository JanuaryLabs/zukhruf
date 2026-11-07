import { JsonValue } from '../comparison/json-value.ts';
import type { JsonSchema } from '../schema/json-schema.ts';
import { Case } from './case.ts';
import type { CaseReader } from './scorecard-scorer.ts';

// Reads a case from the config of an assertion: config.expected, as a
// JavaScript value, so an integral float such as 7.0 is already 7. One
// JsonSchema, when the reader has one, serves every case. A case weighs 1
// (Strategy).
export class ConfigCase implements CaseReader<Case> {
  readonly #schema: JsonSchema | undefined;

  constructor({ schema }: { readonly schema?: JsonSchema } = {}) {
    this.#schema = schema;
  }

  from(config: Readonly<Record<string, unknown>>): Case {
    if (!Object.hasOwn(config, 'expected'))
      throw new Error(
        'A config case needs config.expected: the expected value of the test',
      );
    return new Case({
      expected: JsonValue.from(config['expected']).value,
      ...(this.#schema === undefined ? {} : { schema: this.#schema }),
      weight: 1,
    });
  }
}
