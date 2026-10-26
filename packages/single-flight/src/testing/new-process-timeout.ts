/**
 * How long a test waits for a new Node process or worker thread to start and
 * report. It loads the TypeScript sources first: about 170 ms on a calm
 * machine, and more than 2 s on a busy CI runner.
 */
export const newProcessTimeout = 10_000;
