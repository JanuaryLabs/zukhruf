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
 * - lib/protocol/Protocol.js:1699-1750: the packet of exitSignal, which this
 *   module writes itself to send a name such as SIG@openssh.com, through
 *   `_packetRW.write.{allocStart,alloc,finalize}` and utils.js:343
 *   `sendPacket`.
 * - lib/protocol/handlers.js:3-16: the shared table of message handlers;
 *   handlers.misc.js:1001-1241: its CHANNEL_REQUEST handler drops a whole
 *   pty-req at a terminal mode that constants.js:252 does not name, such as
 *   IUTF8 (handlers.misc.js:1097-1116), then calls
 *   `protocol._handlers.CHANNEL_REQUEST(protocol, recipient, type, wantReply,
 *   data)`. This module parses a pty-req of a ServerConn itself, before that
 *   handler.
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
  readonly _packetRW: {
    readonly write: {
      readonly allocStart: number;
      alloc(length: number): Buffer;
      finalize(packet: Buffer): Buffer;
    };
  };
  readonly _handlers: {
    readonly CHANNEL_REQUEST?: (
      protocol: Protocol,
      recipient: number,
      type: string,
      wantReply: boolean,
      data: unknown,
    ) => void;
  };
}

type MessageHandler = (protocol: Protocol, payload: Buffer) => unknown;

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

const load = createRequire(import.meta.url);

const channelModule: unknown = load('ssh2/lib/Channel.js');
if (!isChannelModule(channelModule)) {
  throw new Error('ssh: ssh2/lib/Channel.js exports no Channel class');
}
const { Channel } = channelModule;

const utilities: unknown = load('ssh2/lib/protocol/utils.js');
if (
  typeof utilities !== 'object' ||
  utilities === null ||
  !('sendPacket' in utilities) ||
  typeof utilities.sendPacket !== 'function'
) {
  throw new Error('ssh: ssh2/lib/protocol/utils.js exports no sendPacket');
}
const { sendPacket } = utilities;

const constants: unknown = load('ssh2/lib/protocol/constants.js');
if (
  typeof constants !== 'object' ||
  constants === null ||
  !('TERMINAL_MODE' in constants) ||
  typeof constants.TERMINAL_MODE !== 'object' ||
  constants.TERMINAL_MODE === null
) {
  throw new Error('ssh: ssh2/lib/protocol/constants.js has no TERMINAL_MODE');
}

const channelRequest = 98;
const ttyOpEnd = 0;
/** RFC 4254 §8: opcodes 160 to 255 are not defined, and end the parsing. */
const firstUndefinedOpcode = 160;
/** The names of the terminal modes by opcode: ssh2's table of RFC 4254 §8, and IUTF8 of RFC 8160. */
const modeNames = new Map<number, string>([
  ...Object.entries(constants.TERMINAL_MODE).flatMap(
    ([name, opcode]): [number, string][] =>
      typeof opcode === 'number' && opcode !== ttyOpEnd ? [[opcode, name]] : [],
  ),
  [42, 'IUTF8'],
]);

const messageHandlers: unknown = load('ssh2/lib/protocol/handlers.js');
if (!isHandlerTable(messageHandlers)) {
  throw new Error('ssh: ssh2/lib/protocol/handlers.js is not a handler table');
}
const ssh2ChannelRequest = messageHandlers[channelRequest];
if (ssh2ChannelRequest === undefined) {
  throw new Error('ssh: ssh2 has no CHANNEL_REQUEST handler');
}
const ownProtocols = new WeakSet<Protocol>();
messageHandlers[channelRequest] = (protocol, payload) => {
  if (ownProtocols.has(protocol)) {
    const pty = parsePtyRequest(payload);
    if (pty !== undefined) {
      protocol._handlers.CHANNEL_REQUEST?.(
        protocol,
        pty.recipient,
        'pty-req',
        pty.wantReply,
        pty.info,
      );
      return undefined;
    }
  }
  return ssh2ChannelRequest(protocol, payload);
};

function isHandlerTable(
  value: unknown,
): value is (MessageHandler | undefined)[] {
  return Array.isArray(value) && typeof value[channelRequest] === 'function';
}

/** Reads the fields of RFC 4251 §5 from a payload; undefined once a field runs past its end. */
class PayloadReader {
  readonly #payload: Buffer;
  #offset: number;

  constructor(payload: Buffer, offset: number) {
    this.#payload = payload;
    this.#offset = offset;
  }

  get done(): boolean {
    return this.#offset >= this.#payload.length;
  }

  byte(): number | undefined {
    const value = this.#payload[this.#offset];
    this.#offset += 1;
    return value;
  }

  uint32(): number | undefined {
    const start = this.#offset;
    if (start + 4 > this.#payload.length) return undefined;
    this.#offset += 4;
    return this.#payload.readUInt32BE(start);
  }

  bytes(): Buffer | undefined {
    const length = this.uint32();
    const start = this.#offset;
    if (length === undefined || start + length > this.#payload.length) {
      return undefined;
    }
    this.#offset += length;
    return this.#payload.subarray(start, start + length);
  }
}

/** A pty-req (RFC 4254 §6.2), with the modes that have a name; undefined for another request, or a malformed one, which ssh2 then handles. */
function parsePtyRequest(payload: Buffer):
  | {
      readonly recipient: number;
      readonly wantReply: boolean;
      readonly info: {
        readonly term: string;
        readonly cols: number;
        readonly rows: number;
        readonly width: number;
        readonly height: number;
        readonly modes: Readonly<Record<string, number>>;
      };
    }
  | undefined {
  const reader = new PayloadReader(payload, 1);
  const recipient = reader.uint32();
  if (reader.bytes()?.toString('latin1') !== 'pty-req') return undefined;
  const wantReply = reader.byte();
  const term = reader.bytes()?.toString('utf8');
  const cols = reader.uint32();
  const rows = reader.uint32();
  const width = reader.uint32();
  const height = reader.uint32();
  const encodedModes = reader.bytes();
  if (
    recipient === undefined ||
    wantReply === undefined ||
    term === undefined ||
    cols === undefined ||
    rows === undefined ||
    width === undefined ||
    height === undefined ||
    encodedModes === undefined
  ) {
    return undefined;
  }
  return {
    recipient,
    wantReply: wantReply !== 0,
    info: { term, cols, rows, width, height, modes: parseModes(encodedModes) },
  };
}

/** RFC 4254 §8: an opcode and a uint32 value each, up to TTY_OP_END or an opcode of 160 or more. A mode with no name is skipped. */
function parseModes(encoded: Buffer): Readonly<Record<string, number>> {
  const reader = new PayloadReader(encoded, 0);
  const modes: [string, number][] = [];
  while (!reader.done) {
    const opcode = reader.byte();
    if (
      opcode === undefined ||
      opcode === ttyOpEnd ||
      opcode >= firstUndefinedOpcode
    ) {
      break;
    }
    const value = reader.uint32();
    if (value === undefined) break;
    const name = modeNames.get(opcode);
    if (name !== undefined) modes.push([name, value]);
  }
  return Object.fromEntries(modes);
}

/** Makes ssh2 give each pty-req of this connection with its modes, also one with a mode that ssh2 does not name. */
export function parseTerminalModes(connection: Connection): void {
  ownProtocols.add(connection._protocol);
}

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
      sendExitSignal(connection._protocol, id, status);
    }
  }
  channel.close();
}

/**
 * RFC 4254 §6.10 exit-signal, as ssh2's Protocol.exitSignal writes it, with
 * any name: ssh2 refuses a name outside the list of RFC 4254, such as
 * SIG@openssh.com, which OpenSSH's sshd sends.
 */
function sendExitSignal(
  protocol: Protocol,
  id: number,
  status: {
    readonly signal: string;
    readonly coreDumped: boolean;
    readonly errorMessage: string;
  },
): void {
  const fields = [
    uint32(id),
    sshString(Buffer.from('exit-signal', 'latin1')),
    Buffer.of(0),
    sshString(Buffer.from(status.signal, 'latin1')),
    Buffer.of(status.coreDumped ? 1 : 0),
    sshString(Buffer.from(status.errorMessage, 'utf8')),
    sshString(Buffer.alloc(0)),
  ];
  const body = Buffer.concat([Buffer.of(channelRequest), ...fields]);
  const writer = protocol._packetRW.write;
  const packet = writer.alloc(body.length);
  body.copy(packet, writer.allocStart);
  Reflect.apply(sendPacket, undefined, [protocol, writer.finalize(packet)]);
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function sshString(value: Buffer): Buffer {
  return Buffer.concat([uint32(value.length), value]);
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
