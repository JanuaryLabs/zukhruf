import { Counts } from '../aggregation/counts.ts';
import type { Average, Classes } from './average.ts';
import type { Label } from './label.ts';

// average='binary': the score of the positive class, for answers of two
// classes or fewer. It throws as scikit-learn raises: for a set of classes,
// for more than two classes, and for a positive label that is not one of two
// classes. A positive label that no answer has scores counts of 0.
export class BinaryAverage implements Average {
  readonly #positiveLabel: Label;

  constructor(positiveLabel: Label) {
    this.#positiveLabel = positiveLabel;
  }

  of(
    { present, multilabel }: Classes,
    score: (counts: Counts) => number,
  ): number {
    if (multilabel || present.size > 2)
      throw new RangeError(
        `The target is ${multilabel ? 'multilabel-indicator' : 'multiclass'}, but the average is binary: choose another average.`,
      );
    const counts = present.get(this.#positiveLabel);
    if (counts === undefined && present.size === 2)
      throw new RangeError(
        `The positive label ${JSON.stringify(this.#positiveLabel)} is not one of the labels ${JSON.stringify([...present.keys()])}.`,
      );
    return score(counts ?? new Counts({ hits: 0, stated: 0, expected: 0 }));
  }
}
