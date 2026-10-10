import { EventEmitter, addAbortListener } from 'node:events';

import type {
  Connection,
  ConnectionEvents,
} from '../lock-stores/remote/connection.ts';

/** One end of a connection whose peer is driven by the test. */
export function scriptedPeer<Outgoing, Incoming>(
  onSend: (message: Outgoing) => Promise<void> = async () => {},
) {
  const sent: Outgoing[] = [];
  const refs: ('ref' | 'unref')[] = [];
  let closes = 0;
  const connection: Connection<Outgoing> = Object.assign(
    new EventEmitter<ConnectionEvents>(),
    {
      async send(message: Outgoing) {
        sent.push(message);
        await onSend(message);
      },
      ref() {
        refs.push('ref');
      },
      unref() {
        refs.push('unref');
      },
      close() {
        closes++;
      },
    },
  );
  return {
    connection,
    sent,
    refs,
    get closes() {
      return closes;
    },
    deliver: (message: Incoming) => connection.emit('message', message),
    drop: () => connection.emit('close'),
  };
}

interface ConnectCall<Outgoing> {
  signal: AbortSignal;
  resolve(connection: Connection<Outgoing> | undefined): void;
  reject(error: unknown): void;
}

/** A connector whose every `connect` waits until the test settles it, or rejects once aborted. */
export function scriptedConnector<Outgoing>() {
  const calls: ConnectCall<Outgoing>[] = [];
  return {
    connector: {
      connect(signal: AbortSignal) {
        const { promise, resolve, reject } = Promise.withResolvers<
          Connection<Outgoing> | undefined
        >();
        // Fires for a signal that already aborted, and for an abort event that an earlier listener stopped.
        addAbortListener(signal, () => reject(signal.reason));
        calls.push({ signal, resolve, reject });
        return promise;
      },
    },
    calls,
  };
}
