import type { Clock, ClockTimer } from 'pg-boss';

// pg-boss's ClaimTimer (node_modules/pg-boss/dist/claimTimer.js): a pass
// re-arms the next attempt through anchor() once its claims are stamped, and
// one that never reached them is re-armed from its own end, so the chain
// survives a pass that skipped or threw. It arms at construction and runs
// until stop(), once.
export class ClaimTimer {
  readonly #clock: Clock;
  readonly #ms: number;
  readonly #fn: () => Promise<void>;
  readonly #stopped = new AbortController();
  #handle: ClockTimer | undefined;
  #due = 0;
  // pg-boss's #anchored is cleared as each pass starts and set by anchor():
  // a pass was anchored when the last anchor() came after the last pass
  // started.
  #passes = 0;
  #anchoredPass = 0;

  constructor(clock: Clock, seconds: number, fn: () => Promise<void>) {
    this.#clock = clock;
    this.#ms = seconds * 1000;
    this.#fn = fn;
    this.#arm();
  }

  stop(): void {
    this.#stopped.abort();
    this.#disarm();
  }

  // claimTimer.js:66-71: the next attempt an interval from now, or after
  // `ms` when the pass knows when the claim it lost to comes due.
  anchor(ms = this.#ms): void {
    if (this.#stopped.signal.aborted) {
      return;
    }
    this.#anchoredPass = this.#passes;
    this.#arm(ms);
  }

  #arm(ms = this.#ms): void {
    this.#disarm();
    if (this.#stopped.signal.aborted) {
      return;
    }
    this.#due = this.#clock.now() + ms;
    this.#wait(ms);
  }

  // claimTimer.js:79-94: a timer that fires short of its due time waits out
  // the rest.
  #wait(ms: number): void {
    this.#handle = this.#clock.setTimeout(() => {
      const remaining = this.#due - this.#clock.now();
      if (remaining > 0) {
        this.#wait(remaining);
      } else {
        void this.#run();
      }
    }, ms);
  }

  #disarm(): void {
    if (this.#handle !== undefined) {
      this.#clock.clearTimeout(this.#handle);
      this.#handle = undefined;
    }
  }

  // claimTimer.js:101-119: a rejection is left to the process, as pg-boss
  // leaves it: every pass reports its own failure, so only an error event
  // nobody listens for gets here.
  async #run(): Promise<void> {
    this.#handle = undefined;
    this.#passes += 1;
    try {
      await this.#fn();
    } finally {
      if (this.#anchoredPass !== this.#passes) {
        this.#arm();
      }
    }
  }
}
