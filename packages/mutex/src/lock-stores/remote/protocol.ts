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
  /** The coordinator does not know the request: it runs an older version. */
  | { op: 'unsupported'; id: string };

/**
 * The requests added after protocol version 1. A coordinator of 0.3.x closes
 * a connection that sends one, so a leader lists those it answers in its
 * welcome, and a follower sends only those. A request added later goes here
 * and needs no new protocol version.
 */
export const ADDED_OPS: ReadonlySet<string> = new Set<LockRequest['op']>([
  'isHeld',
]);

/** A request whose `op` this process may not know. A coordinator answers one it does not know with `unsupported`. */
export interface RequestEnvelope {
  op: string;
  id: string;
}

const isToken = (value: unknown): boolean =>
  typeof value === 'string' && /^-?\d+$/.test(value);

export function isRequestEnvelope(
  message: unknown,
): message is RequestEnvelope {
  return (
    isRecord(message) &&
    typeof message.op === 'string' &&
    typeof message.id === 'string'
  );
}

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
    case 'busy':
    case 'rejected':
    case 'unsupported':
      return true;
    default:
      return false;
  }
}
