import {
  type Bootstrap,
  type Cell,
  Line,
  type Primitive,
  type RunLog,
  type Section,
  Table,
} from '../index.ts';
import { withEnds } from './data-tables.ts';
import { type Numbers, measure } from './part.ts';
import type { Score } from './summary.ts';

const plain = (text: string): Cell => ({ text, tone: 'neutral' });

// Where do the scores go over the runs? One line for each score over the
// runs, in the order the caller gives, with its value and its interval in
// each run, as Phoenix's chart strip, LangSmith and HELM; then a table of
// the same numbers with the tests of each run. The value is Run#total and the
// interval Bootstrap's (measure), drawn run by run and score by score, so the
// bootstrap keeps its state across the calls. A run where a score has no value
// is a gap in its line. The claim reads the first score and says no more than
// its numbers (report ADR 0002).
// Bars are not read: a bar holds for a score over one run.
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
      bootstrap,
    }: { readonly scores: readonly Score[]; readonly bootstrap: Bootstrap },
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
    const runs = logs.map((log) => ({
      id: log.info.id,
      createdAt: log.info.createdAt,
      // A test that only some runs have counts in each run that has it.
      tests: new Set(log.samples.map(({ test }) => test)).size,
      numbers: scores.map(({ name }) =>
        measure(log, log.samples, name, bootstrap),
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
        series: scores.map(({ name }, index) => ({
          label: name,
          values: runs.flatMap(({ numbers }) =>
            numbers
              .slice(index, index + 1)
              .map(({ value, ends }) => ({ value, ends })),
          ),
        })),
      }),
      new Table(
        ['run', 'created', 'tests', ...scores.map(({ name }) => name)],
        runs.map(({ id, createdAt, tests, numbers }) => [
          plain(id),
          plain(createdAt.toISOString().slice(0, 10)),
          plain(String(tests)),
          ...numbers.map(({ value, ends }) => plain(withEnds(value, ends))),
        ]),
      ),
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
