import { type Duplex, PassThrough, type Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';

import ssh2, {
  type AuthContext,
  type ClientInfo,
  type Connection,
  type KeyboardAuthContext,
  type Session as ProtocolSession,
  type PseudoTtyInfo,
  type PublicKeyAuthContext,
  type ServerChannel,
  type TcpipBindInfo,
} from 'ssh2';

import { Future, Latch } from '@zukhruf/async';

import { splitHostPort } from './address.ts';
import { type PrivateKey, protocolKeyOf } from './private-key.ts';
import type { Prompt } from './prompt.ts';
import { PublicKey } from './public-key.ts';
import type { SignalName, TerminalModes, WindowSize } from './session.ts';
import {
  SessionReplies,
  dropCommandChannel,
  exitCommandChannel,
  halfClosing,
  openCommandChannel,
  parseTerminalModes,
  removeKeepalive,
} from './ssh2-server-channel.ts';

/** Go's ssh.ServerConfig. No clock: the server waits on no timer, and the signal of ServerConn.handshake bounds a slow handshake. */
export interface ServerConfig {
  readonly hostKeys: readonly PrivateKey[];
  /** Go's PublicKeyCallback. */
  readonly publicKey?: (
    user: string,
    key: PublicKey,
  ) => boolean | Promise<boolean>;
  /** Go's PasswordCallback. */
  readonly password?: (
    user: string,
    password: string,
  ) => boolean | Promise<boolean>;
  /** Go's KeyboardInteractiveCallback. */
  readonly keyboardInteractive?: (
    user: string,
    ask: (prompts: readonly Prompt[]) => Promise<readonly string[]>,
  ) => boolean | Promise<boolean>;
}

export type IncomingChannel =
  | { readonly type: 'session'; accept(): ServerSession; reject(): void }
  | {
      readonly type: 'direct-tcpip';
      readonly address: string;
      readonly origin: string;
      accept(): Duplex;
      reject(): void;
    }
  | {
      readonly type: 'direct-streamlocal@openssh.com';
      readonly path: string;
      accept(): Duplex;
      reject(): void;
    };

export type GlobalRequest =
  | {
      readonly type: 'tcpip-forward';
      readonly address: string;
      /** port: the port that the server bound, when the address asked for port 0 (RFC 4254 §7.1). */
      accept(port?: number): void;
      reject(): void;
    }
  | {
      readonly type: 'cancel-tcpip-forward';
      readonly address: string;
      accept(): void;
      reject(): void;
    }
  | {
      readonly type:
        | 'streamlocal-forward@openssh.com'
        | 'cancel-streamlocal-forward@openssh.com';
      readonly path: string;
      accept(): void;
      reject(): void;
    };

export type SessionRequest =
  | {
      readonly type: 'env';
      readonly name: string;
      readonly value: string;
      accept(): void;
      reject(): void;
    }
  | {
      readonly type: 'pty-req';
      readonly term: string;
      readonly size: WindowSize;
      readonly modes: TerminalModes;
      accept(): void;
      reject(): void;
    }
  | { readonly type: 'window-change'; readonly size: WindowSize }
  | {
      readonly type: 'signal';
      readonly name: SignalName | `${string}@${string}`;
    }
  | {
      readonly type: 'exec';
      readonly command: string;
      accept(): void;
      reject(): void;
    }
  | {
      readonly type: 'shell' | 'auth-agent-req@openssh.com';
      accept(): void;
      reject(): void;
    };

/** The server side of one connection, after its handshake. Go's ssh.ServerConn. */
export class ServerConn implements AsyncDisposable {
  readonly user: string;
  readonly clientVersion: string;
  readonly #connection: Connection;
  readonly #transport: Duplex;
  readonly #channels: Inbox<IncomingChannel>;
  readonly #requests: Inbox<GlobalRequest>;
  readonly #closed: Latch;

  private constructor(attached: Attached, user: string) {
    this.#connection = attached.connection;
    this.#transport = attached.transport;
    this.#channels = attached.channels;
    this.#requests = attached.requests;
    this.#closed = attached.closed;
    this.clientVersion = attached.clientVersion;
    this.user = user;
  }

  /** Go's ssh.NewServerConn. */
  static async handshake(
    transport: Duplex,
    config: ServerConfig,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ServerConn> {
    options.signal?.throwIfAborted();
    const server = new ssh2.Server({
      hostKeys: config.hostKeys.map((key) => ({ key: protocolKeyOf(key) })),
    });
    const ready = Promise.withResolvers<ServerConn>();
    const fail = (error: unknown): void => {
      ready.reject(error);
      transport.destroy();
    };
    const onAbort = (): void => fail(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const onTransportClose = (): void =>
      fail(new Error('ssh: the client closed the connection'));
    transport.once('close', onTransportClose);

    server.once('connection', (connection: Connection, info: ClientInfo) => {
      const attached = attach(connection, transport, info);
      const authentication = new Authentication(config);
      connection.on('error', fail);
      connection.on('authentication', (context: AuthContext) => {
        authentication.decide(context).catch(fail);
      });
      connection.once('ready', () => {
        ready.resolve(new ServerConn(attached, authentication.user));
      });
    });
    // @types/ssh2 types the socket as net.Socket; ssh2 reads only its stream
    // members, and guards setNoDelay (ssh2 1.17.0 server.js:1325).
    Reflect.apply(server.injectSocket, server, [transport]);
    try {
      return await ready.promise;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      transport.off('close', onTransportClose);
    }
  }

  /** Go's <-chan NewChannel. */
  channels(): AsyncIterable<IncomingChannel> {
    return this.#channels.values;
  }

  /** Go's <-chan *Request, for the global requests. */
  requests(): AsyncIterable<GlobalRequest> {
    return this.#requests.values;
  }

  /** forwarded-tcpip, for a tcpip-forward that the server accepted: address is the listened address, origin host:port of the peer. */
  forward(network: 'tcp', address: string, origin: string): Promise<Duplex>;
  /** forwarded-streamlocal@openssh.com, for a streamlocal-forward that the server accepted. It carries no origin. */
  forward(network: 'unix', path: string): Promise<Duplex>;
  async forward(
    network: 'tcp' | 'unix',
    address: string,
    origin?: string,
  ): Promise<Duplex> {
    const opened = Promise.withResolvers<Duplex>();
    const done = (error: Error | undefined, channel: ServerChannel): void => {
      if (error) opened.reject(error);
      else opened.resolve(halfClosing(channel));
    };
    if (network === 'unix') {
      this.#connection.openssh_forwardOutStreamLocal(address, done);
    } else {
      const bound = splitHostPort(address);
      const peer = splitHostPort(origin ?? '');
      this.#connection.forwardOut(
        bound.host,
        bound.port,
        peer.host,
        peer.port,
        done,
      );
    }
    return opened.promise;
  }

  async close(): Promise<void> {
    this.#transport.once('finish', () => this.#transport.destroy());
    this.#connection.end();
    await this.#closed.wait();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

interface Attached {
  readonly connection: Connection;
  readonly transport: Duplex;
  readonly clientVersion: string;
  readonly channels: Inbox<IncomingChannel>;
  readonly requests: Inbox<GlobalRequest>;
  readonly closed: Latch;
}

/** host:port, with the brackets of an IPv6 host, as Go's net.JoinHostPort. */
function joinHostPort(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Listens for the channels and the global requests from the start, so that none comes before a listener. */
function attach(
  connection: Connection,
  transport: Duplex,
  info: ClientInfo,
): Attached {
  removeKeepalive(connection);
  parseTerminalModes(connection);
  const channels = new Inbox<IncomingChannel>();
  const requests = new Inbox<GlobalRequest>();
  const closed = new Latch();
  connection.once('close', () => {
    channels.end();
    requests.end();
    closed.open();
  });
  connection.on('session', (accept, reject) => {
    channels.push(
      {
        type: 'session',
        accept: () => sessions.construct(connection, accept(), closed),
        reject,
      },
      reject,
    );
  });
  connection.on('tcpip', (accept, reject, request) => {
    channels.push(
      {
        type: 'direct-tcpip',
        address: joinHostPort(request.destIP, request.destPort),
        origin: joinHostPort(request.srcIP, request.srcPort),
        accept: () => halfClosing(accept()),
        reject,
      },
      reject,
    );
  });
  connection.on('openssh.streamlocal', (accept, reject, request) => {
    channels.push(
      {
        type: 'direct-streamlocal@openssh.com',
        path: request.socketPath,
        accept: () => halfClosing(accept()),
        reject,
      },
      reject,
    );
  });
  connection.on(
    'request',
    (
      accept: ((port?: number) => void) | undefined,
      reject: (() => void) | undefined,
      name: string,
      request: TcpipBindInfo | { socketPath: string },
    ) => {
      const refuse = (): void => reject?.();
      const answer = {
        accept: (port?: number) => accept?.(port),
        reject: refuse,
      };
      if ('socketPath' in request) {
        if (
          name === 'streamlocal-forward@openssh.com' ||
          name === 'cancel-streamlocal-forward@openssh.com'
        ) {
          requests.push(
            {
              type: name,
              path: request.socketPath,
              ...answer,
              accept: () => accept?.(),
            },
            refuse,
          );
          return;
        }
      } else if (name === 'tcpip-forward') {
        requests.push(
          {
            type: name,
            address: joinHostPort(request.bindAddr, request.bindPort),
            ...answer,
          },
          refuse,
        );
        return;
      } else if (name === 'cancel-tcpip-forward') {
        requests.push(
          {
            type: name,
            address: joinHostPort(request.bindAddr, request.bindPort),
            ...answer,
            accept: () => accept?.(),
          },
          refuse,
        );
        return;
      }
      refuse();
    },
  );
  return {
    connection,
    transport,
    clientVersion: info.header.identRaw,
    channels,
    requests,
    closed,
  };
}

type Method = 'publickey' | 'password' | 'keyboard-interactive';

/** Answers each authentication request of the client from the callbacks of ServerConfig. */
class Authentication {
  readonly #config: ServerConfig;
  readonly #methods: readonly Method[];
  #user = '';

  constructor(config: ServerConfig) {
    this.#config = config;
    const offered: [Method, unknown][] = [
      ['publickey', config.publicKey],
      ['password', config.password],
      ['keyboard-interactive', config.keyboardInteractive],
    ];
    this.#methods = offered
      .filter(([, callback]) => callback !== undefined)
      .map(([method]) => method);
  }

  get user(): string {
    return this.#user;
  }

  async decide(context: AuthContext): Promise<void> {
    if (await this.#allows(context)) {
      this.#user = context.username;
      context.accept();
    } else {
      context.reject([...this.#methods]);
    }
  }

  async #allows(context: AuthContext): Promise<boolean> {
    const { publicKey, password, keyboardInteractive } = this.#config;
    if (context.method === 'publickey' && publicKey) {
      const key = PublicKey.parse(context.key.data);
      if (!(await publicKey(context.username, key))) return false;
      return context.signature === undefined || verifies(context);
    }
    if (context.method === 'password' && password) {
      return password(context.username, context.password);
    }
    if (context.method === 'keyboard-interactive' && keyboardInteractive) {
      return keyboardInteractive(context.username, (prompts) =>
        ask(context, prompts),
      );
    }
    return false;
  }
}

/** RFC 4256 §3.2-3.4: one SSH_MSG_USERAUTH_INFO_REQUEST and its response. */
function ask(
  context: KeyboardAuthContext,
  prompts: readonly Prompt[],
): Promise<readonly string[]> {
  const answered = Promise.withResolvers<readonly string[]>();
  context.prompt(
    prompts.map(({ prompt, echo }) => ({ prompt, echo })),
    (answers: string[] | Error) => {
      if (Error.isError(answers)) answered.reject(answers);
      else answered.resolve(answers);
    },
  );
  return answered.promise;
}

/**
 * ssh2's server leaves the signature of a publickey request to the caller
 * (ssh2 1.17.0 server.js:1095, PKAuthContext). A request without one only
 * asks whether the key is allowed (RFC 4252 §7), and its accept sends
 * SSH_MSG_USERAUTH_PK_OK.
 */
function verifies(context: PublicKeyAuthContext): boolean {
  const { blob, signature, hashAlgo } = context;
  if (blob === undefined || signature === undefined) return false;
  const key = ssh2.utils.parseKey(context.key.data);
  if (Error.isError(key)) return false;
  return key.verify(blob, signature, hashAlgo) === true;
}

/** An unbounded queue that one reader drains with for await, as a buffered Go channel. */
class Inbox<T> {
  readonly values: ReadableStream<T>;
  readonly #controller: { current?: ReadableStreamDefaultController<T> } = {};

  constructor() {
    this.values = new ReadableStream<T>({
      start: (controller) => {
        this.#controller.current = controller;
      },
    });
  }

  /** Calls `refuse` when the reader is gone, or the queue ended. */
  push(value: T, refuse: () => void): void {
    try {
      this.#controller.current?.enqueue(value);
    } catch {
      refuse();
    }
  }

  end(): void {
    try {
      this.#controller.current?.close();
    } catch {
      // The reader cancelled the queue.
    }
  }
}

const sessions: {
  construct: (
    connection: Connection,
    session: ProtocolSession,
    closed: Latch,
  ) => ServerSession;
} = {
  construct: () => {
    throw new Error('ssh: the ServerSession class has not loaded');
  },
};

function windowSize(info: {
  readonly rows: number;
  readonly cols: number;
  readonly width: number;
  readonly height: number;
}): WindowSize {
  return {
    rows: info.rows,
    columns: info.cols,
    width: info.width,
    height: info.height,
  };
}

/** A session channel that the server accepted. */
export class ServerSession {
  static {
    sessions.construct = (connection, session, closed) =>
      new ServerSession(connection, session, closed);
  }

  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly #connection: Connection;
  readonly #session: ProtocolSession;
  readonly #requests = new Inbox<SessionRequest>();
  /** The channel of the accepted exec or shell request. */
  readonly #command = new Future<ServerChannel>();
  readonly #outputsEnded = new Latch();
  readonly #closed = new Latch();

  private constructor(
    connection: Connection,
    session: ProtocolSession,
    connectionClosed: Latch,
  ) {
    this.#connection = connection;
    this.#session = session;
    const stdin = new PassThrough();
    this.stdin = stdin;
    this.stdout = this.#output((channel) => channel);
    this.stderr = this.#output((channel) => channel.stderr);
    // EOF follows the end of both stdout and stderr, as sshd sends it: no
    // extended data may follow EOF.
    void Promise.all([
      finished(this.stdout),
      finished(this.stderr),
      this.#command.wait(),
    ]).then(
      ([, , channel]) => {
        channel.eof();
        this.#outputsEnded.open();
      },
      () => {},
    );
    const close = (): void => {
      this.#requests.end();
      this.#command.reject(
        new Error(
          'ssh: exit() needs an exec or shell request that the server accepted',
        ),
      );
      stdin.end();
      this.#closed.open();
    };
    session.once('close', close);
    void connectionClosed.wait().then(close);
    this.#listen(stdin);
  }

  requests(): AsyncIterable<SessionRequest> {
    return this.#requests.values;
  }

  /** Sends exit-status, or exit-signal, and closes the channel. */
  async exit(
    status:
      | number
      | {
          readonly signal: SignalName | `${string}@${string}`;
          readonly coreDumped?: boolean;
          readonly errorMessage?: string;
        },
  ): Promise<void> {
    const channel = await this.#command.wait();
    this.stdout.end();
    this.stderr.end();
    await this.#outputsEnded.wait();
    exitCommandChannel(
      this.#connection,
      this.#session,
      channel,
      typeof status === 'number'
        ? status
        : {
            signal: status.signal,
            coreDumped: status.coreDumped ?? false,
            errorMessage: status.errorMessage ?? '',
          },
    );
    await this.#closed.wait();
  }

  #listen(stdin: PassThrough): void {
    const session = this.#session;
    const replies = new SessionReplies(this.#connection, session);
    const deliver = (
      request: SessionRequest,
      reply: (success: boolean) => void,
    ): void => this.#requests.push(request, () => reply(false));
    // ssh2 gives a reject function only when the client wants a reply.
    const slot = (reject: (() => void) | undefined) =>
      replies.reserve(reject !== undefined);

    session.on('env', (_accept, reject, info) => {
      const reply = slot(reject);
      deliver(
        {
          type: 'env',
          name: info.key,
          value: info.val,
          accept: () => reply(true),
          reject: () => reply(false),
        },
        reply,
      );
    });
    // The modes come from parseTerminalModes, also those that ssh2 cannot name.
    session.on('pty', (_accept, reject, info: PseudoTtyInfo) => {
      const reply = slot(reject);
      deliver(
        {
          type: 'pty-req',
          term: info.term,
          size: windowSize(info),
          modes: Object.fromEntries(
            Object.entries(info.modes).filter(
              (entry): entry is [string, number] => entry[1] !== undefined,
            ),
          ),
          accept: () => reply(true),
          reject: () => reply(false),
        },
        reply,
      );
    });
    session.on('window-change', (_accept, reject, info) => {
      const reply = slot(reject);
      deliver({ type: 'window-change', size: windowSize(info) }, reply);
      reply(true);
    });
    session.on('signal', (_accept, reject, info) => {
      const reply = slot(reject);
      const { name } = info;
      if (!isSignalName(name)) {
        reply(false);
        return;
      }
      deliver({ type: 'signal', name }, reply);
      reply(true);
    });
    session.on('auth-agent', (_accept, reject) => {
      const reply = slot(reject);
      deliver(
        {
          type: 'auth-agent-req@openssh.com',
          accept: () => reply(true),
          reject: () => reply(false),
        },
        reply,
      );
    });
    const command = (
      reject: (() => void) | undefined,
      request: (answer: { accept(): void; reject(): void }) => SessionRequest,
    ): void => {
      const reply = slot(reject);
      const channel = openCommandChannel(this.#connection, session);
      if (channel === undefined) {
        reply(false);
        return;
      }
      const refuse = (): void => {
        dropCommandChannel(session);
        reply(false);
      };
      deliver(
        request({
          accept: () => {
            reply(true);
            channel.pipe(stdin);
            this.#command.resolve(channel);
          },
          reject: refuse,
        }),
        refuse,
      );
    };
    session.on('exec', (_accept, reject, info) => {
      command(reject, (answer) => ({
        type: 'exec',
        command: info.command,
        ...answer,
      }));
    });
    session.on('shell', (_accept, reject) => {
      command(reject, (answer) => ({ type: 'shell', ...answer }));
    });
    // Answered here, so that their replies keep the order of the requests.
    for (const refused of ['x11', 'subsystem']) {
      session.on(
        refused,
        (_accept: unknown, reject: (() => void) | undefined) =>
          slot(reject)(false),
      );
    }
  }

  /** A stream that waits for the channel of the command, and writes to it. */
  #output(stream: (channel: ServerChannel) => Writable): Writable {
    return new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        this.#command
          .wait()
          .then((channel) => stream(channel).write(chunk, callback))
          .catch(callback);
      },
      final: (callback) => {
        callback();
      },
    });
  }
}

const signalNames: ReadonlySet<string> = new Set<SignalName>([
  'ABRT',
  'ALRM',
  'FPE',
  'HUP',
  'ILL',
  'INT',
  'KILL',
  'PIPE',
  'QUIT',
  'SEGV',
  'TERM',
  'USR1',
  'USR2',
]);

function isSignalName(
  name: string,
): name is SignalName | `${string}@${string}` {
  return signalNames.has(name) || name.includes('@');
}
