// A long-lived resource the pool lends to one job at a time, such as a native
// process that keeps a model loaded. run does one job: it takes the job's
// input and resolves with its output (ADR 0012). ready settles when it can
// take jobs; a worker without a warm-up has none. exited settles once, when
// the worker can no longer work: the pool learns of the end from the event,
// not by reading a state that an exit can change a moment later.
export interface Worker<Input, Output> {
  run(input: Input): Promise<Output>;
  ready?(): Promise<unknown>;
  exited(): Promise<unknown>;
  kill(): void;
  close(): Promise<void>;
}
