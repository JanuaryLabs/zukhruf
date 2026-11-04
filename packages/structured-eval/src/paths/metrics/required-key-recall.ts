import { Ratio } from '../../aggregation/ratio.ts';
import type { JsonPair } from '../json-pair.ts';
import {
  flattenPresentPaths,
  requiredPaths,
  wildcardPath,
} from '../leaf-paths.ts';
import type { Metric } from '../metric.ts';

// The required paths of the schema that the stated value has
// (compute_required_key_recall); 1 when the schema requires none, 0 without a
// parsed value or a valid schema.
export class RequiredKeyRecall implements Metric {
  of({ parsed, candidate, testCase: { schema } }: JsonPair): number {
    if (!parsed || !schema.valid) return 0;
    const required = new Set(requiredPaths(schema.value));
    if (required.size === 0) return 1;
    const present = new Set(
      [...flattenPresentPaths(candidate)].map(wildcardPath),
    );
    const missing = [...required].filter((path) => !present.has(path)).length;
    return new Ratio(required.size - missing, required.size).value;
  }
}
