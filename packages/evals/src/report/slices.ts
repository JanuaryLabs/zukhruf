import {
  type Bootstrap,
  type Cell,
  type Ends,
  type Primitive,
  type RunLog,
  type Section,
  Table,
} from '../index.ts';
import { fixed, withEnds } from './data-tables.ts';
import { measure } from './part.ts';
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

// Where a score drops: a table for each slice, a row for each of its keys,
// with the tests of the key and each score with its value and interval on
// the samples of that key (measure), as Summary reads a bar on a slice. A key
// where no sample gives a score, or where the score has no whole, shows a
// dash for it, and the claim passes over it. A bar holds for the population
// it was set on, so Slices reads no bar; Summary does. The claim names the
// key where the first score is worst, against its value over the run, and
// says no more (report ADR 0002).
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
    // The claim reads the value over the run only when two keys have one, and
    // then the whole of the run is not 0.
    const run = log.run();
    const whole = run.total(first.name).value;
    for (const { name } of rest) run.total(name);
    const tables = slices.map((slice) => {
      const keys = Map.groupBy(log.samples, (sample) => slice.key(sample));
      const rows = [...keys]
        .sort(([a], [b]) => byKey(a, b))
        .map(([key, samples]) => ({
          key,
          tests: new Set(samples.map(({ test }) => test)).size,
          scores: scores.map(({ name }) =>
            measure(log, samples, name, bootstrap),
          ),
        }));
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
