export { Mutex } from './mutex/mutex.ts';
export { Key } from './mutex/key.ts';
export { leaseFor, type LockHandle } from './mutex/lease.ts';
export type { AcquireOptions, LockStore } from './mutex/lock-store.ts';
export { LeaseLostError } from '@zukhruf/lease';
export type {
  Acquired,
  AcquireMode,
  ModeResult,
  NotAcquired,
  Outcome,
  OutcomeResults,
} from './mutex/acquire-mode.ts';
export { Modes } from './mutex/acquire-modes/modes.ts';
export { WaitMode } from './mutex/acquire-modes/wait-mode.ts';
export {
  SkipIfBusyMode,
  type SkipIfBusyOptions,
} from './mutex/acquire-modes/skip-if-busy-mode.ts';
