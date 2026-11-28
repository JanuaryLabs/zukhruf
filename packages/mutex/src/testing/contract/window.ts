import type { Subject } from './subject.ts';

/**
 * A window in which a wrong grant would show: `base`, plus the usual time of
 * one grant of `store`. Load only makes the window longer.
 */
export const windowFor = (
  store: Pick<Subject, 'grantLatency'>,
  base: number,
): number => base + store.grantLatency;

/**
 * The rounds of a test that repeats one try: `most`, or as many as about 2 s
 * of grants at the usual grant time of `store`, and never fewer than 6. A
 * store whose grant is slow (a container for each claim) still tries 6
 * times; a fast store keeps `most`.
 */
export const roundsFor = (
  store: Pick<Subject, 'grantLatency'>,
  most: number,
): number =>
  Math.min(most, Math.max(6, Math.round(2_000 / store.grantLatency)));
