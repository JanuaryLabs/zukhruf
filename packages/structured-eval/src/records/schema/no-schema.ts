import type { SchemaMeasures, SchemaRule } from './schema-rule.ts';

const unchecked: SchemaMeasures = {
  valid: true,
  reason: '',
  ratios: () => [],
};

// A spec without a JSON Schema: every record counts as valid, and there is no
// `valid` or `type safety` ratio (Null Object).
export class NoSchema implements SchemaRule {
  measure(): SchemaMeasures {
    return unchecked;
  }
}
