// A long-lived resource the pool lends to one job at a time, such as a native
// process that keeps a model loaded. ready settles when it can take jobs; a
// worker without a warm-up has none. exited settles once, when the worker can
// no longer work: the pool learns of the end from the event, not by reading
// a state that an exit can change a moment later.
export interface Worker {
  ready?(): Promise<unknown>;
  exited(): Promise<unknown>;
  kill(): void;
  close(): Promise<void>;
}
