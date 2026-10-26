// What a finished job tells a sizing. measurable is false while a worker the
// pool runs is not ready yet, the pool resized after the job started, or no
// job was waiting: such a time says nothing about how many workers pay.
export interface Sample {
  readonly started: number;
  readonly finished: number;
  readonly measurable: boolean;
}

// How many workers a pool runs. ceiling, decided when the pool is built, is
// the most it may run; current is how many it runs now; kept, at least
// current, is how many it keeps alive, so a worker it stops running for a
// while needs no new warm-up. current and kept may change as the sizing
// learns from finished jobs. A sizing keeps state for one pool, so each pool
// gets its own instance.
export interface Sizing {
  readonly ceiling: number;
  readonly current: number;
  readonly kept: number;
  record(sample: Sample): void;
}
