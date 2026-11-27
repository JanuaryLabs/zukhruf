import {
  type Comparer,
  type Mark,
  Note,
  type Pair,
  type Primitive,
  type RunLog,
  type Section,
  ValuePairs,
} from '../../index.ts';
import { BagOfWords } from '../comparison/bag-of-words.ts';
import type { Comparison } from '../comparison/comparison.ts';
import type {
  BothSides,
  LeafPair,
  LeafValue,
} from '../comparison/leaf-pair.ts';
import type { LeafOptions } from '../scorers/leaf-matches.ts';
import type { Case } from '../scoring/case.ts';

// The marks of a leaf with both sides by its class (structured ADR 0014):
// correct, partial and incorrect, the words of SemEval 2013 task 9.1 as
// nervaluate reports them. A leaf of one side is missed or spurious, and its
// mark is that side.
const marks = {
  correct: 'agree',
  partial: 'near',
  incorrect: 'disagree',
} as const satisfies Record<string, Mark>;

type Shown = {
  readonly title: string;
  readonly errors: number;
  readonly leaves: number;
  readonly pairs: readonly Pair[];
};

// The answers of a run with the most errors, each beside its case
// (structured ADR 0014, point 5). Each answer, of each epoch, is compared
// again with its case by the comparer of the eval, as FieldErrors compares
// it; its errors are its leaves that are partial, incorrect, missed or
// spurious. The answers come most errors first, an answer with no error is
// left out, and at most `worst` are shown, each as ValuePairs: one pair for
// each leaf in the order of the walk, at its path with positions, so the
// expected item stands beside the stated item that the alignment paired with
// it, and a leaf of an unpaired item stands on its own side. This form reads
// one RunLog; the form of a RunPair, the two answers of a test beside its
// case, comes with the building blocks of a run pair.
export class FieldDiff<C extends Case> implements Section {
  readonly id = 'field-diff';
  readonly claim: string;
  readonly primitives: readonly Primitive[];

  constructor(
    log: RunLog<unknown, C>,
    // The leaf options of the eval's scorers, such as nullIsMissing, so that a
    // leaf is classed as the scores count it (structured ADR 0014, point 1).
    {
      comparer,
      nullIsMissing = false,
      worst,
    }: {
      readonly comparer: Comparer<C, Comparison>;
      readonly worst: number;
    } & LeafOptions,
  ) {
    if (log.samples.length === 0)
      throw new RangeError('A FieldDiff section needs a sample to compare');
    if (!Number.isInteger(worst) || worst < 1)
      throw new RangeError(
        `A FieldDiff section shows a positive whole number of answers, not ${worst}`,
      );
    const epochs = new Map<string, number>();
    for (const { test } of log.samples)
      epochs.set(test, (epochs.get(test) ?? 0) + 1);
    const manyEpochs = epochs.values().some((count) => count > 1);
    const wrong = log.samples
      .map(({ test, epoch, answer, case: testCase }): Shown => {
        const leaves = comparer
          .compare(answer, testCase)
          .leaves({ nullIsMissing });
        const pairs = leaves.map((pair) => FieldDiff.#pair(pair));
        return {
          title: manyEpochs ? `${test} · epoch ${epoch}` : test,
          errors: pairs.filter(({ mark }) => mark !== 'agree').length,
          leaves: leaves.length,
          pairs,
        };
      })
      .filter(({ errors }) => errors > 0);
    const shown = wrong.toSorted((a, b) => b.errors - a.errors).slice(0, worst);
    this.claim = FieldDiff.#claim(wrong.length, log.samples.length, shown);
    this.primitives =
      shown.length === 0
        ? [new Note('No answer has a field to show')]
        : shown.map(({ title, pairs }) => new ValuePairs(title, pairs));
  }

  // The pair of a leaf at the path of its expected side, or of its stated
  // side when only the answer has it: missed when only the expected side has
  // it, spurious when only the answer has it, else marked by its class.
  static #pair(pair: LeafPair): Pair {
    if (pair.expected === undefined)
      return {
        path: pair.stated.path.toString(),
        mark: 'only-actual',
        actual: FieldDiff.#text(pair.stated.value),
      };
    if (pair.stated === undefined)
      return {
        path: pair.expected.path.toString(),
        mark: 'only-expected',
        expected: FieldDiff.#text(pair.expected.value),
      };
    return {
      path: pair.expected.path.toString(),
      mark: marks[FieldDiff.#leafClass(pair)],
      expected: FieldDiff.#text(pair.expected.value),
      actual: FieldDiff.#text(pair.stated.value),
    };
  }

  // Correct when the comparator of the field agrees; partial when the two
  // sides disagree and share a word as TokenF1 reads words (BagOfWords, SQuAD's
  // normalize_answer); incorrect when they share none. A copy of
  // FieldErrors.#leafClass for a leaf with both sides (docs/copied-code.md).
  static #leafClass(pair: BothSides): keyof typeof marks {
    if (pair.agrees) return 'correct';
    const shared = BagOfWords.of(pair.expected.value).shared(
      BagOfWords.of(pair.stated.value),
    );
    return shared.hits > 0 ? 'partial' : 'incorrect';
  }

  // A string as it is; any other value as its JSON text. An int is a bigint
  // (JsonData), whose JSON text is its digits.
  static #text(value: LeafValue): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'bigint') return value.toString();
    return JSON.stringify(value);
  }

  static #claim(
    wrong: number,
    answers: number,
    shown: readonly Shown[],
  ): string {
    const [most] = shown;
    if (most === undefined) return 'Every answer has every field right';
    return `${wrong} of ${answers} ${answers === 1 ? 'answer' : 'answers'} ${wrong === 1 ? 'has' : 'have'} a field wrong; ${most.title} has the most, ${most.errors} of ${most.leaves} ${most.leaves === 1 ? 'leaf' : 'leaves'}`;
  }
}
