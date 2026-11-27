import {
  type Comparer,
  type Mark,
  Note,
  type Pair,
  type Primitive,
  RunLog,
  RunPair,
  type Sample,
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

// An answer compared with its case: its pairs, one for each leaf in the order
// of the walk, and its errors, the pairs not marked agree.
type Compared = {
  readonly errors: number;
  readonly leaves: number;
  readonly pairs: readonly Pair[];
};

type Shown = Compared & { readonly title: string };

// The two answers of a test and epoch, one of each run of a pair.
type Changed = {
  readonly sample: Sample<unknown, unknown>;
  readonly baseline: Compared;
  readonly change: Compared;
  readonly gained: number;
};

type Options<C extends Case> = {
  readonly comparer: Comparer<C, Comparison>;
  readonly worst: number;
} & LeafOptions;

// The answers of a run with the most errors, each beside its case
// (structured ADR 0014, point 5). Each answer, of each epoch, is compared
// again with its case by the comparer of the eval, as FieldErrors compares
// it; its errors are its leaves that are partial, incorrect, missed or
// spurious. The answers come most errors first, an answer with no error is
// left out, and at most `worst` are shown, each as ValuePairs: one pair for
// each leaf in the order of the walk, at its path with positions, so the
// expected item stands beside the stated item that the alignment paired with
// it, and a leaf of an unpaired item stands on its own side. Of a RunPair, it
// shows the two answers of a test and epoch that both runs answered, each
// beside the case, when the leaves of the two have other marks: the answers
// that gained the most errors first, then the most errors of the change,
// ties in the order of the baseline, at most `worst` of them.
export class FieldDiff<C extends Case> implements Section {
  readonly id = 'field-diff';
  readonly claim: string;
  readonly primitives: readonly Primitive[];

  constructor(
    input: RunLog<unknown, C> | RunPair<unknown, C>,
    // The leaf options of the eval's scorers, such as nullIsMissing, so that a
    // leaf is classed as the scores count it (structured ADR 0014, point 1).
    { comparer, nullIsMissing = false, worst }: Options<C>,
  ) {
    if (input instanceof RunLog && input.samples.length === 0)
      throw new RangeError('A FieldDiff section needs a sample to compare');
    if (!Number.isInteger(worst) || worst < 1)
      throw new RangeError(
        `A FieldDiff section shows a positive whole number of answers, not ${worst}`,
      );
    const compare = ({ answer, case: testCase }: Sample<unknown, C>) =>
      FieldDiff.#compared(
        comparer.compare(answer, testCase).leaves({ nullIsMissing }),
      );
    const { claim, primitives } =
      input instanceof RunPair
        ? FieldDiff.#ofPair(input, compare, worst)
        : FieldDiff.#ofLog(input, compare, worst);
    this.claim = claim;
    this.primitives = primitives;
  }

  static #ofLog<C>(
    log: RunLog<unknown, C>,
    compare: (sample: Sample<unknown, C>) => Compared,
    worst: number,
  ): Pick<Section, 'claim' | 'primitives'> {
    const titled = FieldDiff.#titles(log.samples);
    const wrong = log.samples
      .map((sample): Shown => ({ title: titled(sample), ...compare(sample) }))
      .filter(({ errors }) => errors > 0);
    const shown = wrong.toSorted((a, b) => b.errors - a.errors).slice(0, worst);
    return {
      claim: FieldDiff.#claim(wrong.length, log.samples.length, shown),
      primitives:
        shown.length === 0
          ? [new Note('No answer has a field to show')]
          : shown.map(({ title, pairs }) => new ValuePairs(title, pairs)),
    };
  }

  static #ofPair<C>(
    pair: RunPair<unknown, C>,
    compare: (sample: Sample<unknown, C>) => Compared,
    worst: number,
  ): Pick<Section, 'claim' | 'primitives'> {
    const changes = new Map(
      pair.change.samples.map((sample) => [
        JSON.stringify([sample.test, sample.epoch]),
        sample,
      ]),
    );
    const answered = pair.baseline.samples.flatMap((baseline) => {
      const change = changes.get(
        JSON.stringify([baseline.test, baseline.epoch]),
      );
      return change === undefined ? [] : [{ baseline, change }];
    });
    if (answered.length === 0)
      throw new RangeError(
        'A FieldDiff section of a run pair needs a test and epoch that both runs answered',
      );
    const titled = FieldDiff.#titles(answered.map(({ baseline }) => baseline));
    const changed = answered.flatMap(({ baseline, change }): Changed[] => {
      const before = compare(baseline);
      const after = compare(change);
      if (FieldDiff.#sameMarks(before.pairs, after.pairs)) return [];
      return [
        {
          sample: baseline,
          baseline: before,
          change: after,
          gained: after.errors - before.errors,
        },
      ];
    });
    // A stable sort keeps ties in the order of the baseline.
    const shown = changed
      .toSorted(
        (a, b) => b.gained - a.gained || b.change.errors - a.change.errors,
      )
      .slice(0, worst);
    const { label: baselineLabel } = pair.baseline.info;
    const { label: changeLabel } = pair.change.info;
    return {
      claim: FieldDiff.#pairClaim(
        changed,
        answered.length,
        shown[0] && { title: titled(shown[0].sample), gained: shown[0].gained },
      ),
      primitives:
        shown.length === 0
          ? [new Note('No answer changed between the runs')]
          : shown.flatMap(({ sample, baseline, change }) => [
              new ValuePairs(titled(sample, baselineLabel), baseline.pairs),
              new ValuePairs(titled(sample, changeLabel), change.pairs),
            ]),
    };
  }

  // The title of a sample: its test, then the label of its run when it is one
  // of a pair, then its epoch when a test of the samples has more than one.
  static #titles(
    samples: readonly Pick<Sample<unknown, unknown>, 'test' | 'epoch'>[],
  ) {
    const epochs = new Map<string, number>();
    for (const { test } of samples)
      epochs.set(test, (epochs.get(test) ?? 0) + 1);
    const manyEpochs = epochs.values().some((count) => count > 1);
    return (
      { test, epoch }: Pick<Sample<unknown, unknown>, 'test' | 'epoch'>,
      label?: string,
    ) =>
      [
        test,
        ...(label === undefined ? [] : [label]),
        ...(manyEpochs ? [`epoch ${epoch}`] : []),
      ].join(' · ');
  }

  static #compared(leaves: readonly LeafPair[]): Compared {
    const pairs = leaves.map((pair) => FieldDiff.#pair(pair));
    return {
      errors: pairs.filter(({ mark }) => mark !== 'agree').length,
      leaves: leaves.length,
      pairs,
    };
  }

  // Two answers have the same marks when their leaves, in the order of the
  // walk, have the same paths and marks.
  static #sameMarks(a: readonly Pair[], b: readonly Pair[]): boolean {
    return (
      a.length === b.length &&
      a.every(
        (pair, index) =>
          pair.path === b[index]?.path && pair.mark === b[index]?.mark,
      )
    );
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

  static #pairClaim(
    changed: readonly Changed[],
    answers: number,
    // The first shown answer, which gained the most.
    most: { readonly title: string; readonly gained: number } | undefined,
  ): string {
    if (most === undefined)
      return 'Every answer has the same fields right and wrong in both runs';
    const more = changed.filter(({ gained }) => gained > 0).length;
    const fewer = changed.filter(({ gained }) => gained < 0).length;
    const head = `${changed.length} of ${answers} ${answers === 1 ? 'answer' : 'answers'} changed between the runs, ${more} with more wrong fields and ${fewer} with fewer`;
    return most.gained > 0
      ? `${head}; ${most.title} gained the most, ${most.gained} more wrong ${most.gained === 1 ? 'field' : 'fields'}`
      : `${head}; none gained a wrong field`;
  }
}
