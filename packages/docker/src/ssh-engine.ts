import { Duplex, type Readable } from 'node:stream';

import { RefCount, type WallClock, untilAborted } from '@zukhruf/async';
import { OpenChannelError } from '@zukhruf/ssh';
import { OpenSshConfig, type SharedConnection } from '@zukhruf/ssh/config';

import type { Environment } from './context-store.ts';
import { ConnectionFailedError } from './errors.ts';
import type { CancelOptions } from './options.ts';
import { type Connection, type Dialer, isSocketFailure } from './transport.ts';

/** The command that gives the engine of the Docker CLI on the SSH server (ADR 0002). */
const ENGINE_HOST_COMMAND =
  "docker context inspect --format '{{.Endpoints.docker.Host}}'";

function messageOf(error: unknown): string {
  return Error.isError(error) ? error.message : String(error);
}

/** The SSH channel of a connection to the engine failed: the connection was lost, or the server refused or closed the channel. */
class ChannelError extends Error {
  constructor(cause: unknown) {
    super(`The SSH channel to the engine failed: ${messageOf(cause)}`, {
      cause,
    });
    this.name = 'ChannelError';
  }
}

/**
 * Whether a connection holds the client ref'd: each state gives the next one.
 * http.Agent calls ref() and unref() on a socket many times
 * (keepSocketAlive, reuseSocket), and each change of state moves the count
 * of the client once.
 */
interface RefState {
  ref(refs: RefCount): RefState;
  unref(): RefState;
}

const uncounted: RefState = {
  ref: (refs) => counted(refs.hold()),
  unref: () => uncounted,
};

function counted(held: Disposable): RefState {
  const state: RefState = {
    ref: () => state,
    unref: () => {
      held[Symbol.dispose]();
      return uncounted;
    },
  };
  return state;
}

/**
 * One connection to the engine: an open direct-streamlocal@openssh.com
 * channel to the engine socket, with the calls that Node's http.Agent makes
 * on a socket. The end of its write side sends channel EOF, so the engine
 * reads the end of the input of a hijacked connection, and its output stays
 * open. It comes with the hold of `refs` that its open took.
 */
class ChannelConnection extends Duplex implements Connection {
  readonly #channel: Duplex;
  readonly #refs: RefCount;
  #ref: RefState;

  constructor(channel: Duplex, refs: RefCount, held: Disposable) {
    super({ allowHalfOpen: true });
    this.#channel = channel;
    this.#refs = refs;
    this.#ref = counted(held);
    channel.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) channel.pause();
    });
    // The engine ended its side, as it does when the output of an attach
    // ends: end ours too, as a Node socket with allowHalfOpen false does.
    // sshd closes a channel only once both sides sent EOF, so an attach whose
    // input stays open would keep the channel, and the process, alive (#4670).
    channel.once('end', () => {
      this.push(null);
      if (!this.writableEnded) this.end();
    });
    channel.once('error', (error) => this.destroy(new ChannelError(error)));
    // The channel closes after its end; the output that came before it stays readable.
    channel.once('close', () => {
      if (this.readableEnded) this.destroy();
      else this.once('end', () => this.destroy());
    });
  }

  override _read(): void {
    this.#channel.resume();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#channel.write(chunk, (error) =>
      callback(error ? new ChannelError(error) : undefined),
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#channel.end();
    callback();
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.unref();
    this.#channel.destroy();
    callback(error);
  }

  /** A connection in use keeps the process running. */
  ref(): this {
    if (!this.destroyed) this.#ref = this.#ref.ref(this.#refs);
    return this;
  }

  /** An idle connection, or one with `ref: false`, does not keep the process running. */
  unref(): this {
    this.#ref = this.#ref.unref();
    return this;
  }

  /** A channel has no TCP keep-alive: the keepalive of the SSH connection (ServerAliveInterval) finds a dead connection. */
  setKeepAlive(): this {
    return this;
  }

  /** The agent of the transport has no timeout, so it sets none. */
  setTimeout(): this {
    return this;
  }
}

async function text(stream: Readable): Promise<string> {
  const chunks = await Array.fromAsync(stream, (chunk) => Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The connections to an engine at an ssh:// host: one SSH connection of the
 * Node process (@zukhruf/ssh), and one channel to the engine socket for each
 * connection to the engine.
 */
export class SshDialer implements Dialer {
  readonly #client: SharedConnection;
  readonly #host: string;
  readonly #socketPath: string;
  /** Keeps the client ref'd while a channel is in use (the client is ref'd until the first channel, the ping of connect(), is released). */
  readonly #refs: RefCount;

  private constructor(
    client: SharedConnection,
    host: string,
    socketPath: string,
  ) {
    this.#client = client;
    this.#host = host;
    this.#socketPath = socketPath;
    this.#refs = new RefCount(client);
  }

  /**
   * Connects as OpenSSH would with the flags of the caller, and with the
   * ConnectTimeout of the connection helper of docker/cli, 30 s, which a
   * ConnectTimeout in the flags replaces: OpenSSH takes the first value that
   * it gets for an option. The processes of the user share the connection by
   * the ControlMaster and ControlPath of the config, as OpenSSH shares one
   * (@zukhruf/ssh ADR 0013). Then it finds the engine socket of the Docker
   * CLI on the SSH server. The ping of Docker.connect opens the first channel to
   * the socket, so a server that refuses the socket fails there.
   */
  static async connect(
    host: string,
    options: CancelOptions & {
      readonly sshFlags?: readonly string[] | undefined;
      readonly environment?: Environment | undefined;
      readonly clock: WallClock;
    },
  ): Promise<SshDialer> {
    const { sshFlags = [], environment, clock, signal } = options;
    if (environment === undefined) {
      throw new ConnectionFailedError(host, {
        detail:
          'An ssh:// engine needs the `environment` option: it reads SSH_AUTH_SOCK and HOME from it. Pass `process.env`.',
      });
    }
    const cancel = signal === undefined ? {} : { signal };
    const { destination, namedSocket } = splitSocket(host);
    let client: SharedConnection;
    try {
      const config = await OpenSshConfig.resolve(destination, {
        flags: [...sshFlags, '-o', 'ConnectTimeout=30'],
        environment,
        ...cancel,
      });
      client = await config.share({ clock, ...cancel });
    } catch (error) {
      signal?.throwIfAborted();
      throw new ConnectionFailedError(host, { cause: error });
    }
    try {
      const socketPath =
        namedSocket ?? (await engineSocket(client, host, signal));
      return new SshDialer(client, host, socketPath);
    } catch (error) {
      await client.close();
      signal?.throwIfAborted();
      throw error instanceof ConnectionFailedError
        ? error
        : new ConnectionFailedError(host, { cause: error });
    }
  }

  /**
   * Opens a channel to the engine socket. The client stays ref'd while it
   * opens. A server that refuses the channel refuses the socket, whatever
   * the reason that it sends: sshd sends connect-failed under
   * AllowStreamLocalForwarding no.
   */
  async dial(): Promise<Connection> {
    const opening = this.#refs.hold();
    try {
      const channel = await this.#client.dial('unix', this.#socketPath);
      return new ChannelConnection(channel, this.#refs, opening);
    } catch (error) {
      opening[Symbol.dispose]();
      if (error instanceof OpenChannelError) {
        throw new ConnectionFailedError(this.#host, {
          cause: error,
          detail: `The SSH server refused a connection to the engine socket ${this.#socketPath}: ${error.description}. A server can refuse a socket outside the paths that it allows, as Tailscale SSH refuses one outside the home, /tmp and /run/user/<uid>: use rootless Docker, whose socket is under /run/user/<uid>, or an OpenSSH server.`,
        });
      }
      throw new ChannelError(error);
    }
  }

  /** Sends channel EOF: the engine reads the end of the input. */
  endInput(connection: Duplex): void {
    connection.end();
  }

  /** The error of a channel, and the "socket hang up" of Node when a channel closed before the answer. */
  isConnectionFailure(error: unknown): boolean {
    return error instanceof ChannelError || isSocketFailure(error);
  }

  /** Closes the SSH connection. The disposal waits for the close, so the close keeps the process running. */
  async close(): Promise<void> {
    this.#client.ref();
    await this.#client.close();
  }
}

/** The path of the engine socket of the Docker CLI on the SSH server: its context's unix:// endpoint. */
/**
 * The destination for ssh -G, and the engine socket that a path of the host
 * names. As in the Docker CLI's connection helper, a path in an ssh:// host is
 * the engine socket on the SSH server (`docker --host=unix://<path> system
 * dial-stdio`, cli/connhelper/connhelper.go), so no command on the server
 * looks it up. OpenSSH takes no path in an ssh:// destination.
 */
function splitSocket(host: string): {
  readonly destination: string;
  readonly namedSocket: string | undefined;
} {
  const url = new URL(host);
  const path = decodeURIComponent(url.pathname);
  if (path.replaceAll('/', '') === '') {
    return { destination: host, namedSocket: undefined };
  }
  url.pathname = '';
  return { destination: url.href, namedSocket: path };
}

async function engineSocket(
  client: SharedConnection,
  host: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  await using session = client.newSession();
  await untilAborted(session.start(ENGINE_HOST_COMMAND), signal);
  session.stdin.end();
  const [stdout, stderr, failure] = await untilAborted(
    Promise.all([
      text(session.stdout),
      text(session.stderr),
      session.wait().then(
        () => undefined,
        (error: unknown) => ({ error }),
      ),
    ]),
    signal,
  );
  if (failure !== undefined) {
    throw new ConnectionFailedError(host, {
      cause: failure.error,
      detail: `\`${ENGINE_HOST_COMMAND}\` failed on the SSH server: ${stderr.trim() || messageOf(failure.error)}`,
    });
  }
  const endpoint = stdout.trim();
  if (!endpoint.startsWith('unix://')) {
    throw new ConnectionFailedError(host, {
      detail: `The Docker CLI on the SSH server selects the engine ${JSON.stringify(endpoint)}, and over SSH the package reaches only a unix:// engine.`,
    });
  }
  return endpoint.slice('unix://'.length);
}
