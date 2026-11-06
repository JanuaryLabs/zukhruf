import type { JsonPair } from '../json-pair.ts';
import type { Metric } from '../metric.ts';

// The F1 of the leaf paths that both values have (f1_from_counts), with its
// arithmetic: precision and recall first, then 2·p·r/(p + r). It is 0 when
// the two values share no path, as when only one of them has paths, and
// whenNoPaths when neither has one (evaluate.py gives 0).
export class PathF1 implements Metric {
  readonly #whenNoPaths: number;

  constructor({ whenNoPaths }: { readonly whenNoPaths: number }) {
    this.#whenNoPaths = whenNoPaths;
  }

  of({ sharedPaths, statedLeaves, expectedLeaves }: JsonPair): number {
    if (statedLeaves.size === 0 && expectedLeaves.size === 0)
      return this.#whenNoPaths;
    if (sharedPaths === 0) return 0;
    const precision = sharedPaths / statedLeaves.size;
    const recall = sharedPaths / expectedLeaves.size;
    return (2 * precision * recall) / (precision + recall);
  }
}
