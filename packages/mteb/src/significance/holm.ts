// Not from MTEB: MTEB has no significance test.

// The Holm adjusted p-values (Holm 1979) of several tests, in the order of
// the p-values. The step-down correction multiplies the k-th smallest of n
// p-values by n - k + 1, takes the running maximum in that order, so an
// adjusted value is never below the one before it, and caps each value at 1.
// A test is significant at level alpha when its adjusted value is at most
// alpha. These are the values of statsmodels 0.15.0
// multipletests(pValues, method="holm")[1], to the last bit.
export function holm(pValues: readonly number[]): number[] {
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
