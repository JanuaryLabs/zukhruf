import {
  type Bootstrap,
  type Cell,
  type Ends,
  type Primitive,
  type RatioOfSums,
  type Run,
  RunLog,
  type Section,
  Table,
} from '../index.ts';
import { fixed, withEnds } from './data-tables.ts';
import type { Score, Slice } from './summary.ts';

// The numbers of one score on the samples of one key of a slice.
type Part = {
  readonly slice: string;
  readonly key: string;
  readonly tests: number;
  readonly value: number;
  readonly ends: Ends;
};

const byKey = new Intl.Collator('en', { numeric: true }).compare;

const list = new Intl.ListFormat('en', { type: 'conjunction' });

const plain = (text: string): Cell => ({ text, tone: 'neutral' });

const none = {
  value: Number.NaN,
  ends: { low: Number.NaN, high: Number.NaN },
};

// A ratio of no whole, such as the recall of pages with no expected value, has
// no value: Ratio.value gives 0 there, as SOB's ratio() does, and a page would
// read that 0 as a score (report ADR 0002).
const shown = (total: RatioOfSums) =>
  total.ratio.whole === 0 ? Number.NaN : total.value;

// Where a score drops: a table for each slice, a row for each of its keys,
// with the tests of the key and each score with its value and interval on
// the samples of that key. The value is Run#total and the interval
// Bootstrap's on a run of those samples, as Summary reads a bar on a slice
// (strike 2, docs/copied-code.md). A key where no sample gives a score, or
// where the score has no whole, shows a dash for it, and the claim passes
// over it. A bar holds for the population it was set on, so Slices reads no
// bar; Summary does. The claim names the key where the first score is worst,
// against its value over the run, and says no more (report ADR 0002).
export class Slices<Answer, C> implements Section {
  readonly id = 'slices';
  readonly claim: string;
  readonly primitives: readonly Primitive[];

  constructor(
    log: RunLog<Answer, C>,
    {
      scores,
      slices,
      bootstrap,
    }: {
      readonly scores: readonly Score[];
      readonly slices: readonly Slice<Answer, C>[];
      readonly bootstrap: Bootstrap;
    },
  ) {
    const [first, ...rest] = scores;
    if (first === undefined)
      throw new RangeError('A Slices section needs a score to show');
    if (slices.length === 0)
      throw new RangeError('A Slices section needs a slice to show');
    // Run#total throws for a score that no sample of the run gives, as in
    // Summary, so a misspelt score is an error, not a column of dashes.
    const run = log.run();
    const whole = shown(run.total(first.name));
    for (const { name } of rest) run.total(name);
    const tables = slices.map((slice) => {
      const keys = Map.groupBy(log.samples, (sample) => slice.key(sample));
      const rows = [...keys]
        .sort(([a], [b]) => byKey(a, b))
        .map(([key, samples]) => {
          const part = new RunLog(log.info, samples).run();
          return {
            key,
            tests: new Set(samples.map(({ test }) => test)).size,
            // A score that no sample of the key gives, such as the precision
            // of values on pages with no values, has no value there:
            // Run#total and Bootstrap throw for it, with no code to catch.
            scores: scores.map(({ name }) =>
              samples.some(({ scorecard }) => scorecard.ratios.has(name))
                ? Slices.#numbers(part, name, bootstrap)
                : none,
            ),
          };
        });
      return { slice, rows };
    });
    const parts = tables.flatMap(({ slice, rows }) =>
      rows.flatMap(({ key, tests, scores: [numbers] }): Part[] =>
        numbers === undefined
          ? []
          : [{ slice: slice.name, key, tests, ...numbers }],
      ),
    );
    this.claim = Slices.#claim(first, parts, whole, slices);
    this.primitives = tables.map(
      ({ slice, rows }) =>
        new Table(
          [slice.name, 'tests', ...scores.map(({ name }) => name)],
          rows.map((row) => [
            plain(row.key),
            plain(String(row.tests)),
            ...row.scores.map(({ value, ends }) =>
              plain(withEnds(value, ends)),
            ),
          ]),
        ),
    );
  }

  static #numbers(run: Run, name: string, bootstrap: Bootstrap) {
    const value = shown(run.total(name));
    if (Number.isNaN(value)) return none;
    const interval = bootstrap.interval(run, name);
    return { value, ends: { low: interval.low, high: interval.high } };
  }

  static #claim<Answer, C>(
    score: Score,
    parts: readonly Part[],
    whole: number,
    slices: readonly Slice<Answer, C>[],
  ): string {
    const known = parts.filter(({ value }) => !Number.isNaN(value));
    const worst = known.reduce<Part | undefined>(
      (found, part) =>
        found === undefined ||
        (score.higherIsBetter
          ? part.value < found.value
          : part.value > found.value)
          ? part
          : found,
      undefined,
    );
    if (worst === undefined)
      return `${score.name} has no value on any key of ${list.format(slices.map(({ name }) => name))}`;
    const tests = `${worst.tests} ${worst.tests === 1 ? 'test' : 'tests'}`;
    // One key with a value is no drop: it is the only place the score has.
    if (known.length === 1)
      return `${score.name} has a value only on ${worst.slice} = ${worst.key}: ${withEnds(worst.value, worst.ends)} over ${tests}`;
    const extreme = score.higherIsBetter ? 'lowest' : 'highest';
    return `${score.name} is ${extreme} on ${worst.slice} = ${worst.key}: ${withEnds(worst.value, worst.ends)} over ${tests}, against ${fixed(whole)} over the run`;
  }
}
