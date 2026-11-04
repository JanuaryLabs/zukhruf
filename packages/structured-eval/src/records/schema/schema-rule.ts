import type { Measure } from '../measure.ts';
import type { RecordLeaves } from '../record-leaves.ts';

// What the JSON Schema of a spec says about one stated record: if it is valid,
// why not, and its ratios (`valid`, `type safety`).
export interface SchemaMeasures extends Measure {
  readonly valid: boolean;
  readonly reason: string;
}

export interface SchemaRule {
  measure(stated: unknown, leaves: RecordLeaves): SchemaMeasures;
}
