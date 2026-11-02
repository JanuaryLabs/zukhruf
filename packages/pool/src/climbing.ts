import { capacity } from './capacity.ts';
import type { Sample, Sizing } from './sizing.ts';

// A window of jobs ends after both, so the sizes of the files it held do not
// decide alone.
const jobs = 20;
const span = 2_000;

// A pause between two steps that changed nothing doubles from one window up
// to this many, as .NET's hill climbing waits up to ten times longer when
// more threads hurt: each step with one more warms up a worker for nothing.
const longestPause = 16;

// What a window of jobs at one size did.
export interface Window {
  readonly jobs: number;
  // Milliseconds from the first job's end to the last job's end.
  readonly span: number;
  // Milliseconds the jobs took, summed.
  readonly busy: number;
}

// Finds how many workers pay by trying more or fewer, step after step, for as
// long as the pool runs. Work that changes while it is measured, as when files
// arrive grouped by kind, would decide a plain before and after, so each step
// measures in the order A, B, A: a window at the size that pays so far, one at
// the size it tries, and one back at the first size. The larger of the two
// sizes pays when its window compared to the other passes the variant's test.
// One more worker that pays is kept at once; the pool lets its last worker go
// only after that worker failed to pay in two steps in a row, because a worker
// that closes too early must warm up again. A step with fewer workers keeps
// every worker alive. A step that changes the size leads to another step in
// the same direction at once; any other step turns around after a pause. The
// pause has a random length, so pools in other processes do not measure each
// other's steps (.NET; AWS's exponential backoff and jitter). Pools start with
// two workers and never pass what the Mac affords, which they read again after
// each window. Variants say what a window measures, what passes, and how many
// workers a step with fewer tries.
export abstract class Climbing implements Sizing {
  readonly ceiling: number;
  readonly #memoryPerWorker: number;
  // The workers the Mac affords now; other processes take and free memory.
  #room: number;
  #size: number;
  #direction: 'more' | 'fewer' = 'more';
  #step: 'pause' | 'before' | 'tried' | 'after' | 'settled';
  // Steps in a row in which fewer workers did as well.
  #unpaid = 0;
  // Steps in a row that changed nothing, and when the pause after them ends.
  #calm = 0;
  #resume = 0;
  #before = 0;
  #tried = 0;
  #first = 0;
  #count = 0;
  #busy = 0;

  constructor(options: { memoryPerWorker: number }) {
    this.#memoryPerWorker = options.memoryPerWorker;
    this.ceiling = capacity(options.memoryPerWorker);
    this.#room = this.ceiling;
    this.#size = Math.min(2, this.ceiling);
    this.#step = this.ceiling > 1 ? 'before' : 'settled';
  }

  get current(): number {
    if (this.#step !== 'tried') return this.#size;
    return this.#direction === 'more' ? this.#size + 1 : this.fewer(this.#size);
  }

  // The worker a step tries stays alive while the step measures the size
  // before it again, and a step with fewer workers keeps every worker.
  get kept(): number {
    return this.#direction === 'more' &&
      (this.#step === 'tried' || this.#step === 'after')
      ? this.#size + 1
      : this.#size;
  }

  record({ started, finished, measurable }: Sample): void {
    if (this.#step === 'settled') return;
    if (this.#step === 'pause' && finished >= this.#resume) {
      this.#step = 'before';
      this.#restart();
    }
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
    this.#room = Math.min(this.ceiling, capacity(this.#memoryPerWorker));
    if (this.kept > this.#room) {
      // Memory that other processes took does not wait for two steps.
      this.#size = Math.min(this.#size, this.#room);
      this.#unpaid = 0;
      this.#direction = 'fewer';
      this.#step = 'before';
      return;
    }
    if (this.#step === 'pause') return;
    if (this.#step === 'before') {
      // With no step that fits, the sizing measures again.
      if (!this.#aim()) return;
      this.#before = value;
      this.#step = 'tried';
    } else if (this.#step === 'tried') {
      this.#tried = value;
      this.#step = 'after';
    } else this.#decide((this.#before + value) / 2, finished);
  }

  #decide(base: number, finished: number): void {
    const size = this.#size;
    let changed = false;
    if (this.#direction === 'more') {
      changed = this.pays(this.#tried / base, size + 1, size);
      if (changed) this.#size++;
    } else if (this.pays(base / this.#tried, size, this.fewer(size)))
      this.#unpaid = 0;
    else if (++this.#unpaid === 2) {
      this.#unpaid = 0;
      this.#size--;
      changed = true;
    }
    this.#step = 'before';
    if (changed) this.#calm = 0;
    else if (this.#unpaid === 0) {
      this.#direction = this.#direction === 'more' ? 'fewer' : 'more';
      const windows = Math.min(2 ** this.#calm++, longestPause);
      this.#resume = finished + span * windows * (0.5 + Math.random());
      this.#step = 'pause';
    }
  }

  // Turns the next step to a direction that fits, and tells whether one does.
  #aim(): boolean {
    const fewer = this.fewer(this.#size);
    const more = this.#size < this.#room;
    const less = fewer >= 1 && fewer < this.#size;
    if (!more) this.#direction = 'fewer';
    if (!less) this.#direction = 'more';
    return more || less;
  }

  #restart(): void {
    this.#count = 0;
    this.#busy = 0;
  }

  // The number a window yields, such as jobs a second.
  protected abstract measure(window: Window): number;

  // Whether the last of `larger` workers pays, given what a window at
  // `larger` measured divided by what a window at `smaller` measured.
  protected abstract pays(
    ratio: number,
    larger: number,
    smaller: number,
  ): boolean;

  // How many workers a step with fewer tries when `size` run.
  protected fewer(size: number): number {
    return size - 1;
  }
}
