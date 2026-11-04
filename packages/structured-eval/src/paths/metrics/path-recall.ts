import { Ratio } from '../../aggregation/ratio.ts';
import type { JsonPair } from '../json-pair.ts';
import type { Metric } from '../metric.ts';

// The expected leaf paths that the stated value has, of all expected leaf
// paths.
export class PathRecall implements Metric {
  of(pair: JsonPair): number {
    return new Ratio(pair.sharedPaths, pair.expectedLeaves.size).value;
  }
}
