import {
  type Cell,
  Note,
  type Primitive,
  type RunLog,
  type Sample,
  type Section,
  Table,
} from '../index.ts';
import { fixed } from './data-tables.ts';
import type { Score } from './summary.ts';

// The spread of one test on one score: the value of each of its epochs, in
// epoch order, and the range of those with a value.
type Spread = {
  readonly test: string;
  readonly score: string;
  readonly epochs: readonly number[];
  readonly low: number;
  readonly high: number;
};

const plain = (text: string): Cell => ({ text, tone: 'neutral' });

const { format: percent } = new Intl.NumberFormat('en', {
  style: 'percent',
  maximumFractionDigits: 1,
});

const tests = (count: number) => `${count} ${count === 1 ? 'test' : 'tests'}`;

// An epoch whose sample does not give the score, or gives it a ratio of no
// whole, has no value: Ratio.value gives 0 there, as SOB's ratio() does, and
// a page would read that 0 as a score (report ADR 0002).
const value = <Answer, C>({ scorecard }: Sample<Answer, C>, name: string) => {
  const ratio = scorecard.ratios.get(name);
  return ratio === undefined || ratio.whole === 0 ? Number.NaN : ratio.value;
};

// Do the epochs of a test agree (report ADR 0005)? The spread of a test on a
// score is the range of the score over its epochs, each epoch's own ratio,
// not promptfoo's repeatStability, which reads pass flags. A test with fewer
// than two epochs with a value has no spread and is not counted. A table
// gives, for each score, the tests with a spread and the share of them whose
// spread is not 0; a second lists those tests, widest first, with the value
// of each epoch, at most `widest` rows (report ADR 0003). The claim reads the
// first score and says no more than its numbers (report ADR 0002). Bars are
// not read: a bar holds for a score over the run, not for one test.
export class RepeatSpread<Answer, C> implements Section {
  readonly id = 'repeat-spread';
  readonly claim: string;
  readonly primitives: readonly Primitive[];

  constructor(
    log: RunLog<Answer, C>,
    {
      scores,
      widest,
    }: { readonly scores: readonly Score[]; readonly widest: number },
  ) {
    if (!Number.isInteger(widest) || widest < 1)
      throw new RangeError(
        `A RepeatSpread section shows a positive whole number of rows, not ${widest}`,
      );
    // Run#total throws for a score that no sample of the run gives, as in
    // Summary and Slices, so a misspelt score is an error, not an empty row.
    const run = log.run();
    for (const { name } of scores) run.total(name);
    // Map.groupBy keeps the tests in the order of their first samples.
    const byTest = [...Map.groupBy(log.samples, ({ test }) => test)].map(
      ([test, samples]) => ({
        test,
        samples: samples.toSorted((a, b) => a.epoch - b.epoch),
      }),
    );
    const rows = scores.map(({ name }) => {
      const tested = byTest.flatMap(({ test, samples }): Spread[] => {
        const epochs = samples.map((sample) => value(sample, name));
        const known = epochs.filter((epoch) => !Number.isNaN(epoch));
        if (known.length < 2) return [];
        return [
          {
            test,
            score: name,
            epochs,
            low: Math.min(...known),
            high: Math.max(...known),
          },
        ];
      });
      return {
        name,
        tested,
        unstable: tested.filter(({ low, high }) => high !== low),
      };
    });
    // A stable sort keeps ties in the order of the scores, then of the tests.
    const wide = rows
      .flatMap(({ unstable }) => unstable)
      .toSorted((a, b) => b.high - b.low - (a.high - a.low));
    const [head] = rows;
    if (head === undefined)
      throw new RangeError('A RepeatSpread section needs a score to show');
    this.claim = RepeatSpread.#claim(
      head.name,
      head.tested,
      wide.filter(({ score }) => score === head.name),
    );
    this.primitives = [
      new Table(
        ['score', 'tests with epochs', 'unstable', 'share'],
        rows.map(({ name, tested, unstable }) => [
          plain(name),
          plain(String(tested.length)),
          plain(String(unstable.length)),
          plain(
            tested.length === 0
              ? '—'
              : percent(unstable.length / tested.length),
          ),
        ]),
      ),
      wide.length === 0
        ? new Note('No test gives another value of a score in another epoch')
        : new Table(
            ['test', 'score', 'spread', 'epochs'],
            wide
              .slice(0, widest)
              .map(({ test, score, epochs, low, high }) => [
                plain(test),
                plain(score),
                plain(fixed(high - low)),
                plain(epochs.map(fixed).join(', ')),
              ]),
          ),
    ];
  }

  static #claim(
    score: string,
    tested: readonly Spread[],
    // The unstable tests of the score, widest first.
    unstable: readonly Spread[],
  ): string {
    if (tested.length === 0)
      return `No test has two epochs with a value of ${score}, so its spread cannot be read`;
    const [widest] = unstable;
    if (widest === undefined)
      return tested.length === 1
        ? `The one test gives the same ${score} in each epoch`
        : `Every one of the ${tested.length} tests gives the same ${score} in each epoch`;
    return `${unstable.length} of ${tests(tested.length)} ${unstable.length === 1 ? 'gives' : 'give'} another ${score} in another epoch; ${widest.test} spreads widest, from ${fixed(widest.low)} to ${fixed(widest.high)}`;
  }
}
