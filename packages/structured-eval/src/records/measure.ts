import type { Ratio } from '../aggregation/ratio.ts';

export type NamedRatio = readonly [name: string, ratio: Ratio];

// Counts one thing for one record and gives it as ratios.
export interface Measure {
  ratios(): Iterable<NamedRatio>;
}
