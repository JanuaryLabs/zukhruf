/**
 * Every use of the internals of ssh2 1.17.0 by the server. ssh2 is pinned
 * exactly; re-check each line below on a version bump.
 *
 * Why: ssh2 expects a session request to be answered inside its event. Its
 * accept and reject do nothing after a client EOF (`session._ending`) or once
 * `session._channel` exists (lib/server.js:847, :856, :919, :943), and data
 * that comes before `session._channel` exists is dropped (lib/server.js:737-747,
 * :1026-1027). ServerSession.requests() answers later, so this module opens
 * the channel of an exec or shell at once, keeps its data, and sends the reply
 * when the caller decides.
 *
 * - lib/server.js:188-212: Session, `_chanInfo.outgoing.{id,state}`, `_channel`.
 * - lib/server.js:916-965: what accept of shell and exec does: a
 *   `new Channel(connection, session._chanInfo, { server: true })`, its
 *   `subtype`, and `session._channel`.
 * - lib/server.js:236-255: the keepalive timer that a 'ready' listener starts.
 * - lib/Channel.js:86, :289: the Channel class and its export.
 * - lib/Channel.js:142-143, :268-273: the end of a server channel sends EOF
 *   and CLOSE at once (onFinish), so the peer cannot answer after it; this
 *   module makes it a half-close.
 * - lib/Channel.js:248-266: exit() sends only while `outgoing.state` is
 *   'open', so not after EOF; this module sends exit-status itself.
 * - lib/protocol/Protocol.js:393-419: channelSuccess(id), channelFailure(id);
 *   :1675, :1699: exitStatus(id, status), exitSignal(id, name, coreDumped,
 *   message), which refuses a name outside RFC 4254 §6.10 (:1714).
 * - `connection._protocol`: the Protocol object of a server connection
 *   (lib/server.js:263).
 */
import { createRequire } from 'node:module';

import type { Connection, ServerChannel, Session } from 'ssh2';

interface ChannelEnd {
  readonly id: number;
  readonly state: 'open' | 'eof' | 'closing' | 'closed';
}

interface ChannelInfo {
  readonly outgoing: ChannelEnd;
}

interface Protocol {
  channelSuccess(id: number): void;
  channelFailure(id: number): void;
  exitStatus(id: number, status: number): void;
  exitSignal(
    id: number,
    name: string,
    coreDumped: boolean,
    message: string,
  ): void;
}

declare module 'ssh2' {
  interface Session {
    readonly _chanInfo: ChannelInfo;
    _channel: ServerChannel | undefined;
  }
  interface Connection {
    readonly _protocol: Protocol;
  }
}

type ChannelClass = new (
  connection: Connection,
  info: ChannelInfo,
  options: { readonly server: true },
) => ServerChannel;

function isChannelModule(value: unknown): value is { Channel: ChannelClass } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'Channel' in value &&
    typeof value.Channel === 'function'
  );
}

const channelModule: unknown = createRequire(import.meta.url)(
  'ssh2/lib/Channel.js',
);
if (!isChannelModule(channelModule)) {
  throw new Error('ssh: ssh2/lib/Channel.js exports no Channel class');
}
const { Channel } = channelModule;

/**
 * Sends the replies of the requests of one session channel in the order of the
 * requests (RFC 4254 §5.4), whatever order the caller answers them in.
 */
export class SessionReplies {
  readonly #connection: Connection;
  readonly #session: Session;
  readonly #pending: { success?: boolean }[] = [];

  constructor(connection: Connection, session: Session) {
    this.#connection = connection;
    this.#session = session;
  }

  /** A slot for one request; its first call sends the reply. A request with no reply wanted gets a slot that sends nothing. */
  reserve(wantReply: boolean): (success: boolean) => void {
    if (!wantReply) return () => {};
    const slot: { success?: boolean } = {};
    this.#pending.push(slot);
    return (success) => {
      if (slot.success !== undefined) return;
      slot.success = success;
      this.#flush();
    };
  }

  #flush(): void {
    const protocol = this.#connection._protocol;
    const { id, state } = this.#session._chanInfo.outgoing;
    while (this.#pending[0]?.success !== undefined) {
      const slot = this.#pending.shift();
      if (state === 'closing' || state === 'closed') continue;
      if (slot?.success) protocol.channelSuccess(id);
      else protocol.channelFailure(id);
    }
  }
}

/** The channel of an exec or shell request, opened before the reply so that no data is lost. undefined when the session already has one. */
export function openCommandChannel(
  connection: Connection,
  session: Session,
): ServerChannel | undefined {
  if (session._channel !== undefined) return undefined;
  const channel = new Channel(connection, session._chanInfo, {
    server: true,
  });
  session._channel = channel;
  return channel;
}

/** After a refused exec or shell, the session can take another. */
export function dropCommandChannel(session: Session): void {
  session._channel = undefined;
}

/** exit-status or exit-signal, also after EOF (RFC 4254 §6.10 allows it), then SSH_MSG_CHANNEL_CLOSE. */
export function exitCommandChannel(
  connection: Connection,
  session: Session,
  channel: ServerChannel,
  status:
    | number
    | {
        readonly signal: string;
        readonly coreDumped: boolean;
        readonly errorMessage: string;
      },
): void {
  const { id, state } = session._chanInfo.outgoing;
  if (state === 'open' || state === 'eof') {
    if (typeof status === 'number') {
      connection._protocol.exitStatus(id, status);
    } else {
      connection._protocol.exitSignal(
        id,
        status.signal,
        status.coreDumped,
        status.errorMessage,
      );
    }
  }
  channel.close();
}

/**
 * The end of the channel sends only EOF, as a half-close (RFC 4254 §5.3);
 * CLOSE follows once the peer sent EOF too. ssh2 sends both at the end.
 */
export function halfClosing(channel: ServerChannel): ServerChannel {
  channel.removeAllListeners('finish');
  channel.removeAllListeners('prefinish');
  const ended = { reading: false, writing: false };
  const closeWhenBothEnded = (): void => {
    if (ended.reading && ended.writing) channel.close();
  };
  channel.once('finish', () => {
    channel.eof();
    ended.writing = true;
    closeWhenBothEnded();
  });
  channel.once('end', () => {
    ended.reading = true;
    closeWhenBothEnded();
  });
  return channel;
}

/** ssh2 starts a keepalive timer at 'ready'; the server has no timer (ADR 0011). */
export function removeKeepalive(connection: Connection): void {
  connection.removeAllListeners('ready');
}
