import {
  type Duplex,
  PassThrough,
  type Readable,
  type Writable,
} from 'node:stream';
import { finished } from 'node:stream/promises';

import { Future } from '@zukhruf/async';

/** The channel of a session, as the client opens it. */
export interface SessionChannel {
  /** The data of the channel: stdin to it, stdout from it. */
  readonly stream: Duplex;
  readonly stderr: Readable;
  /** Calls `listener` once at SSH_MSG_CHANNEL_CLOSE, with the exit-status or exit-signal when one came, and the error that ended the connection when the channel closed with it. */
  onClose(
    listener: (
      exit: Exit | undefined,
      connectionError: Error | undefined,
    ) => void,
  ): void;
  windowChange(size: WindowSize): void;
  signal(name: SignalName): void;
  close(): void;
}

export interface SessionRequest {
  /** undefined for a shell. */
  readonly command: string | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly pty: Pty | undefined;
}

export interface Pty {
  readonly term: string;
  readonly size: WindowSize;
  readonly modes: TerminalModes | undefined;
}

export type OpenSession = (request: SessionRequest) => Promise<SessionChannel>;

const bridge: { construct: (open: OpenSession) => Session } = {
  construct: () => {
    throw new Error('ssh: the Session class has not loaded');
  },
};

/** A session that opens its channel with `open`. Not in the API: Client.newSession calls it. */
export function createSession(open: OpenSession): Session {
  return bridge.construct(open);
}

interface Phase {
  /** Throws once the session started: a request goes out only at the start. */
  configure(): void;
  /** The channel. Rejects before the start, and when the server refused the start. */
  channel(): Promise<SessionChannel>;
}

const unstarted: Phase = {
  configure() {},
  channel: () => Promise.reject(new Error('ssh: the session has not started')),
};

class Started implements Phase {
  readonly opened = new Future<SessionChannel>();

  configure(): void {
    throw new Error('ssh: the session has already started');
  }

  channel(): Promise<SessionChannel> {
    return this.opened.wait();
  }
}

/** One command or shell on the remote host. Go's ssh.Session. */
export class Session implements AsyncDisposable {
  static {
    bridge.construct = (open) => new Session(open);
  }

  /** Its end sends SSH_MSG_CHANNEL_EOF. */
  readonly stdin: Writable;
  readonly stdout: Readable;
  /** SSH_MSG_CHANNEL_EXTENDED_DATA, type 1. */
  readonly stderr: Readable;
  readonly #stdin = new PassThrough();
  readonly #stdout = new PassThrough();
  readonly #stderr = new PassThrough();
  readonly #open: OpenSession;
  readonly #env: Record<string, string> = {};
  readonly #ptys: Pty[] = [];
  readonly #exit = new Future<void>();
  #phase: Phase = unstarted;

  private constructor(open: OpenSession) {
    this.#open = open;
    this.stdin = this.#stdin;
    this.stdout = this.#stdout;
    this.stderr = this.#stderr;
  }

  /** An env request, sent at start after the variables of ClientConfig.sessionEnv, with no reply wanted, as OpenSSH sends it: a server that refuses the variable ignores it. Go's Setenv wants a reply and returns an error on a refusal. */
  setenv(name: string, value: string): void {
    this.#phase.configure();
    this.#env[name] = value;
  }

  /** Sent at start. A refusal rejects start() or shell(). Go's RequestPty. */
  requestPty(term: string, size: WindowSize, modes?: TerminalModes): void {
    this.#phase.configure();
    this.#ptys.push({ term, size, modes });
  }

  /** Resolves when the server accepted the command. Go's Start. */
  async start(command: string): Promise<void> {
    await this.#begin(command);
  }

  /** A login shell. Go's Shell. */
  async shell(): Promise<void> {
    await this.#begin(undefined);
  }

  /** Resolves at exit status 0. Rejects with ExitError or ExitMissingError. Go's Wait. An output stream that nothing reads is discarded, as Go's Session discards a nil Stdout or Stderr. */
  async wait(): Promise<void> {
    await this.#phase.channel();
    this.#discardUnread();
    return this.#exit.wait();
  }

  /** start(), then wait(). Go's Run. */
  async run(command: string): Promise<void> {
    await this.start(command);
    await this.wait();
  }

  /** run(), and stdout. Go's Output. */
  async output(command: string): Promise<Buffer> {
    return this.#collect(command, [this.#stdout]);
  }

  /** run(), and stdout and stderr in the order they came. Go's CombinedOutput. */
  async combinedOutput(command: string): Promise<Buffer> {
    return this.#collect(command, [this.#stdout, this.#stderr]);
  }

  /** Go's WindowChange. */
  async windowChange(size: WindowSize): Promise<void> {
    (await this.#phase.channel()).windowChange(size);
  }

  /** Go's Signal. */
  async signal(name: SignalName): Promise<void> {
    (await this.#phase.channel()).signal(name);
  }

  /** SSH_MSG_CHANNEL_CLOSE. sshd does not end a command without a pty on a close. It resolves when the message is sent, as Go's Session.Close returns: sshd answers the close only after the command ended. */
  async close(): Promise<void> {
    const channel = await this.#phase.channel().catch(() => undefined);
    if (channel === undefined) return;
    this.#discardUnread();
    channel.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  async #collect(
    command: string,
    streams: readonly Readable[],
  ): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for (const stream of streams) {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    }
    await this.run(command);
    await Promise.all(streams.map((stream) => finished(stream)));
    return Buffer.concat(chunks);
  }

  // ssh2 closes a channel only after its data was read (onCHANNEL_CLOSE in
  // utils.js), so a stream that nothing reads would hold the close forever.
  #discardUnread(): void {
    for (const stream of [this.#stdout, this.#stderr]) {
      if (stream.readableFlowing === null) stream.resume();
    }
  }

  async #begin(command: string | undefined): Promise<void> {
    this.#phase.configure();
    const started = new Started();
    this.#phase = started;
    // ssh2's exec and shell throw at once on a closed connection.
    const channel = await Promise.try(() =>
      this.#open({ command, env: this.#env, pty: this.#ptys.at(-1) }),
    ).catch((error: unknown) => {
      started.opened.reject(error);
      throw error;
    });
    this.#stdin.pipe(channel.stream);
    channel.stream.pipe(this.#stdout);
    channel.stderr.pipe(this.#stderr);
    channel.onClose((exit, connectionError) => {
      if (exit === undefined) {
        this.#exit.reject(
          new ExitMissingError(connectionError && { cause: connectionError }),
        );
      } else if (exit.kind === 'status' && exit.exitStatus === 0) {
        this.#exit.resolve();
      } else {
        this.#exit.reject(new ExitError(exit));
      }
    });
    started.opened.resolve(channel);
  }
}

export interface WindowSize {
  readonly rows: number;
  readonly columns: number;
  readonly width?: number;
  readonly height?: number;
}

/** The terminal modes of RFC 4254 §8 by name, such as { ECHO: 0, ISIG: 1 }. */
export type TerminalModes = Readonly<Record<string, number>>;

/** RFC 4254 §6.10, with no SIG. */
export type SignalName =
  | 'ABRT'
  | 'ALRM'
  | 'FPE'
  | 'HUP'
  | 'ILL'
  | 'INT'
  | 'KILL'
  | 'PIPE'
  | 'QUIT'
  | 'SEGV'
  | 'TERM'
  | 'USR1'
  | 'USR2';

/** How the command of a session ended: exit-status or exit-signal, RFC 4254 §6.10. */
export type Exit =
  | { readonly kind: 'status'; readonly exitStatus: number }
  | {
      readonly kind: 'signal';
      /** sshd sends SIG@openssh.com for a signal outside RFC 4254's list (session.c, sig2name). */
      readonly signal: SignalName | `${string}@${string}`;
      readonly coreDumped: boolean;
      readonly errorMessage: string;
    };

/** Go's ExitError. */
export class ExitError extends Error {
  readonly exit: Exit;

  constructor(exit: Exit) {
    super(
      exit.kind === 'status'
        ? `ssh: the command exited with status ${exit.exitStatus}`
        : `ssh: the command ended on signal ${exit.signal}`,
    );
    this.name = 'ExitError';
    this.exit = exit;
  }
}

/** Go's ExitMissingError. */
export class ExitMissingError extends Error {
  /** `cause` is the error that ended the connection, when the channel closed with it. */
  constructor(options?: ErrorOptions) {
    super('ssh: the session ended with no exit status or exit signal', options);
    this.name = 'ExitMissingError';
  }
}
