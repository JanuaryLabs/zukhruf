import {
  type Bootstrap,
  type Cell,
  Line,
  type Primitive,
  type RunLog,
  type Sample,
  type Section,
  Table,
} from '../index.ts';
import { withEnds, withKept } from './data-tables.ts';
import { type Numbers, measure } from './part.ts';
import type { Score, Slice } from './summary.ts';

const plain = (text: string): Cell => ({ text, tone: 'neutral' });

// Where do the scores go over the runs? One line for each score over the
// runs, in the order the caller gives, with its value and its interval in
// each run, as Phoenix's chart strip, LangSmith and HELM, carrying a table of
// the same numbers with the tests of each run (ADR 0011). A score whose bar is
// on a slice has a second line right after its own, on each run's samples of
// that key, named as Summary names its row, so a host passes Summary's scores
// and slices and reads the bar's numbers over the runs (#6410). The value is
// Run#total and the interval Bootstrap's (measure), drawn run by run and line
// by line, so the bootstrap keeps its state across the calls. A run where a
// line has no value, such as a run with no sample of the key, is a gap in it.
// The claim reads the first score over the whole run and says no more than
// its numbers (report ADR 0002).
// The bar's number and verdict are not read: a bar holds for a score over one
// run.
export class Trend<Answer, C> implements Section {
  readonly id = 'trend';
  readonly claim: string;
  readonly primitives: readonly Primitive[];

  constructor(
    // Two runs or more: a trend of one run cannot be written.
    logs: readonly [
      RunLog<Answer, C>,
      RunLog<Answer, C>,
      ...RunLog<Answer, C>[],
    ],
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
    const [head] = scores;
    if (head === undefined)
      throw new RangeError('A Trend section needs a score to show');
    // Run#total throws for a score that no sample of a run gives, as in
    // Summary and TestsMoved, so a misspelt score is an error, not a line of
    // gaps.
    for (const log of logs) {
      const run = log.run();
      for (const { name } of scores) run.total(name);
    }
    const lines = scores.flatMap((score) => {
      const whole = {
        label: score.name,
        name: score.name,
        of: (): boolean => true,
      };
      const on = score.bar?.slice;
      if (on === undefined) return [whole];
      const [sliceName, key] = on;
      const slice = slices.find(({ name }) => name === sliceName);
      if (slice === undefined)
        throw new RangeError(
          `The bar of ${score.name} reads the slice "${sliceName}", and the slices are: ${slices.map(({ name }) => name).join(', ')}`,
        );
      return [
        whole,
        {
          label: `${score.name} · ${sliceName} = ${key}`,
          name: score.name,
          of: (sample: Sample<Answer, C>) => slice.key(sample) === key,
        },
      ];
    });
    const runs = logs.map((log) => ({
      id: log.info.id,
      createdAt: log.info.createdAt,
      // A test that only some runs have counts in each run that has it.
      tests: new Set(log.samples.map(({ test }) => test)).size,
      numbers: lines.map(({ name, of }) =>
        measure(log, log.samples.filter(of), name, bootstrap),
      ),
    }));
    this.claim = Trend.#claim(
      head.name,
      runs.flatMap(({ id, numbers: [first] }) =>
        first === undefined || Number.isNaN(first.value)
          ? []
          : [{ id, numbers: first }],
      ),
      runs.length,
    );
    this.primitives = [
      new Line({
        steps: runs.map(({ id }) => id),
        series: lines.map(({ label }, index) => ({
          label,
          values: runs.flatMap(({ numbers }) =>
            numbers
              .slice(index, index + 1)
              .map(({ value, ends }) => ({ value, ends })),
          ),
        })),
        table: new Table(
          ['run', 'created', 'tests', ...lines.map(({ label }) => label)],
          runs.map(({ id, createdAt, tests, numbers }) => [
            plain(id),
            plain(createdAt.toISOString().slice(0, 10)),
            plain(String(tests)),
            ...numbers.map((entry) => plain(withKept(entry))),
          ]),
        ),
      }),
    ];
  }

  static #claim(
    score: string,
    // The runs with a value of the score, in the order given.
    valued: readonly { readonly id: string; readonly numbers: Numbers }[],
    runs: number,
  ): string {
    const first = valued.at(0);
    const last = valued.at(-1);
    if (first === undefined || last === undefined)
      return `${score} has no value on any of the ${runs} runs`;
    const shown = ({ value, ends }: Numbers) => withEnds(value, ends);
    if (valued.length === 1)
      return `${score} has a value on one run only, ${first.id}: ${shown(first.numbers)}`;
    return `${score} went from ${shown(first.numbers)} on ${first.id} to ${shown(last.numbers)} on ${last.id} over ${runs} runs`;
  }
}
