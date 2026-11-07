import type { Comparer } from '../scoring/comparer.ts';
import type { LabelCase } from './label-case.ts';
import type { Label } from './label.ts';
import { ProbabilityComparison } from './probability-comparison.ts';

// Reads the stated probability of each class of an answer and gives its
// comparison with the case (Strategy). The answer is a Map of labels, a plain
// object or the JSON text of an object, whose values are probabilities in
// [0, 1]. A key of an object is a number label when each expected label of
// the case is a number. The case has one expected label.
export class ProbabilityComparer implements Comparer<
  LabelCase,
  ProbabilityComparison
> {
  compare(stated: unknown, testCase: LabelCase): ProbabilityComparison {
    const [expected, ...others] = testCase.expected;
    if (expected === undefined || others.length > 0)
      throw new RangeError(
        `A probability is scored against one expected label, not ${JSON.stringify([...testCase.expected])}.`,
      );
    const numbers = typeof expected === 'number';
    const entries = ProbabilityComparer.#entries(
      typeof stated === 'string' ? JSON.parse(stated) : stated,
    ).map(([key, probability]): [Label, number] => {
      if (
        typeof probability !== 'number' ||
        !(probability >= 0 && probability <= 1)
      )
        throw new RangeError(
          `The probability of ${JSON.stringify(key)} is a number in [0, 1], not ${JSON.stringify(probability)}.`,
        );
      return [
        numbers && typeof key === 'string' ? Number(key) : key,
        probability,
      ];
    });
    return new ProbabilityComparison({
      probabilities: new Map(entries),
      expected,
    });
  }

  static #entries(value: unknown): [Label, unknown][] {
    if (value instanceof Map) return [...value];
    if (typeof value === 'object' && value !== null && !Array.isArray(value))
      return Object.entries(value);
    throw new TypeError(
      `A stated answer is the probability of each label, as an object, not ${JSON.stringify(value)}`,
    );
  }
}
