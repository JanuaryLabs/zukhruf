import { isRecord } from '../../shared/is-record.ts';

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

const isToken = (value: unknown): boolean =>
  typeof value === 'string' && /^-?\d+$/.test(value);

/** Messages arrive from another thread or process, so their shape is checked before use. */
export function isLockRequest(message: unknown): message is LockRequest {
  if (!isRecord(message) || typeof message.id !== 'string') return false;
  switch (message.op) {
    case 'acquire':
    case 'try':
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
    case 'busy':
    case 'rejected':
      return true;
    default:
      return false;
  }
}
