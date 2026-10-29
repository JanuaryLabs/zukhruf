import { sum } from './statistics.ts';

// The probability at and above which an article is accepted: the plug-in
// rule that maximises the expected F0.5 over the probabilities themselves.
// Accepting the m most probable articles has the expected F0.5
// 1.25 * (sum of their probabilities) / (0.25 * sum of all probabilities + m).
// Undefined when no article has a probability above 0, so nothing is
// accepted (docs/adr/0002).
export function expectedF05Threshold(
  probabilities: readonly number[],
): number | undefined {
  const order = probabilities.toSorted((a, b) => b - a);
  const total = sum(order);
  let best: { value: number; threshold: number } | undefined;
  let cumulative = 0;
  for (const [index, probability] of order.entries()) {
    cumulative += probability;
    const value = (1.25 * cumulative) / (0.25 * total + index + 1);
    if (best === undefined || value > best.value)
      best = { value, threshold: probability };
  }
  if (best === undefined || best.value <= 0) return undefined;
  return best.threshold;
}
