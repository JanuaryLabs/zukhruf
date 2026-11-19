import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { unlinkSync } from 'node:fs';
import { link, unlink } from 'node:fs/promises';
import { type Server, type Socket, createServer } from 'node:net';
import type { Duplex } from 'node:stream';

import { type Clock, timeout } from '@zukhruf/async';

import type { Client } from '../client.ts';
import { isErrno } from '../errno.ts';
import { type Session, createSession } from '../session.ts';
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
 * connection of its own. The socket is ControlPath with `.zukhruf` after it:
 * the package's protocol is not OpenSSH's (control ADR), so it never takes
 * the socket of an OpenSSH master.
 */
export async function shareConnection(
  sharing: Sharing,
  options: Joining & { readonly dial: () => Promise<Client> },
): Promise<SharedConnection> {
  const { dial } = options;
  switch (sharing.kind) {
    case 'off':
      return new PlainConnection(await dial());
    case 'confirm':
      throw new Error(
        `ssh: ControlMaster ${sharing.setting} is not supported: it confirms each use of the master through ssh-askpass`,
      );
    case 'join': {
      const joined = await JoinedConnection.join(
        socketOf(sharing.path),
        options,
      );
      return joined instanceof JoinedConnection
        ? joined
        : new PlainConnection(await dial());
    }
    case 'master':
      return MasterConnection.listen(socketOf(sharing.path), await dial());
    case 'auto': {
      const socket = socketOf(sharing.path);
      const joined = await JoinedConnection.join(socket, options);
      if (joined === 'stale') await removeStale(socket);
      return joined instanceof JoinedConnection
        ? joined
        : MasterConnection.listen(socket, await dial());
    }
  }
}

/** What a join waits on: the caller's signal, and ConnectTimeout (ms) for the hello, as OpenSSH's mux_client_hello_exchange; none waits as long as the master takes. */
interface Joining {
  readonly clock: Clock;
  readonly signal: AbortSignal | undefined;
  readonly connectTimeout: number | undefined;
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

  /**
   * Listens on a name of its own and then links the socket to it, so no
   * process connects to a socket that does not listen yet (mux.c). When the
   * link finds the socket taken, the connection stays this process's own.
   */
  static async listen(
    socket: string,
    client: Client,
  ): Promise<SharedConnection> {
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
    if (isErrno(linked.error, 'EEXIST')) return new PlainConnection(client);
    await client.close();
    throw linked.error;
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
      close: async () => {
        this.#state = this.#draining();
        this.#client.unref();
        if (this.#served.size === 0) await this.#shutDown();
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
  // close and the listener's: one that the kernel queued gets no hello.
  #shutDown(): Promise<void> {
    unlinkSync(this.#socket);
    this.#server.close();
    return this.#client.close();
  }
}

/**
 * The connection of another process, through its master. It holds one
 * connection to the master for its lifetime, so the master serves until it
 * closes; that hold alone keeps this process alive, while ref'd. Its
 * channels never keep the process alive by themselves.
 */
class JoinedConnection implements SharedConnection {
  readonly #socket: string;
  readonly #hold: Socket;

  private constructor(socket: string, hold: Socket) {
    this.#socket = socket;
    this.#hold = hold;
  }

  /** The joined connection, or 'none' with no master at the socket (also a peer that sends no hello within ConnectTimeout), or 'stale' for a socket that refuses connections. */
  static async join(
    socket: string,
    { clock, signal, connectTimeout }: Joining,
  ): Promise<JoinedConnection | 'none' | 'stale'> {
    using limit =
      connectTimeout === undefined
        ? undefined
        : timeout(connectTimeout, { clock });
    const signals = [signal, limit?.signal].filter(
      (each) => each !== undefined,
    );
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
    return new JoinedConnection(socket, hold);
  }

  async dial(network: 'tcp' | 'unix', address: string): Promise<Duplex> {
    return dialStream(await this.#open({ kind: 'dial', network, address }));
  }

  newSession(): Session {
    return createSession(async (start) =>
      sessionChannel(await this.#open({ kind: 'session', start })),
    );
  }

  ref(): void {
    this.#hold.ref();
  }

  unref(): void {
    this.#hold.unref();
  }

  async close(): Promise<void> {
    if (this.#hold.destroyed) return;
    const closed = once(this.#hold, 'close');
    this.#hold.destroy();
    await closed;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async #open(request: Request): Promise<Socket> {
    const channel = await sendRequest(await greet(this.#socket), request);
    return channel.unref();
  }
}
