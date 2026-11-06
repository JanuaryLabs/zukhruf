import type { Check } from './check.ts';
import { Gauge } from './gauge.ts';
import { milliseconds } from './milliseconds.ts';

// The count of whole periods since the watch started. It changes one time in
// each period, whatever else changed: a consumer reads again on a schedule,
// for example every hour, also when no other gauge saw a change.
export class Period extends Gauge<number> {
  readonly #ms: number;

  constructor(ms: number) {
    super();
    this.#ms = milliseconds('A period', ms);
  }

  protected async read(check: Check): Promise<number> {
    return Math.floor((check.now - check.watchStarted) / this.#ms);
  }
}
