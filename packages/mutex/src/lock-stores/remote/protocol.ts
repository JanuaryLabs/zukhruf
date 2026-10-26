import { FencingToken } from '@zukhruf/fencing';

import { isRecord } from '../../shared/is-record.ts';

/** Tokens travel as decimal strings because JSON has no bigint. */
export type LockRequest =
  | { op: 'acquire'; id: string; key: string }
  | { op: 'try'; id: string; key: string }
  | { op: 'isHeld'; id: string; key: string }
  | { op: 'cancel'; id: string }
  | { op: 'release'; id: string }
  | { op: 'reassert'; id: string; key: string; token: string };

export type LockResponse =
  | { op: 'granted'; id: string; token: string }
  | { op: 'busy'; id: string }
  | { op: 'rejected'; id: string }
  | { op: 'held'; id: string; held: boolean }
  /** The coordinator could not mint a token for an acquire or a try, so nothing is held. Sent only on IPC channels and worker ports (ADR 0019). */
  | { op: 'failed'; id: string; message: string };

const isToken = (value: unknown): boolean =>
  typeof value === 'string' && FencingToken.parse(value) !== null;

/** Messages arrive from another thread or process, so their shape is checked before use. */
export function isLockRequest(message: unknown): message is LockRequest {
  if (!isRecord(message) || typeof message.id !== 'string') return false;
  switch (message.op) {
    case 'acquire':
    case 'try':
    case 'isHeld':
      return typeof message.key === 'string';
    case 'cancel':
    case 'release':
      return true;
    case 'reassert':
      return typeof message.key === 'string' && isToken(message.token);
    default:
      return false;
  }
}

export function isLockResponse(message: unknown): message is LockResponse {
  if (!isRecord(message) || typeof message.id !== 'string') return false;
  switch (message.op) {
    case 'granted':
      return isToken(message.token);
    case 'held':
      return typeof message.held === 'boolean';
    case 'failed':
      return typeof message.message === 'string';
    case 'busy':
    case 'rejected':
      return true;
    default:
      return false;
  }
}
