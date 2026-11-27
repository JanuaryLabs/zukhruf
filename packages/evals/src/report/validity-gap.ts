import {
  type Bootstrap,
  type Cell,
  type Primitive,
  type RunLog,
  type Sample,
  type Section,
  Table,
} from '../index.ts';
import { withEnds } from './data-tables.ts';
import { measure } from './part.ts';
import type { Score } from './summary.ts';

const plain = (text: string): Cell => ({ text, tone: 'neutral' });

const { format: percent } = new Intl.NumberFormat('en', {
  style: 'percent',
  maximumFractionDigits: 1,
});

const answers = (count: number) => (count === 1 ? 'answer' : 'answers');

// Does a valid answer hide wrong values (SOB Figure 2, the JSON pass rate
// beside value accuracy; ExtractBench Table 5)? The validity is the ratio of
// a gate in the scorecards, such as SOB's schema compliance: a sample is
// valid when the gate held, a ratio of 1 of 1. A row gives the share of
// valid samples, then each score over all the samples and over the valid
// ones (measure), and how many valid samples with a whole for the score have
// a part short of it: a wrong value inside a valid answer. The claim reads
// the first score and says no more than its numbers (report ADR 0002). Bars
// are not read: a bar holds for a score over the run, not over the valid
// answers.
export class ValidityGap<Answer, C> implements Section {
  readonly id = 'validity-gap';
  readonly claim: string;
  readonly primitives: readonly Primitive[];

  constructor(
    log: RunLog<Answer, C>,
    {
      validity,
      scores,
      bootstrap,
    }: {
      readonly validity: string;
      readonly scores: readonly Score[];
      readonly bootstrap: Bootstrap;
    },
  ) {
    const [first, ...rest] = scores;
    if (first === undefined)
      throw new RangeError('A ValidityGap section needs a score to show');
    // Run#total throws for a name that no sample of the run gives, as in
    // Summary and Slices, so a misspelt name is an error, not a row of
    // dashes.
    const run = log.run();
    for (const name of [validity, ...scores.map(({ name }) => name)])
      run.total(name);
    const valid = log.samples.filter(({ scorecard }) => {
      const ratio = scorecard.ratios.get(validity);
      return (
        ratio !== undefined && ratio.whole > 0 && ratio.part === ratio.whole
      );
    });
    const share = measure(log, log.samples, validity, bootstrap);
    const row = (name: string) => {
      const scored = valid.flatMap(({ scorecard }) => {
        const ratio = scorecard.ratios.get(name);
        return ratio === undefined || ratio.whole === 0 ? [] : [ratio];
      });
      return {
        name,
        all: measure(log, log.samples, name, bootstrap),
        valid: measure(log, valid, name, bootstrap),
        wrong: scored.filter(({ part, whole }) => part < whole).length,
        scored: scored.length,
      };
    };
    const head = row(first.name);
    const rows = [head, ...rest.map(({ name }) => row(name))];
    this.claim = ValidityGap.#claim(validity, valid.length, share.value, head);
    this.primitives = [
      new Table(
        ['', 'all answers', 'valid answers', 'wrong among valid'],
        [
          [
            plain('valid'),
            plain(withEnds(share.value, share.ends)),
            plain('—'),
            plain('—'),
          ],
          ...rows.map((row) => [
            plain(row.name),
            plain(withEnds(row.all.value, row.all.ends)),
            plain(withEnds(row.valid.value, row.valid.ends)),
            plain(`${row.wrong} of ${row.scored}`),
          ]),
        ],
      ),
    ];
  }

  static #claim(
    validity: string,
    valid: number,
    share: number,
    {
      name,
      wrong,
      scored,
    }: {
      readonly name: string;
      readonly wrong: number;
      readonly scored: number;
    },
  ): string {
    if (valid === 0) return `No answer is valid by ${validity}`;
    if (scored === 0) return `No valid answer by ${validity} gives ${name}`;
    if (wrong === 0)
      return scored === 1
        ? `The one valid answer has every ${name} value right`
        : `Every one of the ${scored} valid answers has every ${name} value right`;
    return `${percent(share)} of answers are valid by ${validity}, and ${wrong} of the ${scored} valid ${answers(scored)} ${wrong === 1 ? 'has' : 'have'} a wrong ${name} value`;
  }
}
