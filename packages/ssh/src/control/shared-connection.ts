import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { unlinkSync } from 'node:fs';
import { link, unlink } from 'node:fs/promises';
import { type Server, type Socket, createServer } from 'node:net';
import type { Duplex } from 'node:stream';

import { type Clock, timeout } from '@zukhruf/async';

import { type Client, openClientSession } from '../client.ts';
import { isErrno } from '../errno.ts';
import {
  type Session,
  type SessionChannel,
  type SessionStart,
  createSession,
} from '../session.ts';
import {
  NoHelloError,
  dialStream,
  greet,
  sendRequest,
  sessionChannel,
} from './control-client.ts';
import { serveConnection } from './control-master.ts';
import type { Request } from './messages.ts';

/**
 * One SSH connection to a host that the processes of the user share, as
 * OpenSSH's ControlMaster and ControlPath share one (ssh_config(5)). It has
 * the two calls of Client that open a channel. A new one keeps the process
 * alive until unref(), as a Client does. close() ends this process's use:
 * the connection closes once no process uses it.
 */
export interface SharedConnection extends AsyncDisposable {
  dial(network: 'tcp' | 'unix', address: string): Promise<Duplex>;
  newSession(): Session;
  ref(): void;
  unref(): void;
  close(): Promise<void>;
}

/**
 * ControlMaster and ControlPath of a resolved config. ssh -G prints
 * ControlMaster as false, true, auto, ask or autoask, and no controlpath for
 * ControlPath none, which turns sharing off whatever ControlMaster says.
 */
export type Sharing =
  | { readonly kind: 'off' }
  | { readonly kind: 'join' | 'master' | 'auto'; readonly path: string }
  | { readonly kind: 'confirm'; readonly setting: 'ask' | 'autoask' };

/**
 * Shares the connection that `dial` makes, by OpenSSH's election (muxclient
 * and muxserver_listen in mux.c): join the master at the socket; with
 * nothing there, or a socket that refuses (stale, which auto removes), dial
 * and become the master; when another master took the socket first, keep a
 * connection of its own. A connection that joined runs the election again
 * for its next channel once its master went away, as the next ssh does. The
 * socket is ControlPath with `.zukhruf` after it: the package's protocol is
 * not OpenSSH's (control ADR), so it never takes the socket of an OpenSSH
 * master.
 */
export async function shareConnection(
  sharing: Sharing,
  options: Electing,
): Promise<SharedConnection> {
  switch (sharing.kind) {
    case 'off':
      return new PlainConnection(await options.dial(options.signal));
    case 'confirm':
      throw new Error(
        `ssh: ControlMaster ${sharing.setting} is not supported: it confirms each use of the master through ssh-askpass`,
      );
    case 'join':
      return ElectedConnection.elect(
        socketOf(sharing.path),
        joinOrDial,
        options,
      );
    case 'master':
      return MasterConnection.listen(
        socketOf(sharing.path),
        await options.dial(options.signal),
      );
    case 'auto':
      return ElectedConnection.elect(
        socketOf(sharing.path),
        joinOrHost,
        options,
      );
  }
}

/** What a join waits on: the caller's signal, and ConnectTimeout (ms) for the hello, as OpenSSH's mux_client_hello_exchange; none waits as long as the master takes. */
interface Joining {
  readonly clock: Clock;
  readonly signal: AbortSignal | undefined;
  readonly connectTimeout: number | undefined;
}

/** What an election takes: a join's waits, and how to connect, with the signal of the election. */
interface Electing extends Joining {
  readonly dial: (signal: AbortSignal | undefined) => Promise<Client>;
}

/** What this process became in an election. */
type Elected =
  | { readonly kind: 'joined'; readonly hold: Socket }
  | { readonly kind: 'hosting'; readonly master: MasterConnection }
  | { readonly kind: 'alone'; readonly client: Client };

type Election = (socket: string, options: Electing) => Promise<Elected>;

/** ControlMaster auto: join the master, or become it. */
async function joinOrHost(socket: string, options: Electing): Promise<Elected> {
  const hold = await holdMaster(socket, options);
  if (typeof hold !== 'string') return { kind: 'joined', hold };
  if (hold === 'stale') await removeStale(socket);
  const client = await options.dial(options.signal);
  const master = await MasterConnection.host(socket, client);
  return master === 'taken'
    ? { kind: 'alone', client }
    : { kind: 'hosting', master };
}

/** ControlMaster no: join the master, or connect alone. It removes no stale socket, as OpenSSH's muxclient. */
async function joinOrDial(socket: string, options: Electing): Promise<Elected> {
  const hold = await holdMaster(socket, options);
  return typeof hold === 'string'
    ? { kind: 'alone', client: await options.dial(options.signal) }
    : { kind: 'joined', hold };
}

function socketOf(controlPath: string): string {
  return `${controlPath}.zukhruf`;
}

// Another process that found it stale may have removed it first.
async function removeStale(socket: string): Promise<void> {
  try {
    await unlink(socket);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
}

/**
 * Holds the master at the socket: the hold, or 'none' with no master there
 * (also a peer that sends no hello within ConnectTimeout), or 'stale' for a
 * socket that refuses connections.
 */
async function holdMaster(
  socket: string,
  { clock, signal, connectTimeout }: Joining,
): Promise<Socket | 'none' | 'stale'> {
  using limit =
    connectTimeout === undefined
      ? undefined
      : timeout(connectTimeout, { clock });
  const signals = [signal, limit?.signal].filter((each) => each !== undefined);
  let hold: Socket;
  try {
    hold = await greet(socket, AbortSignal.any(signals));
  } catch (error) {
    signal?.throwIfAborted();
    if (
      isErrno(error, 'ENOENT') ||
      error instanceof NoHelloError ||
      limit?.signal.aborted === true
    ) {
      return 'none';
    }
    if (isErrno(error, 'ECONNREFUSED')) return 'stale';
    throw error;
  }
  await sendRequest(hold, { kind: 'hold' });
  // sendRequest paused it: it reads on to see the master's close.
  hold.resume();
  return hold;
}

/** A connection of this process alone: no master, or another took the socket. */
class PlainConnection implements SharedConnection {
  readonly #client: Client;

  constructor(client: Client) {
    this.#client = client;
  }

  dial(network: 'tcp' | 'unix', address: string): Promise<Duplex> {
    return this.#client.dial(network, address);
  }

  newSession(): Session {
    return this.#client.newSession();
  }

  ref(): void {
    this.#client.ref();
  }

  unref(): void {
    this.#client.unref();
  }

  close(): Promise<void> {
    return this.#client.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

/** What a master does at a close of this process's use, and when a connection that it serves ends. */
interface MasterState {
  close(): Promise<void>;
  served(): void;
}

/**
 * The connection of this process, served to the others on the socket. Each
 * connection that it serves (a hold or a channel) keeps the process alive,
 * as each mux client keeps OpenSSH's master (channel_still_open counts
 * SSH_CHANNEL_MUX_CLIENT); the listener does not. After close() it serves
 * until its last connection ends, then removes the socket and closes the
 * connection.
 */
class MasterConnection implements SharedConnection {
  readonly #socket: string;
  readonly #client: Client;
  readonly #server: Server;
  readonly #served = new Set<Socket>();
  #state: MasterState = this.#serving();

  private constructor(socket: string, client: Client, server: Server) {
    this.#socket = socket;
    this.#client = client;
    this.#server = server;
  }

  /** The master on the socket, or a connection of this process alone when another process linked the socket first, as OpenSSH's muxserver_listen. */
  static async listen(
    socket: string,
    client: Client,
  ): Promise<SharedConnection> {
    const master = await MasterConnection.host(socket, client);
    return master === 'taken' ? new PlainConnection(client) : master;
  }

  /**
   * Listens on a name of its own and then links the socket to it, so no
   * process connects to a socket that does not listen yet (mux.c). 'taken'
   * when the link finds the socket taken: the client stays the caller's.
   */
  static async host(
    socket: string,
    client: Client,
  ): Promise<MasterConnection | 'taken'> {
    const server = createServer();
    const master = new MasterConnection(socket, client, server);
    server.on('connection', (connection) => master.#serve(connection));
    const temporary = `${socket}.${randomBytes(8).toHex()}`;
    server.listen(temporary);
    await once(server, 'listening');
    server.unref();
    const linked = await link(temporary, socket).then(
      () => undefined,
      (error: unknown) => ({ error }),
    );
    // Before the close of the server, which removes the name that it bound.
    await unlink(temporary);
    if (linked === undefined) return master;
    server.close();
    if (isErrno(linked.error, 'EEXIST')) return 'taken';
    await client.close();
    throw linked.error;
  }

  dial(network: 'tcp' | 'unix', address: string): Promise<Duplex> {
    return this.#client.dial(network, address);
  }

  newSession(): Session {
    return this.#client.newSession();
  }

  /** The channel of a session, as newSession() opens it. */
  openSession(start: SessionStart): Promise<SessionChannel> {
    return openClientSession(this.#client, start);
  }

  ref(): void {
    this.#client.ref();
  }

  unref(): void {
    this.#client.unref();
  }

  close(): Promise<void> {
    return this.#state.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  #serve(connection: Socket): void {
    this.#served.add(connection);
    connection.once('close', () => {
      this.#served.delete(connection);
      this.#state.served();
    });
    serveConnection(this.#client, connection);
  }

  /** This process uses the connection, and serves the others. */
  #serving(): MasterState {
    return {
      // Unref'd, the client would let the process exit before the close that
      // it awaits ends; only the processes that it serves keep it alive after.
      close: async () => {
        this.#state = this.#draining();
        if (this.#served.size === 0) return this.#shutDown();
        this.#client.unref();
      },
      served: () => undefined,
    };
  }

  /** This process closed its use: it serves the others until the last one ends. */
  #draining(): MasterState {
    return {
      close: () => Promise.resolve(),
      served: () => {
        if (this.#served.size === 0) void this.#shutDown();
      },
    };
  }

  // In one turn of the event loop, so no connection comes between the last
  // close and the listener's: one that the kernel queued gets no hello. A
  // cleaner of /tmp can have removed the socket; OpenSSH's unlink at exit
  // ignores its error too (ssh.c).
  #shutDown(): Promise<void> {
    try {
      unlinkSync(this.#socket);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
    this.#server.close();
    return this.#client.close();
  }
}

/** How an elected connection reaches the host now: through the master of another process, as the master, or alone. */
interface Role {
  dial(network: 'tcp' | 'unix', address: string): Promise<Duplex>;
  openSession(start: SessionStart): Promise<SessionChannel>;
  ref(): void;
  unref(): void;
  close(): Promise<void>;
}

/** Whether the caller holds the connection ref'd, for the role that a later election gives. */
interface Holding {
  apply(role: Role): void;
}
const held: Holding = { apply: (role) => role.ref() };
const released: Holding = { apply: (role) => role.unref() };

function alone(client: Client): Role {
  return {
    dial: (network, address) => client.dial(network, address),
    openSession: (start) => openClientSession(client, start),
    ref: () => client.ref(),
    unref: () => client.unref(),
    close: () => client.close(),
  };
}

/**
 * The connection of an election, under ControlMaster auto or no: it holds the
 * master of another process, or this process is the master, or it has a
 * connection of its own. A hold keeps the master serving until it closes,
 * and keeps this process alive while ref'd; the channels through the master
 * never keep the process alive by themselves. When the master that it holds
 * goes away (its process ended, crashed or was killed), it runs the election
 * again: at once while ref'd, so that it keeps the process alive as the hold
 * did, and otherwise at its next channel, as the next ssh does. Only the
 * channels in flight at the loss fail (#4875).
 */
class ElectedConnection implements SharedConnection {
  readonly #socket: string;
  readonly #election: () => Promise<Elected>;
  #holding: Holding = held;
  #role: Role;

  private constructor(
    socket: string,
    election: () => Promise<Elected>,
    first: Elected,
  ) {
    this.#socket = socket;
    this.#election = election;
    this.#role = this.#roleOf(first);
  }

  /** The signal of share() bounds only the first election. */
  static async elect(
    socket: string,
    election: Election,
    options: Electing,
  ): Promise<ElectedConnection> {
    const later = { ...options, signal: undefined };
    return new ElectedConnection(
      socket,
      () => election(socket, later),
      await election(socket, options),
    );
  }

  dial(network: 'tcp' | 'unix', address: string): Promise<Duplex> {
    return this.#role.dial(network, address);
  }

  newSession(): Session {
    return createSession((start) => this.#role.openSession(start));
  }

  ref(): void {
    this.#holding = held;
    this.#role.ref();
  }

  unref(): void {
    this.#holding = released;
    this.#role.unref();
  }

  close(): Promise<void> {
    return this.#role.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  #roleOf(elected: Elected): Role {
    switch (elected.kind) {
      case 'joined':
        return this.#joined(elected.hold);
      case 'hosting':
        return elected.master;
      case 'alone':
        return alone(elected.client);
    }
  }

  /** Through the master that `hold` holds. The close of the hold by the master is the loss of the master, and so is a socket that refuses a channel. */
  #joined(hold: Socket): Role {
    const role: Role = {
      dial: async (network, address) => {
        const channel = await this.#through(role, {
          kind: 'dial',
          network,
          address,
        });
        return channel === 'lost'
          ? this.#role.dial(network, address)
          : dialStream(channel);
      },
      openSession: async (start) => {
        const channel = await this.#through(role, { kind: 'session', start });
        return channel === 'lost'
          ? this.#role.openSession(start)
          : sessionChannel(channel);
      },
      ref: () => hold.ref(),
      unref: () => hold.unref(),
      close: async () => {
        if (hold.destroyed) return;
        hold.off('close', lose);
        const closed = once(hold, 'close');
        hold.destroy();
        await closed;
      },
    };
    const lose = (): void => this.#lose(role);
    hold.once('close', lose);
    return role;
  }

  /** The channel through the master, or 'lost' when no master answers at the socket. */
  async #through(role: Role, request: Request): Promise<Socket | 'lost'> {
    let socket: Socket;
    try {
      socket = await greet(this.#socket);
    } catch (error) {
      if (
        !isErrno(error, 'ENOENT') &&
        !isErrno(error, 'ECONNREFUSED') &&
        !(error instanceof NoHelloError)
      ) {
        throw error;
      }
      this.#lose(role);
      return 'lost';
    }
    return (await sendRequest(socket, request)).unref();
  }

  #lose(role: Role): void {
    if (this.#role !== role) return;
    this.#role = this.#lost();
    this.#holding.apply(this.#role);
    void role.close();
  }

  /** The master went away: ref() and the next channel elect, once for both; a failed election leaves the next of them to elect again. */
  #lost(): Role {
    let elected: Promise<Role> | undefined;
    const elect = (): Promise<Role> =>
      (elected ??= this.#election().then(
        (next) => {
          const role = this.#roleOf(next);
          this.#holding.apply(role);
          this.#role = role;
          return role;
        },
        (error: unknown) => {
          elected = undefined;
          throw error;
        },
      ));
    return {
      dial: async (network, address) => (await elect()).dial(network, address),
      openSession: async (start) => (await elect()).openSession(start),
      // Its connection keeps the process alive, as the hold did. An election
      // that fails here rejects the channels that wait for it (ADR 0013), and
      // leaves the next channel to elect. Nobody waits for this call, so its
      // failure is a process warning.
      ref: () =>
        void elect().catch((error: unknown) => {
          process.emitWarning(
            Object.assign(
              new Error(
                `The election of a ref'd shared connection failed, and its next channel elects again: ${Error.isError(error) ? error.message : String(error)}`,
                { cause: error },
              ),
              {
                name: 'SharedConnectionWarning',
                code: 'ZUKHRUF_SSH_SHARED_CONNECTION_ELECTION_FAILED',
                detail: `socket: ${this.#socket}`,
              },
            ),
          );
        }),
      unref: () => undefined,
      close: async () => {
        const role = await elected?.catch(() => undefined);
        await role?.close();
      },
    };
  }
}
