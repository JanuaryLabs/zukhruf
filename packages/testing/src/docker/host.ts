import { once } from 'node:events';
import { type Socket, createServer } from 'node:net';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import pMemoize, { pMemoizeClear } from 'p-memoize';

import { isErrno } from '@zukhruf/fs';
import type { Client } from '@zukhruf/ssh';
import { type Environment, OpenSshConfig } from '@zukhruf/ssh/config';
import { ControlClient } from '@zukhruf/ssh/control';

import type { ProcessRun } from './run-records.ts';

export const quote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

/** Local Unix sockets, Docker Desktop's named pipe on Windows, and SSH engines. A `tcp://` engine may be on another machine. */
const supportedEndpoints = ['unix://', 'npipe://', 'ssh://'];

/**
 * The flags of the SSH connection of this process: a host that does not
 * answer fails the connect, and a connection that stops answering ends, so
 * no call waits forever. The user's config cannot override them: OpenSSH
 * takes the first value that it gets for an option.
 */
const SSH_FLAGS = [
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=10',
  '-o',
  'ServerAliveCountMax=2',
];

/** The socket in the run's directory where the global setup serves the run's SSH connection (ADR 0024). */
const MASTER_SOCKET = 'ssh.sock';

/** What a command in the shell of the engine's host printed. */
export interface ShellResult {
  stdout: string;
  stderr: string;
}

async function text(stream: Readable): Promise<string> {
  const chunks = await Array.fromAsync(stream, (chunk) => Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

const messageOf = (error: unknown): string =>
  Error.isError(error) ? error.message : String(error);

/**
 * The endpoint of an engine, for what the Engine API does not do: a shell on
 * the host of an SSH engine and port forwards from it. In a run whose global
 * setup serves the run's SSH connection, it opens each channel through that
 * control master; otherwise through one SSH connection of its own, opened on
 * first use with the settings of OpenSSH for `environment`.
 */
export class DockerHost {
  readonly endpoint: string;
  readonly #master: ControlClient | undefined;
  readonly #environment: Environment;
  /** The sessions that run on each connection of this host. */
  readonly #sessions = new WeakMap<Client, number>();
  /** The SSH connection of this process, opened on first use, and again on the use after it was lost. */
  readonly #connect = pMemoize(async (): Promise<Client> => {
    const client = await this.#dial();
    const forget = (): void => pMemoizeClear(this.#connect);
    void client.wait().then(forget, forget);
    return client;
  });

  constructor(
    endpoint: string,
    run: ProcessRun | undefined,
    environment: Environment,
  ) {
    if (!supportedEndpoints.some((scheme) => endpoint.startsWith(scheme))) {
      throw new Error(
        `Unsupported Docker endpoint ${endpoint}; tests support ${supportedEndpoints.join(', ')}`,
      );
    }
    this.endpoint = endpoint;
    this.#master = run
      ? new ControlClient(join(run.records.directory, MASTER_SOCKET))
      : undefined;
    this.#environment = environment;
  }

  get remote(): boolean {
    return this.endpoint.startsWith('ssh://');
  }

  /** Runs `script` in the shell of the engine's host, with `input` on its stdin. A status other than 0 rejects with what the script printed on stderr. */
  async shell(script: string, input?: string): Promise<ShellResult> {
    return this.#through(async (channels) => {
      await using session = channels.newSession();
      await session.start(script);
      // A script that exits before it reads its input fails the write;
      // its exit status decides the outcome.
      session.stdin.once('error', () => {});
      session.stdin.end(input);
      const [stdout, stderr, failure] = await Promise.all([
        text(session.stdout),
        text(session.stderr),
        session.wait().then(
          () => undefined,
          (error: unknown) => ({ error }),
        ),
      ]);
      if (failure !== undefined)
        throw new Error(
          `${script} failed on the engine host ${this.endpoint}: ${stderr.trim() || messageOf(failure.error)}`,
          { cause: failure.error },
        );
      return { stdout, stderr };
    });
  }

  /**
   * A TCP port on 127.0.0.1 of this machine whose connections each reach
   * 127.0.0.1:`port` of the engine's host through a channel. A channel that
   * the loss of its SSH connection ended makes close() reject.
   */
  async forward(
    port: number,
  ): Promise<{ port: number; close: () => Promise<void> }> {
    if (!this.remote) return { port, close: async () => {} };
    // An engine host that this process cannot reach fails the forward here,
    // not at the first connection of a database client.
    if (!this.#master) await this.#connect();
    const sockets = new Set<Socket>();
    let lost: Error | undefined;
    const carry = async (socket: Socket): Promise<void> => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      const channel = await this.#through((channels) =>
        channels.dial('tcp', `127.0.0.1:${port}`),
      ).catch(() => undefined);
      if (!channel) return void socket.destroy();
      // A channel of a lost connection fails with the error of the loss as
      // its cause (@zukhruf/ssh); a write to a channel that the far end
      // closed has none.
      channel.once('error', (error: Error) => {
        if (error.cause !== undefined) lost ??= error;
      });
      await Promise.allSettled([
        pipeline(socket, channel),
        pipeline(channel, socket),
      ]);
    };
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      void carry(socket);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    server.unref();
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Docker forwarding did not acquire a TCP port');
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        const closed = once(server, 'close');
        server.close();
        for (const socket of sockets) socket.destroy();
        await closed;
        if (lost)
          throw new Error(`Docker SSH forwarding was lost: ${lost.message}`, {
            cause: lost,
          });
      })();
      return closing;
    };
    return { port: address.port, close };
  }

  /**
   * Opens a channel through the run's control master, or through the
   * connection of this process when no master serves the run: a master
   * socket that does not exist (ENOENT) means that the run's global setup
   * serves none. A master that died (ECONNREFUSED) fails the call.
   */
  async #through<T>(
    open: (channels: Client | ControlClient) => Promise<T>,
  ): Promise<T> {
    if (this.#master) {
      try {
        return await open(this.#master);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
    }
    const client = await this.#connect();
    // The connection keeps the process alive only while a channel opens or
    // a session runs on it.
    const before = this.#sessions.get(client) ?? 0;
    this.#sessions.set(client, before + 1);
    if (before === 0) client.ref();
    try {
      return await open(client);
    } finally {
      const after = (this.#sessions.get(client) ?? 1) - 1;
      this.#sessions.set(client, after);
      if (after === 0) client.unref();
    }
  }

  async #dial(): Promise<Client> {
    const config = await OpenSshConfig.resolve(this.endpoint, {
      flags: SSH_FLAGS,
      environment: this.#environment,
    });
    const client = await config.dial({ clock: globalThis });
    client.unref();
    return client;
  }
}
