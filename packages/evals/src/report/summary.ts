import type { ConfidenceInterval } from '@zukhruf/statistics';

import {
  Bars,
  type Bootstrap,
  type Cell,
  type Ends,
  type Primitive,
  type RunLog,
  type Sample,
  type Section,
  Table,
  type Tone,
} from '../index.ts';
import { fixed, withEnds } from './data-tables.ts';
import { type Numbers, measure } from './part.ts';

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
// A level of 0.95 - 0.05, which is 0.8999999999999999, reads 90%.
const { format: percent } = new Intl.NumberFormat('en', {
  style: 'percent',
  maximumFractionDigits: 1,
});

// Each score of a run with its value and its interval, and, for a score with
// a bar, whether the interval meets it (report ADR 0004). The value is
// Run#total and the interval Bootstrap's, so the interval belongs to the
// number beside it (measure). A bar with a slice is read on a row of that
// slice only.
// The claim says what the rows give and never more (report ADR 0002): the
// bars missed, else the bars within chance, else the bars with no value,
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
    // Run#total throws for a score that no sample of the run gives, so a
    // misspelt score is an error, not a row of dashes.
    const run = log.run();
    for (const { name } of scores) run.total(name);
    const rows = scores.flatMap((score): Row[] => {
      const whole = measure(log, log.samples, score.name, bootstrap);
      const plain: Row = { kind: 'plain', label: score.name, ...whole };
      const limit = Summary.#limit(score);
      if (limit === undefined) return [plain];
      const { at, sign } = limit;
      const verdict = ({ interval }: Numbers): Verdict =>
        interval === undefined ? 'untested' : limit.verdict(interval);
      if (limit.slice === undefined)
        return [
          {
            ...plain,
            kind: 'barred',
            bar: { at, sign, verdict: verdict(whole) },
          },
        ];
      const [sliceName, key] = limit.slice;
      const slice = slices.find(({ name }) => name === sliceName);
      if (slice === undefined)
        throw new RangeError(
          `The bar of ${score.name} reads the slice "${sliceName}", and the slices are: ${slices.map(({ name }) => name).join(', ')}`,
        );
      // A slice where no sample gives the score, or where it has no samples,
      // has no value for the bar.
      const part = measure(
        log,
        log.samples.filter((sample) => slice.key(sample) === key),
        score.name,
        bootstrap,
      );
      return [
        plain,
        {
          kind: 'barred',
          label: `${score.name} · ${sliceName} = ${key}`,
          ...part,
          bar: { at, sign, verdict: verdict(part) },
        },
      ];
    });
    this.claim = Summary.#claim(
      rows,
      new Set(log.samples.map(({ test }) => test)).size,
    );
    this.primitives = [
      Summary.#bars(rows, Summary.#table(rows, bootstrap.level)),
    ];
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
      return `${rows.map((row) => `${row.label} ${withEnds(row.value, row.ends)}`).join('; ')} over ${tests} ${tests === 1 ? 'test' : 'tests'}`;
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
        .map((row) => `${row.label} has no value for its bar of ${row.bar.at}`)
        .join('; ');
    return barred.length === 1
      ? `${list.format(barred.map(({ label }) => label))} meets its bar`
      : `${list.format(barred.map(({ label }) => label))} meet their bars`;
  }

  static #table(rows: readonly Row[], level: number): Table {
    const plain = (text: string): Cell => ({ text, tone: 'neutral' });
    return new Table(
      ['score', 'value', `${percent(level)} interval`, 'bar', 'verdict'],
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

  // The bars carry the table, so a reader of Markdown reads each number once
  // (ADR 0011). A mark is a rule across every bar, so the scores with the
  // same bar share one mark; the table names the bar of each score, so the
  // mark says only that it is a bar. The scale holds 0 to 1, where a share
  // lies, and widens to hold a score past it, such as a mean count, so that no
  // bar is clipped.
  static #bars(rows: readonly Row[], table: Table): Bars {
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
      table,
    });
  }
}
