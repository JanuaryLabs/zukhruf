// A low and a high value, such as two quantiles of a bootstrap distribution.
export class ConfidenceInterval {
  readonly low: number;
  readonly high: number;

  constructor(low: number, high: number) {
    this.low = low;
    this.high = high;
  }

  // The whole interval lies above the value.
  isAbove(value: number): boolean {
    return this.low > value;
  }

  // The whole interval lies below the value.
  isBelow(value: number): boolean {
    return this.high < value;
  }
}
