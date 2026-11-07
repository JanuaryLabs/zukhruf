import type { Counts } from './counts.ts';
import { Ratio } from './ratio.ts';

// The arithmetic of an F-measure from the counts (Strategy). Two forms give
// the same number in algebra and can differ in the last bit (ADR 0003).
export interface FMeasureForm {
  of(counts: Counts, beta: number): number;
}

// (1 + β²)·hits / (β²·expected + stated), in the order of the operations of
// scikit-learn 1.9.1's fbeta_score (sklearn/metrics/_classification.py). It
// is the part of an F-measure ratio divided by its whole, and 0 when the
// whole is 0.
export class CountsForm implements FMeasureForm {
  of({ hits, stated, expected }: Counts, beta: number): number {
    const beta2 = beta ** 2;
    return new Ratio((1 + beta2) * hits, beta2 * expected + stated).value;
  }
}

// (1 + β²)·P·R / (β²·P + R), precision and recall first (van Rijsbergen
// 1979), and 0 when there are no hits. With β = 1 it is 2·p·r/(p + r), the
// arithmetic of SOB's evaluate.py (f1_from_counts, token_f1).
export class PrecisionRecallForm implements FMeasureForm {
  of({ hits, stated, expected }: Counts, beta: number): number {
    if (hits === 0) return 0;
    const beta2 = beta ** 2;
    const precision = hits / stated;
    const recall = hits / expected;
    return ((1 + beta2) * precision * recall) / (beta2 * precision + recall);
  }
}
