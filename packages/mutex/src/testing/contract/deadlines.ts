import type { Subject } from './subject.ts';

/**
 * The deadline of a step that makes `cost.grants` grants and waits for
 * `cost.releases` releases of a closed holder: `limit` for a fast store, plus
 * the `grantLatency` of each grant and the `releaseLatency` of each release.
 */
export const deadlineFor = (
  store: Pick<Subject, 'grantLatency' | 'releaseLatency'>,
  limit: number,
  cost: { grants: number; releases: number },
): number =>
  limit +
  cost.grants * store.grantLatency +
  cost.releases * store.releaseLatency;
