// A part and a whole, such as 2 right values of 3 expected values. It keeps
// both, not only their quotient, so many ratios add up exactly (ADR 0004).
export class Ratio {
  readonly part: number;
  readonly whole: number;

  constructor(part: number, whole: number) {
    this.part = part;
    this.whole = whole;
  }

  // 0 when the whole is 0, as the ratio() of SOB's evaluate.py gives.
  get value(): number {
    return this.whole === 0 ? 0 : this.part / this.whole;
  }

  // The part divided by the whole, and no value when the whole is 0: a ratio
  // of no whole has no value, so a page shows none and a bootstrap leaves out
  // a resample with none (#6267). value gives SOB's 0 there.
  get quotient(): number | undefined {
    return this.whole === 0 ? undefined : this.part / this.whole;
  }

  // Ratio(value, 1).times(weight) is Ratio(value × weight, weight): the term
  // of a weighted mean.
  times(weight: number): Ratio {
    return new Ratio(this.part * weight, this.whole * weight);
  }
}
