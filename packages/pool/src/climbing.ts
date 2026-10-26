import { capacity } from './capacity.ts';
import type { Sample, Sizing } from './sizing.ts';

// A window of jobs ends after both, so the sizes of the files it held do not
// decide alone.
const jobs = 20;
const span = 2_000;

// What a window of jobs at one size did.
export interface Window {
  readonly jobs: number;
  // Milliseconds from the first job's end to the last job's end.
  readonly span: number;
  // Milliseconds the jobs took, summed.
  readonly busy: number;
}

// Finds how many workers pay by trying one more. Work that changes while it
// is measured, as when files arrive grouped by kind, would decide a plain
// before and after, so each step measures in the order A, B, A: a window at
// the size that pays so far, one at a size larger, and one back at the first
// size. The larger size pays when its window compared to the mean of both
// first windows passes the variant's test. Pools start with two workers,
// learn once, and never pass the Mac's capacity. Variants say what a window
// measures and what passes.
export abstract class Climbing implements Sizing {
  readonly ceiling: number;
  #size: number;
  #step: 'before' | 'more' | 'after' | 'settled';
  #before = 0;
  #more = 0;
  #first = 0;
  #count = 0;
  #busy = 0;

  constructor(options: { memoryPerWorker: number }) {
    this.ceiling = capacity(options.memoryPerWorker);
    this.#size = Math.min(2, this.ceiling);
    this.#step = this.#size < this.ceiling ? 'before' : 'settled';
  }

  get current(): number {
    return this.#step === 'more' ? this.#size + 1 : this.#size;
  }

  // The worker the step tries stays alive while the step measures the size
  // before it again.
  get kept(): number {
    return this.#step === 'more' || this.#step === 'after'
      ? this.#size + 1
      : this.#size;
  }

  record({ started, finished, measurable }: Sample): void {
    if (this.#step === 'settled') return;
    if (!measurable) {
      this.#restart();
      return;
    }
    if (this.#count === 0) this.#first = finished;
    this.#count++;
    this.#busy += finished - started;
    if (this.#count < jobs || finished - this.#first < span) return;
    const value = this.measure({
      jobs: this.#count,
      span: finished - this.#first,
      busy: this.#busy,
    });
    this.#restart();
    if (this.#step === 'before') {
      this.#before = value;
      this.#step = 'more';
    } else if (this.#step === 'more') {
      this.#more = value;
      this.#step = 'after';
    } else if (this.pays(this.#more / ((this.#before + value) / 2))) {
      this.#size++;
      this.#step = this.#size < this.ceiling ? 'before' : 'settled';
    } else this.#step = 'settled';
  }

  #restart(): void {
    this.#count = 0;
    this.#busy = 0;
  }

  // The number a window yields, such as jobs a second.
  protected abstract measure(window: Window): number;

  // Whether one more worker pays, given what its window measured divided by
  // the mean of the windows before and after it.
  protected abstract pays(ratio: number): boolean;
}
