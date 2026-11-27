import {
  type Cell,
  Note,
  type Primitive,
  type RunPair,
  Scatter,
  type Section,
  Table,
} from '../index.ts';
import { pairTests } from '../scoring/run.ts';
import type { TestEpochs } from '../scoring/test-epochs.ts';
import { fixed } from './data-tables.ts';
import type { Score } from './summary.ts';

// A test with a value of one score in both runs, and its move: change −
// baseline, 0 when it did not move.
type Pointed = {
  readonly test: string;
  readonly score: Score;
  readonly baseline: number;
  readonly change: number;
  readonly move: number;
};

const plain = (text: string): Cell => ({ text, tone: 'neutral' });

const { format: signed } = new Intl.NumberFormat('en', {
  signDisplay: 'exceptZero',
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

const tests = (count: number) => `${count} ${count === 1 ? 'test' : 'tests'}`;

// The value of a test on a score is the mean of its epochs. A test that no
// epoch gives the score, or whose mean has no whole, has no value:
// Ratio.value gives 0 there, and a page would read that 0 as a score (report
// ADR 0002).
const value = (epochs: TestEpochs, name: string) => {
  if (!epochs.gives(name)) return undefined;
  const mean = epochs.mean(name);
  return mean.whole === 0 ? undefined : mean.value;
};

const better = ({ move, score }: Pointed) =>
  move * (score.higherIsBetter ? 1 : -1) > 0;

// Which tests moved, and how far? For each score, a scatter of the tests with
// a value in both runs, the baseline on x and the change on y, as Weave's
// scatter of two runs; then the moved tests of every score, largest move
// first, at most `widest` rows (report ADR 0003), as Braintrust's diff of
// each row. The claim reads the first score and says no more than its
// numbers (report ADR 0002).
export class TestsMoved<Answer, C> implements Section {
  readonly id = 'tests-moved';
  readonly claim: string;
  readonly primitives: readonly Primitive[];

  constructor(
    pair: RunPair<Answer, C>,
    {
      scores,
      widest,
    }: { readonly scores: readonly Score[]; readonly widest: number },
  ) {
    if (!Number.isInteger(widest) || widest < 1)
      throw new RangeError(
        `A TestsMoved section shows a positive whole number of rows, not ${widest}`,
      );
    const baseline = pair.baseline.run();
    const change = pair.change.run();
    // Run#total throws for a score that no sample of a run gives, as in
    // Summary and Verdicts, so a misspelt score is an error, not an empty
    // scatter.
    for (const { name } of scores) {
      baseline.total(name);
      change.total(name);
    }
    // RunPair has paired the tests, so the pairing does not throw here.
    const paired = pairTests(baseline, change, 'A run pair');
    const rows = scores.map((score) => ({
      score,
      pointed: paired.flatMap(({ id, ...epochs }): Pointed[] => {
        const before = value(epochs.baseline, score.name);
        const after = value(epochs.change, score.name);
        if (before === undefined || after === undefined) return [];
        return [
          {
            test: id,
            score,
            baseline: before,
            change: after,
            move: after - before,
          },
        ];
      }),
    }));
    const [head] = rows;
    if (head === undefined)
      throw new RangeError('A TestsMoved section needs a score to show');
    // A stable sort keeps ties in the order of the scores, then of the tests.
    const moved = rows
      .flatMap(({ pointed }) => pointed.filter(({ move }) => move !== 0))
      .toSorted((a, b) => Math.abs(b.move) - Math.abs(a.move));
    this.claim = TestsMoved.#claim(
      head.score.name,
      head.pointed,
      moved.filter(({ score }) => score.name === head.score.name),
    );
    this.primitives = [
      // Each scatter carries the table of its points, which a reader of
      // Markdown reads in its place (ADR 0011).
      ...rows.map(({ score, pointed }) => {
        const x = `${score.name} · ${pair.baseline.info.label}`;
        const y = `${score.name} · ${pair.change.info.label}`;
        return new Scatter({
          x,
          y,
          points: pointed.map(({ test, baseline, change }) => ({
            label: test,
            x: baseline,
            y: change,
          })),
          table: new Table(
            ['test', x, y],
            pointed.map(({ test, baseline, change }) => [
              plain(test),
              plain(fixed(baseline)),
              plain(fixed(change)),
            ]),
          ),
        });
      }),
      moved.length === 0
        ? new Note('No test moved')
        : new Table(
            ['test', 'score', 'baseline', 'change', 'moved'],
            moved
              .slice(0, widest)
              .map(({ test, score, baseline: before, change: after, move }) => [
                plain(test),
                plain(score.name),
                plain(fixed(before)),
                plain(fixed(after)),
                plain(signed(move)),
              ]),
          ),
    ];
  }

  static #claim(
    score: string,
    pointed: readonly Pointed[],
    // The moved tests of the score, largest move first.
    moved: readonly Pointed[],
  ): string {
    if (pointed.length === 0)
      return `No test has a value of ${score} in both runs`;
    const [most] = moved;
    if (most === undefined)
      return pointed.length === 1
        ? `No test moved on ${score}; the one test gives the same value in both runs`
        : `No test moved on ${score}; the ${pointed.length} tests give the same value in both runs`;
    const up = moved.filter(better).length;
    return `${moved.length} of ${tests(pointed.length)} moved on ${score}, ${up} better and ${moved.length - up} worse; ${most.test} moved most, from ${fixed(most.baseline)} to ${fixed(most.change)}`;
  }
}
