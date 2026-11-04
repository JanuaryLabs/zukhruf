import { Ratio } from '../../aggregation/ratio.ts';
import type { NamedRatio } from '../measure.ts';

// The expected, stated and hit values of one field or one array, as the
// precision, recall and F1 of the hits.
export class Counts {
  expected = 0;
  stated = 0;
  hits = 0;

  add(other: Counts): void {
    this.expected += other.expected;
    this.stated += other.stated;
    this.hits += other.hits;
  }

  get complete(): boolean {
    return this.hits === this.expected && this.hits === this.stated;
  }

  get f1(): Ratio {
    return new Ratio(2 * this.hits, this.stated + this.expected);
  }

  ratios(prefix: string): NamedRatio[] {
    return [
      [`${prefix}precision`, new Ratio(this.hits, this.stated)],
      [`${prefix}recall`, new Ratio(this.hits, this.expected)],
      [`${prefix}f1`, this.f1],
    ];
  }
}
