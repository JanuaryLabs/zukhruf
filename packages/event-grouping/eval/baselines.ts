import type { Partition } from './metrics/contingency.ts';

// The two partitions that need no detector (#3181). A design must beat both
// on the main score of a set to count as a gain there (README.md).
export function baselines(gold: Partition): {
  readonly allSingletons: Partition;
  readonly allInOne: Partition;
} {
  return {
    allSingletons: new Map([...gold.keys()].map((id) => [id, id])),
    allInOne: new Map([...gold.keys()].map((id) => [id, 'all'])),
  };
}
