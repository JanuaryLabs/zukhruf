import type { SchemaMeasures, SchemaRule } from './schema-rule.ts';

// A spec without a JSON Schema: every record counts as valid, and there is no
// `valid` or `type safety` ratio (Null Object).
export class NoSchema implements SchemaRule {
  static readonly #unchecked: SchemaMeasures = {
    valid: true,
    reason: '',
    ratios: () => [],
  };

  measure(): SchemaMeasures {
    return NoSchema.#unchecked;
  }
}
