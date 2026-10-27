import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import {
  Agent,
  type ClientRequest,
  type RequestOptions,
  request,
} from 'node:http';
import { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { finished } from 'node:stream/promises';

import type { Transport } from './transport.ts';

/** The part of the standard error of `ssh` that an SshExitError keeps: the last 4 KB. */
const STDERR_LIMIT = 4096;

/** `ssh` exited before the engine answered. It is the cause of a ConnectionFailedError. */
export class SshExitError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The last 4 KB of the standard error of `ssh`, such as "Permission denied (publickey)." */
  readonly stderr: string;

  constructor(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    stderr: string,
  ) {
    super(
      `ssh exited with ${exitCode === null ? `signal ${signal}` : `code ${exitCode}`}${stderr.trim() ? `: ${stderr.trim()}` : '.'}`,
    );
    this.name = 'SshExitError';
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderr = stderr;
  }
}

/** The arguments of the connection helper, as the connhelper of docker/cli gives them. */
export function sshArguments(url: URL): string[] {
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    ...(url.username ? ['-l', decodeURIComponent(url.username)] : []),
    ...(url.port ? ['-p', url.port] : []),
    '--',
    // An IPv6 address keeps its brackets in a URL; ssh takes it without them, as URL.Hostname() of Go gives it.
    url.hostname.replace(/^\[(.*)\]$/, '$1'),
    'docker',
    'system',
    'dial-stdio',
  ];
}

/**
 * One connection to an SSH engine: one `ssh` process that runs
 * `docker system dial-stdio`. Its readable side is the standard output of
 * `ssh`, and its writable side is the standard input of `ssh`.
 *
 * The end of the writable side ends the standard input of `ssh`, and
 * `docker system dial-stdio` then closes the write side of its connection to
 * the engine. This is the end of the input of an attach or an exec.
 */
class SshConnection extends Duplex {
  readonly #child: ChildProcessWithoutNullStreams;
  #stderr = '';
  /** Resolves when `ssh` exited and its pipes are closed. */
  readonly exited: () => Promise<void>;

  constructor(url: URL) {
    super({ allowHalfOpen: true });
    const child = spawn('ssh', sshArguments(url), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    const closed = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
    });
    this.exited = () => closed;
    child.on('error', (error) => this.destroy(error));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) child.stdout.pause();
    });
    child.stdout.once('end', () => {
      void closed.then(() => {
        const error = this.#exitError();
        if (error) this.destroy(error);
        else this.push(null);
      });
    });
    // A write to the standard input of an `ssh` that exited fails with EPIPE.
    // The write callback reports it, after the exit of `ssh` gives the reason.
    child.stdin.on('error', () => undefined);
  }

  /** True until `ssh` exits. */
  get running(): boolean {
    return this.#child.exitCode === null && this.#child.signalCode === null;
  }

  /** The exit of `ssh` as an error, or undefined while it runs or when it exited with 0. */
  #exitError(): SshExitError | undefined {
    const { exitCode, signalCode } = this.#child;
    if (exitCode === 0 || (exitCode === null && signalCode === null)) {
      return undefined;
    }
    return new SshExitError(exitCode, signalCode, this.#stderr);
  }

  /**
   * Gives the exit of `ssh` in place of an error of its pipes, when `ssh`
   * exited. When `ssh` exited with 0, its output is complete: the reader gets
   * the end of the output before the error of the write, so a command that
   * does not read all of its input still gives its output.
   */
  #fail(error: Error, callback: (error: Error) => void): void {
    void this.exited().then(async () => {
      const exit = this.#exitError();
      if (exit === undefined) {
        await finished(this, { writable: false }).catch(() => undefined);
      }
      callback(exit ?? error);
    });
  }

  override _read(): void {
    this.#child.stdout.resume();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#child.stdin.write(chunk, (error) => {
      if (error) this.#fail(error, callback);
      else callback();
    });
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#child.stdin.end((error?: Error | null) => {
      if (error) this.#fail(error, callback);
      else callback();
    });
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    const { exitCode, signalCode } = this.#child;
    if (exitCode === null && signalCode === null) {
      // The disposal waits for the exit, so the exit must keep the process running.
      this.#child.ref();
      this.#child.kill();
    }
    this.#child.stdin.destroy();
    this.#child.stdout.destroy();
    this.#child.stderr.destroy();
    callback(error);
  }

  /** An idle connection does not keep the process running. */
  unref(): void {
    this.#child.unref();
    for (const pipe of this.#pipes()) pipe.unref();
  }

  /** A connection in use keeps the process running. */
  ref(): void {
    this.#child.ref();
    for (const pipe of this.#pipes()) pipe.ref();
  }

  #pipes(): Socket[] {
    return [this.#child.stdin, this.#child.stdout, this.#child.stderr].filter(
      (pipe) => pipe instanceof Socket,
    );
  }
}

/**
 * Keeps the idle connections to an SSH engine for the next request, and
 * starts a new `ssh` for each request that finds no idle connection.
 */
class SshAgent extends Agent {
  readonly #url: URL;
  readonly #connections = new Set<SshConnection>();

  constructor(url: URL) {
    super({ keepAlive: true });
    this.#url = url;
  }

  override createConnection(): Duplex {
    const connection = new SshConnection(this.#url);
    this.#connections.add(connection);
    void connection.exited().then(() => {
      this.#connections.delete(connection);
      // An idle connection whose `ssh` exited, such as after a restart of the
      // engine, cannot take the next request. Its close removes it from the
      // free connections of the agent.
      if (this.#isIdle(connection)) connection.destroy();
    });
    return connection;
  }

  #isIdle(connection: SshConnection): boolean {
    return Object.values(this.freeSockets).some((sockets) =>
      sockets?.some((socket) => Object.is(socket, connection)),
    );
  }

  /**
   * The keepSocketAlive of Node sets a timeout and TCP keep-alive, which a
   * connection through `ssh` does not have. The reuseSocket of Node stays: it
   * removes the error listener of the idle connection and calls ref(). A
   * connection whose `ssh` exited is not kept.
   */
  override keepSocketAlive(socket: Duplex): boolean {
    if (!(socket instanceof SshConnection)) return true;
    if (!socket.running) return false;
    socket.unref();
    return true;
  }

  /** Ends each `ssh` process and resolves when each one exited. */
  async close(): Promise<void> {
    const connections = [...this.#connections];
    this.destroy();
    for (const connection of connections) connection.destroy();
    await Promise.all(connections.map((connection) => connection.exited()));
  }
}

/** The connections to an engine at an ssh:// host. Each connection is one `ssh` process. */
export class SshTransport implements Transport {
  readonly #agent: SshAgent;

  constructor(url: URL) {
    this.#agent = new SshAgent(url);
  }

  request(options: RequestOptions): ClientRequest {
    return request({ ...options, agent: this.#agent });
  }

  /** Ends the standard input of `ssh`: `docker system dial-stdio` then closes the write side to the engine. */
  endInput(socket: Duplex): void {
    socket.end();
  }

  /** Unrefs the `ssh` process of the connection and its pipes. */
  unref(socket: Duplex): void {
    if (socket instanceof SshConnection) socket.unref();
  }

  async close(): Promise<void> {
    await this.#agent.close();
  }
}
