import { once } from 'node:events';
import { type Socket, createServer } from 'node:net';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import pMemoize, { pMemoizeClear } from 'p-memoize';

import { RefCount } from '@zukhruf/async';
import { type Client, OpenChannelError } from '@zukhruf/ssh';
import { type Environment, OpenSshConfig } from '@zukhruf/ssh/config';
import { ControlClient } from '@zukhruf/ssh/control';

export const quote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

/** Local Unix sockets, Docker Desktop's named pipe on Windows, and SSH engines. A `tcp://` engine may be on another machine. */
const supportedEndpoints = ['unix://', 'npipe://', 'ssh://'];

/**
 * The flags of an SSH connection to the engine host, of a run or of a
 * process: a host that does not answer fails the connect, and a connection
 * that stops answering ends, so no call waits forever. The user's config
 * cannot override them: OpenSSH takes the first value that it gets for an
 * option.
 */
export const SSH_FLAGS = [
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=10',
  '-o',
  'ServerAliveCountMax=2',
];

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
 * the host of an SSH engine and port forwards from it. In a run, it opens each
 * channel through the run's control master, which the global setup serves
 * (ADR 0024); outside a run, through one SSH connection of its own, opened on
 * first use with the settings of OpenSSH for `environment`.
 */
export class DockerHost {
  readonly endpoint: string;
  /** In a run, the run's control master; outside a run, the environment of the connection of this process. */
  readonly #channels:
    { readonly master: ControlClient } | { readonly environment: Environment };
  /**
   * The SSH connection of this process, opened on first use, and again on
   * the use after it was lost, with the count that keeps it ref'd only while
   * a channel opens or a session runs on it.
   */
  readonly #connect = pMemoize(
    async (
      environment: Environment,
    ): Promise<{ client: Client; refs: RefCount }> => {
      const client = await this.#dial(environment);
      const forget = (): void => pMemoizeClear(this.#connect);
      void client.wait().then(forget, forget);
      return { client, refs: new RefCount(client) };
    },
  );

  constructor(
    endpoint: string,
    reach: { readonly master: string } | { readonly environment: Environment },
  ) {
    if (!supportedEndpoints.some((scheme) => endpoint.startsWith(scheme))) {
      throw new Error(
        `Unsupported Docker endpoint ${endpoint}; tests support ${supportedEndpoints.join(', ')}`,
      );
    }
    this.endpoint = endpoint;
    this.#channels =
      'master' in reach
        ? { master: new ControlClient(reach.master) }
        : { environment: reach.environment };
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
   * the loss of its SSH connection ended, or a connection that could not
   * reach the connection or the run's master, makes close() reject.
   */
  async forward(
    port: number,
  ): Promise<{ port: number; close: () => Promise<void> }> {
    if (!this.remote) return { port, close: async () => {} };
    // An engine host that this process cannot reach fails the forward here,
    // not at the first connection of a database client.
    if ('environment' in this.#channels)
      await this.#connect(this.#channels.environment);
    const sockets = new Set<Socket>();
    let lost: unknown;
    const carry = async (socket: Socket): Promise<void> => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      const channel = await this.#through((channels) =>
        channels.dial('tcp', `127.0.0.1:${port}`),
      ).catch((error: unknown) => {
        // A server that refuses the channel refuses this one connection, as
        // a port where nothing listens yet refuses a readiness probe.
        if (!(error instanceof OpenChannelError)) lost ??= error;
        return undefined;
      });
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
        if (lost !== undefined)
          throw new Error(
            `Docker SSH forwarding was lost: ${messageOf(lost)}`,
            {
              cause: lost,
            },
          );
      })();
      return closing;
    };
    return { port: address.port, close };
  }

  /** Opens a channel through the run's control master, or outside a run through the connection of this process. */
  async #through<T>(
    open: (channels: Client | ControlClient) => Promise<T>,
  ): Promise<T> {
    const channels = this.#channels;
    if ('master' in channels) return open(channels.master);
    const { client, refs } = await this.#connect(channels.environment);
    using _channel = refs.hold();
    return await open(client);
  }

  async #dial(environment: Environment): Promise<Client> {
    const config = await OpenSshConfig.resolve(this.endpoint, {
      flags: SSH_FLAGS,
      environment,
    });
    const client = await config.dial({ clock: globalThis });
    client.unref();
    return client;
  }
}
