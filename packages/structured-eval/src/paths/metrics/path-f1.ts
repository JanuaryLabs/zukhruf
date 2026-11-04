import type { JsonPair } from '../json-pair.ts';
import type { Metric } from '../metric.ts';

// The F1 of the leaf paths that both values have (f1_from_counts), with its
// arithmetic: precision and recall first, then 2·p·r/(p + r).
export class PathF1 implements Metric {
  of({ sharedPaths, statedLeaves, expectedLeaves }: JsonPair): number {
    if (statedLeaves.size === 0 || expectedLeaves.size === 0) return 0;
    const precision = sharedPaths / statedLeaves.size;
    const recall = sharedPaths / expectedLeaves.size;
    return precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  }
}
