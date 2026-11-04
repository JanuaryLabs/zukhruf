import { Ratio } from '../../aggregation/ratio.ts';
import type { JsonPair } from '../json-pair.ts';
import { jsonTypeName, schemaTypeForPath } from '../leaf-paths.ts';
import type { Metric } from '../metric.ts';

const isTypeMatch = (actual: string, expected: string) =>
  actual === expected || (expected === 'number' && actual === 'integer');

// The stated leaves whose type is the type of their path in the schema,
// through properties and items only (compute_type_precision); 0 without a
// valid schema. An unparsed value has no leaves, so it gives 0 too.
export class LeafTypePrecision implements Metric {
  of({ statedLeaves, testCase: { schema } }: JsonPair): number {
    if (!schema.valid || statedLeaves.size === 0) return 0;
    let matches = 0;
    for (const [path, value] of statedLeaves) {
      const expected = schemaTypeForPath(schema.value, path);
      if (expected !== undefined && isTypeMatch(jsonTypeName(value), expected))
        matches++;
    }
    return new Ratio(matches, statedLeaves.size).value;
  }
}
