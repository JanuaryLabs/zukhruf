import { ConfidenceInterval } from '../interval/confidence-interval.ts';

// The confidence interval of a bootstrap, with the number of resamples it
// comes from (those whose statistic has a value) and the nResamples drawn.
export class BootstrapInterval extends ConfidenceInterval {
  readonly resamples: number;
  readonly nResamples: number;

  constructor(
    low: number,
    high: number,
    {
      resamples,
      nResamples,
    }: { readonly resamples: number; readonly nResamples: number },
  ) {
    super(low, high);
    this.resamples = resamples;
    this.nResamples = nResamples;
  }
}
