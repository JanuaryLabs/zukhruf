import { SkipIfBusyMode, type SkipIfBusyOptions } from './skip-if-busy-mode.ts';
import { WaitMode } from './wait-mode.ts';

export const Modes = {
  /** Wait until the key is granted. The task always runs. */
  wait: () => new WaitMode(),
  /** Give up when the key stays busy, at once or after `waitAtMost` ms. The task may not run. */
  skipIfBusy: (options?: SkipIfBusyOptions) => new SkipIfBusyMode(options),
};
