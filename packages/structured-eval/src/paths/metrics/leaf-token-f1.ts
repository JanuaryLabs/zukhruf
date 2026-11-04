import { NeumaierSum } from '../../aggregation/neumaier-sum.ts';
import { tokenF1 } from '../cpython/python-tokens.ts';
import type { JsonPair } from '../json-pair.ts';
import type { Metric } from '../metric.ts';

// The mean token F1 of each expected leaf and the stated value at its path
// (None when absent); 1 without any expected leaf (mean_token_f1). The sum
// is CPython's.
export class LeafTokenF1 implements Metric {
  of({ expectedLeaves, statedLeaves }: JsonPair): number {
    if (expectedLeaves.size === 0) return 1;
    const sum = new NeumaierSum();
    for (const [path, value] of expectedLeaves)
      sum.add(tokenF1(value, statedLeaves.get(path) ?? null));
    return sum.value / expectedLeaves.size;
  }
}
