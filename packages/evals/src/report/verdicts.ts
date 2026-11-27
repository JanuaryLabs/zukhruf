import { Holm } from '@zukhruf/statistics';

import {
  type Cell,
  type PairedBootstrap,
  type Primitive,
  type RunPair,
  type Section,
  Table,
  type Tone,
  type Verdict,
} from '../index.ts';
import { fixed } from './data-tables.ts';
import type { Score } from './summary.ts';

// The level below which a deciding p-value counts, as in mteb's report.
const ALPHA = 0.05;

type Result = 'better' | 'worse' | 'no difference';

// The result of a test from the p-value that decides it, read in the
// direction of its score: a difference counts when p is below 0.05, and its
// sign says better or worse (mteb's `decide`, docs/copied-code.md).
const decide = (
  p: number,
  observed: number,
  higherIsBetter: boolean,
): Result => {
  if (p >= ALPHA) return 'no difference';
  return observed * (higherIsBetter ? 1 : -1) > 0 ? 'better' : 'worse';
};

// A score with its verdict. A Lead adds the result that its raw p gives (the
// primary score, tested alone); a Corrected adds its Holm-adjusted p and the
// result that gives (each other score, adjusted as one family).
type Tested = {
  readonly score: Score;
  readonly verdict: Verdict;
};

type Lead = Tested & { readonly result: Result };

type Corrected = Tested & { readonly holm: number; readonly result: Result };

const tones: Readonly<Record<Result, Tone>> = {
  better: 'good',
  worse: 'bad',
  'no difference': 'neutral',
};

const { format: signed } = new Intl.NumberFormat('en', {
  signDisplay: 'exceptZero',
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

// change − baseline with its interval, such as +0.024 [+0.004, +0.046].
const difference = ({ difference: { observed, low, high } }: Verdict) =>
  `${signed(observed)} [${signed(low)}, ${signed(high)}]`;

const plain = (text: string): Cell => ({ text, tone: 'neutral' });

// Is the change better than the baseline beyond chance, on each score? Each
// verdict is PairedBootstrap's on the two runs, in the order of the scores,
// since the caller's generator keeps its state between them. The primary
// score, chosen before the runs, is tested alone at 0.05; the p-values of the
// other scores are adjusted together with Holm, so the chance of one false
// "better" or "worse" among them stays at 0.05 (report ADR 0004, point 3, as
// mteb's report does). The claim leads with the primary score and counts the
// others (report ADR 0002).
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
    const tested = scores.map((score): Tested => ({
      score,
      verdict: bootstrap.verdict(baseline, change, score.name, {
        higherIsBetter: score.higherIsBetter,
      }),
    }));
    const primaryTested = tested.find(({ score }) => score.name === primary);
    if (primaryTested === undefined)
      throw new RangeError(
        `The primary score is one of the scores, and "${primary}" is not: ${scores.map(({ name }) => name).join(', ')}`,
      );
    const lead: Lead = {
      ...primaryTested,
      result: decide(
        primaryTested.verdict.p,
        primaryTested.verdict.difference.observed,
        primaryTested.score.higherIsBetter,
      ),
    };
    const family = tested.filter((test) => test !== primaryTested);
    const adjusted = new Holm().adjust(family.map(({ verdict }) => verdict.p));
    // Holm gives one adjusted p-value for each p-value, in their order.
    const others = family.flatMap((test, index) =>
      adjusted.slice(index, index + 1).map((holm): Corrected => ({
        ...test,
        holm,
        result: decide(
          holm,
          test.verdict.difference.observed,
          test.score.higherIsBetter,
        ),
      })),
    );
    const row = (
      { score, verdict, result }: Lead | Corrected,
      holm: string,
    ): Cell[] => [
      plain(score.name),
      plain(fixed(baseline.total(score.name).value)),
      plain(fixed(change.total(score.name).value)),
      plain(difference(verdict)),
      plain(fixed(verdict.p)),
      plain(holm),
      { text: result, tone: tones[result] },
    ];
    this.claim = Verdicts.#claim(lead, others);
    this.primitives = [
      new Table(
        ['score', 'baseline', 'change', 'difference', 'p', 'Holm p', 'verdict'],
        [
          row(lead, '—'),
          ...others.map((other) => row(other, fixed(other.holm))),
        ],
      ),
    ];
  }

  static #claim(lead: Lead, others: readonly Corrected[]): string {
    const { score, verdict, result } = lead;
    const led =
      result === 'no difference'
        ? `No difference beyond chance on ${score.name} (${difference(verdict)})`
        : `${score.name} is ${result} beyond chance: ${difference(verdict)}`;
    if (others.length === 0) return led;
    const count = (counted: Result) =>
      others.filter((other) => other.result === counted).length;
    return `${led}; of the other ${others.length} ${others.length === 1 ? 'score' : 'scores'}, after Holm, ${count('better')} better and ${count('worse')} worse`;
  }
}
