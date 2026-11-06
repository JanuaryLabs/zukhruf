// One round of a change watch: when the watch started and when the check
// began, on the clock of the watch, and a signal that aborts when the watch
// stops or the check passes its timeout. A read that waits gives the signal
// to its I/O.
export class Check {
  readonly watchStarted: number;
  readonly now: number;
  readonly signal: AbortSignal;

  constructor(watchStarted: number, now: number, signal: AbortSignal) {
    this.watchStarted = watchStarted;
    this.now = now;
    this.signal = signal;
  }
}
