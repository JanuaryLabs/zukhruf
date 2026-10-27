import type { Partition } from './metrics/contingency.ts';

export type Interval = {
  // The difference on the reports as they are: run - latest.
  readonly observed: number;
  // The 2.5th and 97.5th percentiles of the resampled differences.
  readonly low: number;
  readonly high: number;
  // The number of units. A design that joins many gold events makes few
  // units, and with one unit every replicate is the observed change.
  readonly blocks: number;
  readonly replicates: number;
  readonly seed: number;
};

// The paired cluster bootstrap of the difference of a statistic between two
// partitions of the same reports (Efron and Tibshirani 1993, the percentile
// interval; Koehn 2004 and Dror et al. 2018 for the paired form in NLP).
// Each replicate draws as many units as there are, with replacement, and
// scores both partitions on the same draw.
//
// The unit is a block of gold events: the smallest group of whole gold
// events that neither partition joins to a report outside the group. The
// reports of one gold event are not independent, and a false join ties two
// gold events too. Thus a copy of a block is independent of every other
// copy, and a replicate scores each false join and false split as the
// reports have it. When neither partition joins two gold events, each block
// is one gold event. (A unit of one gold event would lose, in each extra
// copy, the false joins with events that were drawn fewer times; on
// anthropic-outlets that moved the whole interval of 3152 - 3130 below the
// observed change.)
export function pairedBootstrap(options: {
  readonly gold: Partition;
  readonly run: Partition;
  readonly latest: Partition;
  readonly statistic: (key: Partition, response: Partition) => number;
  readonly replicates: number;
  readonly seed: number;
}): Interval {
  const { gold, run, latest, statistic, replicates, seed } = options;
  const blocks = blocksOf(gold, [run, latest]);
  const random = mulberry32(seed);
  const differences: number[] = [];
  for (let replicate = 0; replicate < replicates; replicate++) {
    const draws = new Array<number>(blocks.length).fill(0);
    for (let draw = 0; draw < blocks.length; draw++)
      draws[Math.floor(random() * blocks.length)]!++;
    const key = new Map<string, string>();
    const runCopy = new Map<string, string>();
    const latestCopy = new Map<string, string>();
    for (const [index, reports] of blocks.entries())
      for (let copy = 1; copy <= draws[index]!; copy++)
        for (const id of reports) {
          const mention = `${id}\u0000${copy}`;
          key.set(mention, `${gold.get(id)}\u0000${copy}`);
          runCopy.set(mention, `${run.get(id)}\u0000${copy}`);
          latestCopy.set(mention, `${latest.get(id)}\u0000${copy}`);
        }
    differences.push(statistic(key, runCopy) - statistic(key, latestCopy));
  }
  differences.sort((a, b) => a - b);
  // The nearest-rank percentile.
  const percentile = (p: number) =>
    differences[Math.max(0, Math.ceil(p * replicates) - 1)]!;
  return {
    observed: statistic(gold, run) - statistic(gold, latest),
    low: percentile(0.025),
    high: percentile(0.975),
    blocks: blocks.length,
    replicates,
    seed,
  };
}

// The reports of each block: the connected components of the reports, where
// two reports connect when one partition puts them in one group.
function blocksOf(gold: Partition, others: readonly Partition[]): string[][] {
  const parent = new Map([...gold.keys()].map((id) => [id, id]));
  const root = (id: string): string => {
    let top = id;
    while (parent.get(top) !== top) top = parent.get(top)!;
    parent.set(id, top);
    return top;
  };
  for (const partition of [gold, ...others]) {
    const first = new Map<string, string>();
    for (const id of gold.keys()) {
      const group = partition.get(id)!;
      const seen = first.get(group);
      if (seen === undefined) first.set(group, id);
      else parent.set(root(id), root(seen));
    }
  }
  return [...Map.groupBy(gold.keys(), root).values()];
}

// Mulberry32 (Tommy Ettinger, 2017): a seeded 32-bit generator, so that a
// run gives the same interval each time.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
