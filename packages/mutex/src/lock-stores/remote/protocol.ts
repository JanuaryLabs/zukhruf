/** Tokens travel as decimal strings because JSON has no bigint. */
export type LockRequest =
  | { op: 'acquire'; id: string; key: string }
  | { op: 'try'; id: string; key: string }
  | { op: 'cancel'; id: string }
  | { op: 'release'; id: string }
  | { op: 'reassert'; id: string; key: string; token: string };

export type LockResponse =
  | { op: 'granted'; id: string; token: string }
  | { op: 'busy'; id: string }
  | { op: 'rejected'; id: string };
