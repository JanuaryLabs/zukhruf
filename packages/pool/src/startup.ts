// How a pool starts its workers: whether it starts them all when it is
// constructed, and which creations wait for others. A startup keeps state for
// the creations of one pool, so each pool gets its own instance.
export interface Startup {
  readonly eager: boolean;
  // Returns what a new creation waits for before it begins. settled settles
  // when that creation ends, with its worker ready or failed.
  turn(settled: Promise<void>): Promise<void>;
}
