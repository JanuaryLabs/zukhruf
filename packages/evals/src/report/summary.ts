import type { ConfidenceInterval } from '@zukhruf/statistics';

import {
  Bars,
  type Bootstrap,
  type Cell,
  type Ends,
  type Primitive,
  type Run,
  RunLog,
  type Sample,
  type Section,
  Table,
  type Tone,
} from '../index.ts';
import { fixed, withEnds } from './data-tables.ts';

// A bar names a slice and one of its keys when it holds on those samples
// only, such as values_precision on the pages with offers.
type SliceKey = readonly [slice: string, key: string];

// A score of the run, read in its direction: a score that is better higher
// has a bar it must reach, and one that is better lower a bar it must stay
// under.
export type Score =
  | {
      readonly name: string;
      readonly higherIsBetter: true;
      readonly bar?: { readonly atLeast: number; readonly slice?: SliceKey };
    }
  | {
      readonly name: string;
      readonly higherIsBetter: false;
      readonly bar?: { readonly atMost: number; readonly slice?: SliceKey };
    };

// A key for each sample, such as the kind of its page. The host knows it.
export type Slice<Answer, C> = {
  readonly name: string;
  readonly key: (sample: Sample<Answer, C>) => string;
};

// How the interval of a row reads against its bar (report ADR 0004, point
// 2): met when it is past the bar on the good side, missed when it is past
// it on the bad side, open when it holds the bar, and untested when the row
// has no tests.
type Verdict = 'met' | 'missed' | 'open' | 'untested';

type Barred = {
  readonly at: number;
  readonly sign: '≥' | '≤';
  readonly verdict: Verdict;
};

// The bar of a score in its direction, with the verdict of an interval
// against it.
type Limit = {
  readonly at: number;
  readonly sign: Barred['sign'];
  readonly slice: SliceKey | undefined;
  readonly verdict: (interval: ConfidenceInterval) => Verdict;
};

type Row =
  | {
      readonly kind: 'plain';
      readonly label: string;
      readonly value: number;
      readonly ends: Ends;
    }
  | {
      readonly kind: 'barred';
      readonly label: string;
      readonly value: number;
      readonly ends: Ends;
      readonly bar: Barred;
    };

const tones: Readonly<Record<Verdict, Tone>> = {
  met: 'good',
  missed: 'bad',
  open: 'neutral',
  untested: 'neutral',
};

const list = new Intl.ListFormat('en', { type: 'conjunction' });

// Each score of a run with its value and its interval, and, for a score with
// a bar, whether the interval meets it (report ADR 0004). The value is
// Run#total and the interval Bootstrap's, so the interval belongs to the
// number beside it. A bar with a slice is read on a row of that slice only.
// The claim says what the rows give and never more (report ADR 0002): the
// bars missed, else the bars within chance, else the bars with no tests,
// else that every bar is met; with no bars, the value of each score.
export class Summary<Answer, C> implements Section {
  readonly id = 'summary';
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
    const run = log.run();
    const rows = scores.flatMap((score): Row[] => {
      const whole = Summary.#numbers(run, score.name, bootstrap);
      const plain: Row = { kind: 'plain', label: score.name, ...whole };
      const limit = Summary.#limit(score);
      if (limit === undefined) return [plain];
      const { at, sign } = limit;
      if (limit.slice === undefined)
        return [
          {
            ...plain,
            kind: 'barred',
            bar: { at, sign, verdict: limit.verdict(whole.interval) },
          },
        ];
      const [sliceName, key] = limit.slice;
      const slice = slices.find(({ name }) => name === sliceName);
      if (slice === undefined)
        throw new RangeError(
          `The bar of ${score.name} reads the slice "${sliceName}", and the slices are: ${slices.map(({ name }) => name).join(', ')}`,
        );
      const samples = log.samples.filter((sample) => slice.key(sample) === key);
      const label = `${score.name} · ${sliceName} = ${key}`;
      if (samples.length === 0)
        return [
          plain,
          {
            kind: 'barred',
            label,
            value: Number.NaN,
            ends: { low: Number.NaN, high: Number.NaN },
            bar: { at, sign, verdict: 'untested' },
          },
        ];
      const part = Summary.#numbers(
        new RunLog(log.info, samples).run(),
        score.name,
        bootstrap,
      );
      return [
        plain,
        {
          kind: 'barred',
          label,
          ...part,
          bar: { at, sign, verdict: limit.verdict(part.interval) },
        },
      ];
    });
    this.claim = Summary.#claim(
      rows,
      new Set(log.samples.map(({ test }) => test)).size,
    );
    this.primitives = [Summary.#table(rows), Summary.#bars(rows)];
  }

  static #numbers(run: Run, name: string, bootstrap: Bootstrap) {
    const interval = bootstrap.interval(run, name);
    return {
      value: run.total(name).value,
      ends: { low: interval.low, high: interval.high },
      interval,
    };
  }

  static #limit(score: Score): Limit | undefined {
    if (score.bar === undefined) return undefined;
    if (score.higherIsBetter) {
      const { atLeast, slice } = score.bar;
      return {
        at: atLeast,
        sign: '≥',
        slice,
        verdict: (interval) => {
          if (interval.isAbove(atLeast)) return 'met';
          if (interval.isBelow(atLeast)) return 'missed';
          return 'open';
        },
      };
    }
    const { atMost, slice } = score.bar;
    return {
      at: atMost,
      sign: '≤',
      slice,
      verdict: (interval) => {
        if (interval.isBelow(atMost)) return 'met';
        if (interval.isAbove(atMost)) return 'missed';
        return 'open';
      },
    };
  }

  static #claim(rows: readonly Row[], tests: number): string {
    const barred = rows.flatMap((row) => (row.kind === 'barred' ? [row] : []));
    if (barred.length === 0)
      return `${rows.map((row) => `${row.label} ${withEnds(row.value, row.ends)}`).join('; ')} over ${tests} tests`;
    const having = (verdict: Verdict) =>
      barred.filter((row) => row.bar.verdict === verdict);
    const missed = having('missed');
    if (missed.length > 0)
      return missed
        .map(
          (row) =>
            `${row.label} misses its bar of ${row.bar.at}: ${withEnds(row.value, row.ends)}`,
        )
        .join('; ');
    const open = having('open');
    if (open.length > 0)
      return open
        .map(
          (row) =>
            `${row.label} is within chance of its bar of ${row.bar.at}: ${withEnds(row.value, row.ends)}`,
        )
        .join('; ');
    const untested = having('untested');
    if (untested.length > 0)
      return untested
        .map((row) => `${row.label} has no tests for its bar of ${row.bar.at}`)
        .join('; ');
    return barred.length === 1
      ? `${list.format(barred.map(({ label }) => label))} meets its bar`
      : `${list.format(barred.map(({ label }) => label))} meet their bars`;
  }

  static #table(rows: readonly Row[]): Table {
    const plain = (text: string): Cell => ({ text, tone: 'neutral' });
    return new Table(
      // The interval method of the caller's Bootstrap does not say its
      // confidence level, so the header names none (report ADR 0002).
      ['score', 'value', 'interval', 'bar', 'verdict'],
      rows.map((row) => [
        plain(row.label),
        plain(fixed(row.value)),
        plain(`[${fixed(row.ends.low)}, ${fixed(row.ends.high)}]`),
        ...(row.kind === 'barred'
          ? [
              plain(`${row.bar.sign} ${row.bar.at}`),
              { text: row.bar.verdict, tone: tones[row.bar.verdict] },
            ]
          : [plain(''), plain('')]),
      ]),
    );
  }

  // A mark is a rule across every bar, so the scores with the same bar share
  // one mark; the table names the bar of each score, so the mark says only
  // that it is a bar. The scale holds 0 to 1, where a share lies, and widens to hold
  // a score past it, such as a mean count, so that no bar is clipped.
  static #bars(rows: readonly Row[]): Bars {
    const known = rows
      .flatMap(({ value, ends }) => [value, ends.low, ends.high])
      .filter((value) => !Number.isNaN(value));
    const marks = new Set(
      rows.flatMap((row) => (row.kind === 'barred' ? [row.bar.at] : [])),
    );
    return new Bars({
      bars: rows.map((row) => ({
        label: row.label,
        value: row.value,
        ends: row.ends,
        tone: row.kind === 'barred' ? tones[row.bar.verdict] : 'neutral',
      })),
      scale: { low: Math.min(0, ...known), high: Math.max(1, ...known) },
      marks: [...marks].map((at) => ({ label: 'bar', at })),
    });
  }
}
