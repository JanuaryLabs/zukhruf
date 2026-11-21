import type { TestClock } from 'pg-boss';

// pg-boss times a worker's polling round with Date.now() and waits the rest of
// the interval on its clock (12.38.1, #990: worker.js:67,90,98), and
// sqlite-queue does the same. On a TestClock, the real time of each fetch
// would make the next poll early by that time, so two engines' polls would
// differ with the speed of their fetches. While an engine runs on a TestClock
// (each parity run, and each parity scenario built by hand), Date.now reads
// that clock, so no real time reaches a poll. A wait that must take real time
// is measured with performance.now().
export class DateFollowsClock implements Disposable {
  readonly #now = Date.now;

  constructor(clock: TestClock) {
    Date.now = () => clock.now();
  }

  [Symbol.dispose](): void {
    Date.now = this.#now;
  }
}
