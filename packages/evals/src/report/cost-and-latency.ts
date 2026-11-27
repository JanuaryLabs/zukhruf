import { Linear } from '@zukhruf/statistics';

import {
  type Cell,
  type Primitive,
  type RunLog,
  type Sample,
  type Section,
  Table,
} from '../index.ts';

const plain = (text: string): Cell => ({ text, tone: 'neutral' });

const { format: count } = new Intl.NumberFormat('en');
const { format: dollars } = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

const linear = new Linear();

// What a run cost, and how long an answer took (Braintrust's metric columns,
// Phoenix, micro1's p50 and p90). A replayed answer keeps the usage of the
// call that first gave it, so the answers' column sums the usage of every
// sample, and the new calls' column, what the run spent, sums the samples
// that were not replayed (ADR 0007, point 5). Latency is read on the new
// calls only: the latency of a replay is the time of a cache read, not of
// the model. The claim says no more than the numbers (report ADR 0002).
export class CostAndLatency<Answer, C> implements Section {
  readonly id = 'cost-and-latency';
  readonly claim: string;
  readonly primitives: readonly Primitive[];

  constructor(log: RunLog<Answer, C>) {
    const answers = log.samples;
    if (answers.length === 0)
      throw new RangeError('A CostAndLatency section needs a sample to show');
    const calls = answers.filter(({ call }) => !call.replayed);
    const tokens = (
      samples: readonly Sample<Answer, C>[],
      key: 'input' | 'output' | 'cachedInput',
    ) =>
      count(
        samples.reduce((sum, { call }) => sum + (call.usage?.[key] ?? 0), 0),
      );
    const cost = (samples: readonly Sample<Answer, C>[]) => {
      const costs = samples.flatMap(({ call }) => {
        const value = call.usage?.cost;
        return value === undefined ? [] : [value];
      });
      return costs.length === 0
        ? undefined
        : dollars(costs.reduce((sum, value) => sum + value, 0));
    };
    const latencies = calls
      .map(({ latencyMs }) => latencyMs)
      .toSorted((a, b) => a - b);
    const latency =
      latencies.length === 0
        ? undefined
        : {
            p50: seconds(linear.of(latencies, 0.5)),
            p90: seconds(linear.of(latencies, 0.9)),
          };
    const spend = cost(calls);
    this.claim = CostAndLatency.#claim(
      answers.length,
      calls.length,
      spend,
      latency,
    );
    this.primitives = [
      new Table(
        ['', 'answers', 'new calls'],
        [
          ['samples', count(answers.length), count(calls.length)],
          ['input tokens', tokens(answers, 'input'), tokens(calls, 'input')],
          ['output tokens', tokens(answers, 'output'), tokens(calls, 'output')],
          [
            'cached input tokens',
            tokens(answers, 'cachedInput'),
            tokens(calls, 'cachedInput'),
          ],
          ['cost', cost(answers) ?? '—', spend ?? '—'],
          ['latency p50', '—', latency?.p50 ?? '—'],
          ['latency p90', '—', latency?.p90 ?? '—'],
        ].map((row) => row.map(plain)),
      ),
    ];
  }

  static #claim(
    answers: number,
    calls: number,
    spend: string | undefined,
    latency: { readonly p50: string; readonly p90: string } | undefined,
  ): string {
    if (latency === undefined)
      return answers === 1
        ? 'The one answer was replayed, so the run spent nothing and its latency cannot be read'
        : `All ${answers} answers were replayed, so the run spent nothing and its latency cannot be read`;
    const counted = `${calls} of ${answers} ${answers === 1 ? 'answer' : 'answers'} ${calls === 1 ? 'was a new call' : 'were new calls'}`;
    const took = `an answer took ${latency.p50} at the median and ${latency.p90} at the 90th percentile`;
    // Usage#cost is undefined when the runner does not know the price of a
    // call (run-log.ts); the claim then says that, and names no sum.
    return spend === undefined
      ? `${counted}, at a price that the run does not know; ${took}`
      : `${counted}, which spent ${spend}; ${took}`;
  }
}
