import type { Counts } from '../aggregation/counts.ts';
import type { Average, Classes } from './average.ts';
import type { Label } from './label.ts';

// average='binary': the score of the positive class, for a class set of two
// classes or fewer. It throws as scikit-learn raises: for a set of classes
// (multilabel), for a class set of more than two classes, and for a positive
// label outside the class set.
export class BinaryAverage implements Average {
  readonly #positiveLabel: Label;

  constructor(positiveLabel: Label) {
    this.#positiveLabel = positiveLabel;
  }

  of(
    { counts, multilabel }: Classes,
    score: (counts: Counts) => number,
  ): number {
    if (multilabel)
      throw new RangeError(
        'The target is multilabel-indicator, but the average is binary: choose another average.',
      );
    if (counts.size > 2)
      throw new RangeError(
        `The class set has ${counts.size} classes, but the average is binary: choose another average.`,
      );
    const positive = counts.get(this.#positiveLabel);
    if (positive === undefined)
      throw new RangeError(
        `The positive label ${JSON.stringify(this.#positiveLabel)} is not in the class set ${JSON.stringify([...counts.keys()])}.`,
      );
    return score(positive);
  }
}
