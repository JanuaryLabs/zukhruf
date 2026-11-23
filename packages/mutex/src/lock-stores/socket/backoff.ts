import { Backoff } from '@zukhruf/async';

/**
 * The back-off of a socket store: etcd's first retry of 25 ms, gRPC's
 * multiplier of 1.6 and jitter of ±20 %, at most 1000 ms (election ADR 0007).
 * A process waits its steps while the server of a new leader is not reachable
 * yet, and a new leader checks the presence of each recovering session at
 * its steps (ADR 0031, ADR 0033).
 */
export const backoff = new Backoff({
  initial: 25,
  multiplier: 1.6,
  max: 1000,
  jitter: { kind: 'ratio', ratio: 0.2 },
});
