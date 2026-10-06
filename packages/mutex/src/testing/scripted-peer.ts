import type {
  Connection,
  ConnectionHandlers,
} from '../lock-stores/remote/connection.ts';

/** One end of a connection whose peer is driven by the test. */
export function scriptedPeer<Outgoing, Incoming>(
  onSend: (message: Outgoing) => Promise<void> = async () => {},
) {
  const sent: Outgoing[] = [];
  const refs: ('ref' | 'unref')[] = [];
  let handlers: ConnectionHandlers<Incoming> | undefined;
  let closes = 0;
  const connection: Connection<Outgoing, Incoming> = {
    async send(message) {
      sent.push(message);
      await onSend(message);
    },
    listen(listeners) {
      handlers = listeners;
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
  };
  return {
    connection,
    sent,
    refs,
    get closes() {
      return closes;
    },
    deliver: (message: Incoming) => handlers?.message(message),
    drop: () => handlers?.close(),
  };
}

interface ConnectCall<Outgoing, Incoming> {
  signal: AbortSignal;
  resolve(connection: Connection<Outgoing, Incoming> | undefined): void;
  reject(error: unknown): void;
}

/** A connector whose every `connect` waits until the test settles it, or rejects once aborted. */
export function scriptedConnector<Outgoing, Incoming>() {
  const calls: ConnectCall<Outgoing, Incoming>[] = [];
  return {
    connector: {
      connect(signal: AbortSignal) {
        const { promise, resolve, reject } = Promise.withResolvers<
          Connection<Outgoing, Incoming> | undefined
        >();
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
        calls.push({ signal, resolve, reject });
        return promise;
      },
    },
    calls,
  };
}
