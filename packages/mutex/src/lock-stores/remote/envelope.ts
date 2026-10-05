import { isRecord } from '../../shared/is-record.ts';

const TAG = '@lock';

/** Lock messages travel inside a tagged envelope so they share the IPC channel with the application's own messages. */
export function wrap<T>(message: T): Record<typeof TAG, T> {
  return { [TAG]: message };
}

/** The message inside a lock envelope, unchecked; `undefined` for the application's own messages. */
export function unwrap(envelope: unknown): unknown {
  return isRecord(envelope) && TAG in envelope ? envelope[TAG] : undefined;
}
