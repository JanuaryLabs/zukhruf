import { sum } from '@zukhruf/statistics';

import { Counts } from '../aggregation/counts.ts';
import {
  CountsForm,
  type FMeasureForm,
} from '../aggregation/f-measure-form.ts';
import type { Average } from './average.ts';
import { ConfusionMatrix } from './confusion-matrix.ts';
import { LabelComparison } from './label-comparison.ts';
import { type Label, compareLabels } from './label.ts';

// The options of a score of the classes: the average, the classes to score
// (by default every class, in the order of the labels) and the score of a
// class whose denominator is 0 (0, as scikit-learn's "warn" gives, 1 or NaN).
type ScoreOptions = {
  readonly average: Average;
  readonly labels?: readonly Label[];
  readonly zeroDivision?: 0 | 1 | number;
};

// The running counts of one class, added in the order of the answers.
class Tally {
  hits = 0;
  stated = 0;
  expected = 0;
}

// The counts of each class over many answers, as scikit-learn's
// multilabel_confusion_matrix gives them: the true positives (hits), the
// predicted (stated) and the true (expected), each the sum of the weights of
// the answers in their order, as numpy's bincount adds them. Add each
// comparison, then read the metrics of a whole run (torchmetrics' update and
// compute). It also keeps the weight of each right answer for the accuracy,
// and the weight of each pair of labels for the confusion matrix. The counts
// are of one class for each answer (multiclass) or of a set of classes
// (multilabel), as torchmetrics has a multiclass and a multilabel class.
export class ClassCounts {
  readonly #multilabel: boolean;
  readonly #classes = new Map<Label, Tally>();
  readonly #rights: number[] = [];
  readonly #weights: number[] = [];
  readonly #pairs = new Map<Label, Map<Label, number>>();

  constructor({ multilabel }: { readonly multilabel: boolean }) {
    this.#multilabel = multilabel;
  }

  // The counts of two arrays of labels, one label for each answer
  // (multiclass), with the weight of each answer (1 when none is given).
  static of({
    expected,
    stated,
    weights,
  }: {
    readonly expected: readonly Label[];
    readonly stated: readonly Label[];
    readonly weights?: readonly number[];
  }): ClassCounts {
    const counts = new ClassCounts({ multilabel: false });
    for (const [expectedLabel, statedLabel, weight] of ClassCounts.#answers(
      expected,
      stated,
      weights,
    ))
      counts.add(
        new LabelComparison({
          stated: new Set([statedLabel]),
          expected: new Set([expectedLabel]),
        }),
        weight,
      );
    return counts;
  }

  // The counts of two label indicator matrices (multilabel): a row of 0 and 1
  // for each answer, a column for each label. Each column is a class, also
  // when no answer has it.
  static ofIndicators({
    expected,
    stated,
    weights,
  }: {
    readonly expected: readonly (readonly number[])[];
    readonly stated: readonly (readonly number[])[];
    readonly weights?: readonly number[];
  }): ClassCounts {
    const columns = expected[0]?.length ?? 0;
    const counts = new ClassCounts({ multilabel: true });
    for (let column = 0; column < columns; column++)
      counts.#classes.set(column, new Tally());
    const labels = (row: readonly number[]) => {
      if (
        row.length !== columns ||
        row.some((value) => value !== 0 && value !== 1)
      )
        throw new RangeError(
          `A row of a label indicator matrix holds ${columns} values of 0 or 1, not ${JSON.stringify(row)}.`,
        );
      return new Set(
        row.flatMap((value, column) => (value === 1 ? [column] : [])),
      );
    };
    for (const [expectedRow, statedRow, weight] of ClassCounts.#answers(
      expected,
      stated,
      weights,
    ))
      counts.add(
        new LabelComparison({
          stated: labels(statedRow),
          expected: labels(expectedRow),
        }),
        weight,
      );
    return counts;
  }

  // The expected side, the stated side and the weight of each answer. An
  // answer without a weight weighs 1.
  static *#answers<Side>(
    expected: readonly Side[],
    stated: readonly Side[],
    weights: readonly number[] | undefined,
  ): Generator<[Side, Side, number]> {
    const unequal = new RangeError(
      `The expected labels, the stated labels and the weights have ${expected.length}, ${stated.length} and ${weights?.length ?? expected.length} answers.`,
    );
    if (
      stated.length !== expected.length ||
      (weights !== undefined && weights.length !== expected.length)
    )
      throw unequal;
    for (const [index, side] of expected.entries()) {
      const other = stated[index];
      if (other === undefined) throw unequal;
      yield [side, other, weights?.[index] ?? 1];
    }
  }

  // Adds one answer with its weight. Multiclass counts refuse an answer with
  // no label or more than one label on a side.
  add(comparison: LabelComparison, weight: number): void {
    const { stated, expected } = comparison;
    if (!this.#multilabel && (stated.size !== 1 || expected.size !== 1))
      throw new RangeError(
        `Multiclass counts take one stated and one expected label for each answer, not ${JSON.stringify([...stated])} and ${JSON.stringify([...expected])}.`,
      );
    for (const label of comparison.labels()) {
      const tally = this.#classes.getOrInsertComputed(label, () => new Tally());
      if (stated.has(label)) tally.stated += weight;
      if (expected.has(label)) tally.expected += weight;
      if (stated.has(label) && expected.has(label)) tally.hits += weight;
    }
    const right = stated.size === expected.size && stated.isSubsetOf(expected);
    this.#rights.push(right ? weight : 0);
    this.#weights.push(weight);
    if (this.#multilabel) return;
    const [expectedLabel] = expected;
    const [statedLabel] = stated;
    if (expectedLabel === undefined || statedLabel === undefined) return;
    const row = this.#pairs.getOrInsertComputed(expectedLabel, () => new Map());
    row.set(statedLabel, (row.get(statedLabel) ?? 0) + weight);
  }

  // The labels of the classes, in the order of numpy's unique().
  labels(): Label[] {
    return [...this.#classes.keys()].toSorted(compareLabels);
  }

  // accuracy_score: the weight of the right answers over the weight of all
  // answers, each with numpy's pairwise sum. An answer is right when its
  // stated labels are its expected labels (the subset accuracy for a set of
  // classes).
  accuracy(): number {
    return sum(this.#rights) / sum(this.#weights);
  }

  // precision_score: hits / stated of each class, then the average.
  precision(options: ScoreOptions): number {
    return this.#score(options, ({ hits, stated }) =>
      stated === 0 ? undefined : hits / stated,
    );
  }

  // recall_score: hits / expected of each class, then the average.
  recall(options: ScoreOptions): number {
    return this.#score(options, ({ hits, expected }) =>
      expected === 0 ? undefined : hits / expected,
    );
  }

  // fbeta_score: the F-beta of each class in the form (scikit-learn's
  // CountsForm by default), then the average. Its denominator is
  // β²·expected + stated.
  fBeta({
    beta,
    form = new CountsForm(),
    ...options
  }: ScoreOptions & {
    readonly beta: number;
    readonly form?: FMeasureForm;
  }): number {
    return this.#score(options, (counts) =>
      beta ** 2 * counts.expected + counts.stated === 0
        ? undefined
        : form.of(counts, beta),
    );
  }

  // The true count of each class, in the order of the labels.
  support(): ReadonlyMap<Label, number> {
    return new Map(
      this.labels().map((label) => [label, this.#counts(label).expected]),
    );
  }

  // confusion_matrix of the answers, with the labels in their order. A set
  // of classes has no confusion matrix (scikit-learn raises), so it throws.
  confusionMatrix(): ConfusionMatrix {
    if (this.#multilabel)
      throw new RangeError(
        'Answers with a set of classes (multilabel) have no confusion matrix.',
      );
    return new ConfusionMatrix(this.labels(), this.#pairs);
  }

  #score(
    { average, labels = this.labels(), zeroDivision = 0 }: ScoreOptions,
    score: (counts: Counts) => number | undefined,
  ): number {
    return average.of(
      {
        selected: new Map(labels.map((label) => [label, this.#counts(label)])),
        present: new Map(
          this.labels().map((label) => [label, this.#counts(label)]),
        ),
        multilabel: this.#multilabel,
      },
      (counts) => score(counts) ?? zeroDivision,
    );
  }

  #counts(label: Label): Counts {
    const tally = this.#classes.get(label);
    return new Counts({
      hits: tally?.hits ?? 0,
      stated: tally?.stated ?? 0,
      expected: tally?.expected ?? 0,
    });
  }
}
