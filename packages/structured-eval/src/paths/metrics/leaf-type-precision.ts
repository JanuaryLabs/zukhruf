import type { JsonData } from '@zukhruf/python';

import type { JsonPair } from '../json-pair.ts';
import { LeafMean } from './leaf-mean.ts';

// The stated leaves whose type the schema allows at their path, by the rules
// of JSON Schema draft 7, and whenNoneStated when the stated value has no
// leaf (evaluate.py gives 0). A record that the schema accepts gives 1, so the
// value grades a record that the schema refuses. It has no gate: evaluate.py
// shows it only for a record that agrees with its schema (evaluate.py:291-295,
// 302-309), which makes it equal to SchemaCompliance, and its caller composes
// that with Gated (ADR 0008).
export class LeafTypePrecision extends LeafMean {
  constructor({ whenNoneStated }: { readonly whenNoneStated: number }) {
    super(whenNoneStated);
  }

  protected leaves({ statedLeaves }: JsonPair): ReadonlyMap<string, JsonData> {
    return statedLeaves;
  }

  protected leafValue(
    path: string,
    value: JsonData,
    { testCase: { schema } }: JsonPair,
  ): number {
    return schema.types.allows(path, value) ? 1 : 0;
  }
}
