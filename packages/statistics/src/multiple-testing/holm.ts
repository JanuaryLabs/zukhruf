import type { MultipleTestCorrection } from './multiple-test-correction.ts';

// The Holm adjusted p-values (Holm 1979) of several tests, in the order of
// the p-values. The step-down correction multiplies the k-th smallest of n
// p-values by n - k + 1, takes the running maximum in that order, so an
// adjusted value is never below the one before it, and caps each value at 1.
// A test is significant at level alpha when its adjusted value is at most
// alpha, p <= alpha, as a level-alpha test rejects (Casella and Berger 2002,
// 8.3.26) and as statsmodels decides: its Holm step rejects where
// p <= alpha / (n - k + 1), which is the adjusted value <= alpha. These are
// the values of statsmodels 0.15.0 multipletests(pValues, method="holm")[1],
// to the last bit (ADR 0003).
export class Holm implements MultipleTestCorrection {
  adjust(pValues: readonly number[]): number[] {
    const order = pValues
      .map((value, index) => ({ value, index }))
      .toSorted((a, b) => a.value - b.value);
    const adjusted: number[] = Array.from({ length: pValues.length });
    let running = Number.NEGATIVE_INFINITY;
    for (const [rank, { value, index }] of order.entries()) {
      running = Math.max(running, value * (order.length - rank));
      adjusted[index] = Math.min(running, 1);
    }
    return adjusted;
  }
}
