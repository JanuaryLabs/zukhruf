import { Holm } from '@zukhruf/statistics';

import {
  type Cell,
  type PairedBootstrap,
  type Primitive,
  type Run,
  type RunPair,
  type Section,
  Table,
  type TestedVerdict,
  type Tone,
  type UntestedVerdict,
} from '../index.ts';
import { fixed, kept } from './data-tables.ts';
import type { Score } from './summary.ts';

// The level at or below which a deciding p-value counts, as in mteb's report.
const ALPHA = 0.05;

type Result = 'better' | 'worse' | 'no difference';

// The result of a test from the p-value that decides it, read in the
// direction of its score: a difference counts when p is at most 0.05, the
// rule of Holm of @zukhruf/statistics, and its sign says better or worse
// (mteb's `decide`, docs/copied-code.md).
const decide = (
  p: number,
  observed: number,
  higherIsBetter: boolean,
): Result => {
  if (p > ALPHA) return 'no difference';
  return observed * (higherIsBetter ? 1 : -1) > 0 ? 'better' : 'worse';
};

// A score with its tested verdict. A Lead adds the result that its raw p
// gives (the primary score, tested alone); a Corrected adds its Holm-adjusted
// p and the result that gives (each other score, adjusted as one family). A
// score with an untested verdict has no p and no result of one.
type Tested = {
  readonly score: Score;
  readonly verdict: TestedVerdict;
};

type Untested = {
  readonly score: Score;
  readonly verdict: UntestedVerdict;
  readonly result: 'untested';
};

type Lead = (Tested & { readonly result: Result }) | Untested;

type Corrected =
  (Tested & { readonly holm: number; readonly result: Result }) | Untested;

const tones: Readonly<Record<Result | 'untested', Tone>> = {
  better: 'good',
  worse: 'bad',
  'no difference': 'neutral',
  untested: 'neutral',
};

const { format: signed } = new Intl.NumberFormat('en', {
  signDisplay: 'exceptZero',
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

// change − baseline with its interval, such as +0.024 [+0.004, +0.046].
const difference = ({ difference: { observed, low, high } }: TestedVerdict) =>
  `${signed(observed)} [${signed(low)}, ${signed(high)}]`;

const plain = (text: string): Cell => ({ text, tone: 'neutral' });

// The total of a score on a run; a total of no whole has no value, where
// Ratio.value would show SOB's 0 (#6267).
const total = (run: Run, name: string) =>
  fixed(run.total(name).ratio.quotient ?? Number.NaN);

// Is the change better than the baseline beyond chance, on each score? Each
// verdict is PairedBootstrap's on the two runs, in the order of the scores,
// since the caller's generator keeps its state between them. The primary
// score, chosen before the runs, is tested alone at 0.05; the p-values of the
// other scores are adjusted together with Holm, so the chance of one false
// "better" or "worse" among them stays at 0.05 (report ADR 0004, point 3, as
// mteb's report does). The claim leads with the primary score and counts the
// others (report ADR 0002). A score that no resample gave a whole in both
// runs is untested, as Summary shows a bar it could not test: its row has no
// difference and no p, and Holm corrects only the scores that have a p, so an
// untested score neither joins the family nor widens its correction.
export class Verdicts<Answer, C> implements Section {
  readonly id = 'verdicts';
  readonly claim: string;
  readonly primitives: readonly Primitive[];

  constructor(
    pair: RunPair<Answer, C>,
    {
      scores,
      primary,
      bootstrap,
    }: {
      readonly scores: readonly Score[];
      readonly primary: string;
      readonly bootstrap: PairedBootstrap;
    },
  ) {
    const baseline = pair.baseline.run();
    const change = pair.change.run();
    const verdicts = scores.map((score) => ({
      score,
      verdict: bootstrap.verdict(baseline, change, score.name, {
        higherIsBetter: score.higherIsBetter,
      }),
    }));
    const primaryVerdict = verdicts.find(({ score }) => score.name === primary);
    if (primaryVerdict === undefined)
      throw new RangeError(
        `The primary score is one of the scores, and "${primary}" is not: ${scores.map(({ name }) => name).join(', ')}`,
      );
    const { score: primaryScore, verdict: leadVerdict } = primaryVerdict;
    const lead: Lead =
      leadVerdict.result === 'untested'
        ? { score: primaryScore, verdict: leadVerdict, result: 'untested' }
        : {
            score: primaryScore,
            verdict: leadVerdict,
            result: decide(
              leadVerdict.p,
              leadVerdict.difference.observed,
              primaryScore.higherIsBetter,
            ),
          };
    const family = verdicts.filter((entry) => entry !== primaryVerdict);
    const tested = family.flatMap(({ score, verdict }): Tested[] =>
      verdict.result === 'untested' ? [] : [{ score, verdict }],
    );
    const adjusted = new Holm().adjust(tested.map(({ verdict }) => verdict.p));
    // Holm gives one adjusted p-value for each p-value, in their order.
    const corrected = tested.flatMap((test, index) =>
      adjusted.slice(index, index + 1).map((holm) => ({
        ...test,
        holm,
        result: decide(
          holm,
          test.verdict.difference.observed,
          test.score.higherIsBetter,
        ),
      })),
    );
    const others = family.flatMap(({ score, verdict }): Corrected[] =>
      verdict.result === 'untested'
        ? [{ score, verdict, result: 'untested' }]
        : corrected.filter((test) => test.score === score),
    );
    const row = (entry: Lead | Corrected, holm: string): Cell[] => [
      plain(entry.score.name),
      plain(total(baseline, entry.score.name)),
      plain(total(change, entry.score.name)),
      ...(entry.result === 'untested'
        ? [plain('—'), plain('—'), plain('—')]
        : [
            plain(`${difference(entry.verdict)}${kept(entry.verdict)}`),
            plain(fixed(entry.verdict.p)),
            plain(holm),
          ]),
      { text: entry.result, tone: tones[entry.result] },
    ];
    this.claim = Verdicts.#claim(lead, others);
    this.primitives = [
      new Table(
        ['score', 'baseline', 'change', 'difference', 'p', 'Holm p', 'verdict'],
        [
          row(lead, '—'),
          ...others.map((other) =>
            row(other, other.result === 'untested' ? '—' : fixed(other.holm)),
          ),
        ],
      ),
    ];
  }

  static #claim(lead: Lead, others: readonly Corrected[]): string {
    const led = Verdicts.#led(lead);
    if (others.length === 0) return led;
    const count = (counted: Result | 'untested') =>
      others.filter((other) => other.result === counted).length;
    const untested = count('untested');
    const scores = `${others.length} ${others.length === 1 ? 'score' : 'scores'}`;
    if (untested === others.length)
      return `${led}; the other ${others.length === 1 ? 'score is' : `${scores} are`} untested`;
    const tally =
      untested === 0
        ? `${count('better')} better and ${count('worse')} worse`
        : `${count('better')} better, ${count('worse')} worse and ${untested} untested`;
    return `${led}; of the other ${scores}, after Holm, ${tally}`;
  }

  static #led(lead: Lead): string {
    const { score } = lead;
    if (lead.result === 'untested')
      return `${score.name} is untested: no resample gave it a whole in both runs`;
    if (lead.result === 'no difference')
      return `No difference beyond chance on ${score.name} (${difference(lead.verdict)})`;
    return `${score.name} is ${lead.result} beyond chance: ${difference(lead.verdict)}`;
  }
}
