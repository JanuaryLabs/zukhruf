import type { Subject } from './subject.ts';

/**
 * A window in which a wrong grant would show: `base`, plus the usual time of
 * one grant of `store`. Load only makes the window longer.
 */
export const windowFor = (
  store: Pick<Subject, 'grantLatency'>,
  base: number,
): number => base + store.grantLatency;
