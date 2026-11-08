import { ConfidenceInterval } from './confidence-interval.ts';

// The confidence interval of (change − baseline), with the observed
// difference: the difference that the data gives. It is data only. Each
// caller reads its own verdict from isAbove and isBelow (ADR 0001).
export class DifferenceInterval extends ConfidenceInterval {
  readonly observed: number;

  constructor(low: number, high: number, observed: number) {
    super(low, high);
    this.observed = observed;
  }
}
