import { connect } from 'node:net';
import type { Duplex } from 'node:stream';

import ssh2, {
  type ClientChannel,
  type IdentityCallback,
  type KeyboardInteractiveCallback,
  type NextAuthHandler,
  type ParsedKey,
  type Prompt as ProtocolPrompt,
  type ServerHostKeyAlgorithm,
  type SignCallback,
  type SigningRequestOptions,
} from 'ssh2';

import { type Clock, Future, Latch, timeout } from '@zukhruf/async';

import { joinHostPort, splitHostPort } from './address.ts';
import { ChannelStream } from './channel-stream.ts';
import { ssh2HostKeyAlgorithms } from './host-key-algorithms.ts';
import type { Signer } from './private-key.ts';
import type { Prompt } from './prompt.ts';
import { PublicKey } from './public-key.ts';
import {
  type RemoteListener,
  createRemoteListener,
} from './remote-listener.ts';
import { ServerAliveCheck } from './server-alive-check.ts';
import {
  type Exit,
  type Pty,
  Session,
  type SessionChannel,
  type SessionStart,
  type SignalName,
  createSession,
  isSignalOrVendorName,
} from './session.ts';
import {
  type AgentForwarding,
  agentForwardingOptions,
  requestAgentForwardingOnEachSession,
} from './ssh2-agent-forwarding.ts';
import { sendKeepaliveRequest } from './ssh2-keepalive-request.ts';

/** Go's ssh.ClientConfig. */
export interface ClientConfig {
  readonly user: string;
  /** Tried in order. Go's ClientConfig.Auth. */
  readonly auth: readonly AuthMethod[];
  /** Throws to refuse the key. Required: no default trusts a key. Go's HostKeyCallback. */
  readonly hostKey: HostKeyCallback;
  /** The host key algorithms to offer, in order. Default: each one that the package supports. Go's HostKeyAlgorithms. */
  readonly hostKeyAlgorithms?: readonly string[];
  readonly clock: Clock;
  /** OpenSSH's ConnectTimeout, in ms: the TCP connect, the banner exchange and the key exchange. Default: no limit. */
  readonly connectTimeout?: number;
  /** OpenSSH's ServerAliveInterval (ms) and ServerAliveCountMax. Default: no keepalive. */
  readonly keepalive?: {
    readonly interval: number;
    readonly countMax: number;
  };
  /** When set, every session asks for agent forwarding (auth-agent-req@openssh.com) before its command, as OpenSSH's ForwardAgent yes, and each auth-agent@openssh.com channel gets a new connection from this function. In the root import path, because the protocol library takes the agent when it connects. Go's agent.ForwardToRemote with agent.RequestAgentForwarding. */
  readonly agentForwarding?: () => Promise<Duplex>;
  /** The env requests that each new session sends before its first other request, with no reply wanted. OpenSshConfig#dial fills it from SetEnv, and from the variables of the caller's environment that SendEnv names. OpenSSH's SetEnv and SendEnv. */
  readonly sessionEnv?: Readonly<Record<string, string>>;
}

export type HostKeyCallback = (
  hostname: string,
  port: number,
  key: PublicKey,
) => void | Promise<void>;

/** Go's ssh.AuthMethod: PublicKeysCallback, Password, KeyboardInteractive. */
export type AuthMethod =
  | {
      readonly type: 'publickey';
      readonly signers: () => Promise<readonly Signer[]>;
    }
  | { readonly type: 'password'; readonly password: string }
  | {
      readonly type: 'keyboard-interactive';
      readonly respond: (
        prompts: readonly Prompt[],
      ) => Promise<readonly string[]>;
    };

export class AuthenticationError extends Error {
  readonly attempted: readonly string[];
  readonly allowed: readonly string[];

  constructor(attempted: readonly string[], allowed: readonly string[]) {
    super(
      `ssh: unable to authenticate, attempted methods [${attempted.join(' ')}], the server allows [${allowed.join(' ')}]`,
    );
    this.name = 'AuthenticationError';
    this.attempted = attempted;
    this.allowed = allowed;
  }
}

// What ended the connection: nothing yet, the caller's close(), or an error.
// ssh2 emits the close of the connection before it closes its channels
// (client.js:813-829), so a channel that closes with the connection reads it.
interface ConnectionPhase {
  readonly cause: Error | undefined;
}

const connected: ConnectionPhase = { cause: undefined };
const closedByCaller: ConnectionPhase = { cause: undefined };

/** What keeps the Node process alive until it is unref'd: a socket, a child process, a timer, a client. */
interface Handle {
  ref(): void;
  unref(): void;
}

/** The stream that the handshake runs on, and the handle of it that the client owns, if it owns one. */
interface Transport {
  readonly stream: Duplex;
  readonly owned: Handle | undefined;
}

const bridge: {
  restrict: (client: Client, error: Error) => void;
  closeWith: (client: Client, owned: Client) => void;
  own: (client: Client, transport: Handle) => void;
} = {
  restrict: () => {
    throw new Error('ssh: the Client class has not loaded');
  },
  closeWith: () => {
    throw new Error('ssh: the Client class has not loaded');
  },
  own: () => {
    throw new Error('ssh: the Client class has not loaded');
  },
};

/**
 * OpenSSH's restricted mode after a changed or revoked host key under
 * StrictHostKeyChecking no (ADR 0005): listen rejects with `error`, and no
 * later session asks for agent forwarding. OpenSshConfig#dial calls it before
 * it returns the client. Not exported from the package.
 */
export function restrictClient(client: Client, error: Error): void {
  bridge.restrict(client, error);
}

/** Closes `owned`, a jump host's client, after `client` closes or its connection ends (ADR 0006), and refs and unrefs it with `client`. Not exported from the package. */
export function closeWithClient(client: Client, owned: Client): void {
  bridge.closeWith(client, owned);
}

/** Refs and unrefs `transport`, which `client` runs on and the package opened, such as the transport of a ProxyCommand, with `client`. Not exported from the package. */
export function ownTransport(client: Client, transport: Handle): void {
  bridge.own(client, transport);
}

/** One SSH connection and its channels. Go's ssh.Client. */
export class Client implements AsyncDisposable {
  readonly user: string;
  /** The version line of the server, such as SSH-2.0-OpenSSH_10.3. Go's ServerVersion. */
  readonly serverVersion: string;
  readonly #connection: ssh2.Client;
  readonly #sessionEnv: Readonly<Record<string, string>>;
  readonly #closed = new Latch();
  readonly #ended = new Future<void>();
  readonly #listeners = new Map<
    string,
    (stream: Duplex, origin: string) => void
  >();
  readonly #agentForwarding: AgentForwarding | undefined;
  readonly #handles: Handle[];
  readonly #serverAlive: ServerAliveCheck | undefined;
  #phase: ConnectionPhase = connected;
  #restriction: Error | undefined;
  #owned: Client | undefined;

  static {
    bridge.restrict = (client, error) => {
      client.#restriction = error;
      client.#agentForwarding?.stop();
    };
    bridge.closeWith = (client, owned) => {
      client.#owned = owned;
      client.#handles.push(owned);
      if (client.#phase !== connected) void owned.close();
    };
    bridge.own = (client, transport) => {
      client.#handles.push(transport);
    };
  }

  private constructor(
    connection: ssh2.Client,
    config: ClientConfig,
    serverVersion: string,
    agentForwarding: AgentForwarding | undefined,
    address: string,
    transport: Transport,
  ) {
    this.#connection = connection;
    this.#agentForwarding = agentForwarding;
    this.#serverAlive =
      config.keepalive === undefined
        ? undefined
        : new ServerAliveCheck(
            config.clock,
            config.keepalive,
            transport.stream,
            () => sendKeepaliveRequest(connection),
            () => {
              this.#end(
                new Error(
                  `ssh: keepalive timeout, server ${address} not responding`,
                ),
              );
              transport.stream.destroy();
            },
          );
    this.#handles = [
      ...(transport.owned === undefined ? [] : [transport.owned]),
      ...(this.#serverAlive === undefined ? [] : [this.#serverAlive]),
    ];
    this.#sessionEnv = config.sessionEnv ?? {};
    this.user = config.user;
    this.serverVersion = serverVersion;
    connection.on('error', (error: Error) => this.#end(error));
    connection.on('tcp connection', (info, accept, reject) =>
      this.#accept(
        `${info.destIP}:${info.destPort}`,
        joinHostPort(info.srcIP, info.srcPort),
        accept,
        reject,
      ),
    );
    connection.on('unix connection', (info, accept, reject) =>
      this.#accept(info.socketPath, '', accept, reject),
    );
    connection.once('close', () => {
      this.#end(new Error('ssh: the server closed the connection'));
      this.#closed.open();
      void this.#owned?.close();
    });
  }

  #end(cause: Error): void {
    this.#serverAlive?.stop();
    if (this.#phase === connected) this.#phase = { cause };
    this.#ended.reject(cause);
  }

  /** Opens a TCP connection to `address` (host:port) with node:net, and runs the handshake on it. Go's ssh.Dial. */
  static async dial(
    address: string,
    config: ClientConfig,
    options: { readonly family?: 4 | 6; readonly signal?: AbortSignal } = {},
  ): Promise<Client> {
    const { host, port } = splitHostPort(address);
    return Client.#start(address, config, options.signal, () => {
      const socket = connect({
        host,
        port,
        ...(options.family && { family: options.family }),
      });
      return { stream: socket, owned: socket };
    });
  }

  /** Runs the handshake on a stream that the caller opened: a channel of a jump host, the pipes of a ProxyCommand. The stream stays the caller's: ref() and unref() leave it as it is. Go's ssh.NewClientConn with ssh.NewClient. */
  static async handshake(
    transport: Duplex,
    address: string,
    config: ClientConfig,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Client> {
    return Client.#start(address, config, options.signal, () => ({
      stream: transport,
      owned: undefined,
    }));
  }

  static async #start(
    address: string,
    config: ClientConfig,
    signal: AbortSignal | undefined,
    open: () => Transport,
  ): Promise<Client> {
    signal?.throwIfAborted();
    const { host, port } = splitHostPort(address);
    const serverHostKey = offeredHostKeyAlgorithms(config.hostKeyAlgorithms);
    const limit =
      config.connectTimeout === undefined
        ? undefined
        : timeout(config.connectTimeout, { clock: config.clock });
    const signals = [signal, limit?.signal].filter(
      (each) => each !== undefined,
    );
    const abort = signals.length === 0 ? undefined : AbortSignal.any(signals);

    const opened = open();
    const transport = opened.stream;
    const connection = new ssh2.Client();
    const started = Promise.withResolvers<Client>();
    let agentForwarding: AgentForwarding | undefined;
    let refusal: { readonly error: unknown } | undefined;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      limit?.[Symbol.dispose]();
      abort?.removeEventListener('abort', onAbort);
      signal?.removeEventListener('abort', onAbort);
      transport.destroy();
      started.reject(error);
    };
    function onAbort(this: AbortSignal): void {
      fail(this.reason);
    }
    abort?.addEventListener('abort', onAbort, { once: true });
    const serverVersion = readServerVersion(transport);

    connection.on('error', (error: Error) => fail(refusal?.error ?? error));
    connection.once('close', () =>
      fail(new Error('ssh: the connection closed before the handshake ended')),
    );
    connection.once('handshake', () => {
      abort?.removeEventListener('abort', onAbort);
      limit?.[Symbol.dispose]();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    connection.once('ready', () => {
      signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      started.resolve(
        new Client(
          connection,
          config,
          serverVersion.value(),
          agentForwarding,
          address,
          opened,
        ),
      );
    });

    const authenticate = new Authentication(config, (error) => fail(error));
    connection.connect({
      sock: transport,
      username: config.user,
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        Promise.try(() =>
          config.hostKey(host, port, PublicKey.parse(key)),
        ).then(
          () => verify(true),
          (error: unknown) => {
            refusal = { error };
            verify(false);
          },
        );
      },
      ...(serverHostKey === undefined ? {} : { algorithms: { serverHostKey } }),
      authHandler: (methodsLeft, _partialSuccess, next) =>
        authenticate.next(methodsLeft, next),
      readyTimeout: 0,
      strictVendor: false,
      ...(config.agentForwarding &&
        agentForwardingOptions(config.agentForwarding)),
    });
    if (config.agentForwarding) {
      agentForwarding = requestAgentForwardingOnEachSession(connection);
    }
    return started.promise;
  }

  /** A session. Its channel opens at start(), run(), output(), combinedOutput() or shell(). Go's Client.NewSession. */
  newSession(): Session {
    return createSession((start) =>
      openSession(
        this.#connection,
        { ...start, env: { ...this.#sessionEnv, ...start.env } },
        () => this.#phase.cause,
      ),
    );
  }

  /** 'tcp': a direct-tcpip channel to host:port. 'unix': a direct-streamlocal@openssh.com channel to a socket path. Go's Client.Dial. */
  async dial(
    network: 'tcp' | 'unix',
    address: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Duplex> {
    const connection = this.#connection;
    const target = network === 'tcp' ? splitHostPort(address) : undefined;
    const channel = await reply<ClientChannel>(
      options.signal,
      (resolve, reject) => {
        const opened = (error: Error | undefined, stream: ClientChannel) => {
          if (error) reject(openFailure(error));
          else resolve(stream);
        };
        // As Go's Client.Dial, the originator is 0.0.0.0 port 0.
        if (target === undefined) {
          connection.openssh_forwardOutStreamLocal(address, opened);
        } else {
          connection.forwardOut('0.0.0.0', 0, target.host, target.port, opened);
        }
      },
      (late) => late.close(),
    );
    return new ChannelStream(channel, () => this.#phase.cause);
  }

  /** tcpip-forward. Each connection comes to connectionListener with its origin, host:port of the peer. Go's Client.Listen. */
  listen(
    network: 'tcp',
    address: string,
    connectionListener: (stream: Duplex, origin: string) => void,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RemoteListener>;
  /** streamlocal-forward@openssh.com. A forwarded-streamlocal@openssh.com channel carries no origin. Go's Client.ListenUnix. */
  listen(
    network: 'unix',
    path: string,
    connectionListener: (stream: Duplex) => void,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RemoteListener>;
  async listen(
    network: 'tcp' | 'unix',
    address: string,
    connectionListener: (stream: Duplex, origin: string) => void,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<RemoteListener> {
    if (this.#restriction !== undefined) throw this.#restriction;
    const forward = await reply<Forward>(
      options.signal,
      (resolve, reject) => {
        if (network === 'tcp') this.#forwardTcp(address, resolve, reject);
        else this.#forwardUnix(address, resolve, reject);
      },
      (late) => late.cancel(() => undefined),
    );
    this.#listeners.set(forward.key, connectionListener);
    return createRemoteListener(network, forward.address, async () => {
      this.#listeners.delete(forward.key);
      if (this.#phase !== connected) return;
      const cancelled = Promise.withResolvers<void>();
      forward.cancel((error) =>
        error ? cancelled.reject(error) : cancelled.resolve(),
      );
      await cancelled.promise;
    });
  }

  #forwardTcp(
    address: string,
    resolve: (forward: Forward) => void,
    reject: (error: Error) => void,
  ): void {
    const connection = this.#connection;
    const { host, port } = splitHostPort(address);
    connection.forwardIn(host, port, (error, bound) => {
      if (error) {
        reject(listenRefused(address, error));
        return;
      }
      resolve({
        key: `${host}:${bound}`,
        address: joinHostPort(host, bound),
        cancel: (callback) => connection.unforwardIn(host, bound, callback),
      });
    });
  }

  #forwardUnix(
    path: string,
    resolve: (forward: Forward) => void,
    reject: (error: Error) => void,
  ): void {
    const connection = this.#connection;
    connection.openssh_forwardInStreamLocal(path, (error) => {
      if (error) {
        reject(listenRefused(path, error));
        return;
      }
      resolve({
        key: path,
        address: path,
        cancel: (callback) =>
          connection.openssh_unforwardInStreamLocal(path, callback),
      });
    });
  }

  // ssh2 accepts a forwarded channel only for a forward that it asked for,
  // and gives each one to the client's event (client.js:1977-1993).
  #accept(
    key: string,
    origin: string,
    accept: () => ssh2.Channel,
    reject: () => void,
  ): void {
    const listener = this.#listeners.get(key);
    if (listener === undefined) {
      reject();
      return;
    }
    listener(new ChannelStream(accept(), () => this.#phase.cause), origin);
  }

  /** Lets the Node process exit while the client holds it alone: the socket of Client.dial, the ProxyCommand of OpenSshConfig#dial, the keepalive timer, and the client of each jump host before it stop keeping it alive. A new client is ref'd. Node's ClientHttp2Session#unref. */
  unref(): void {
    for (const handle of this.#handles) handle.unref();
  }

  /** Undoes unref(): the client keeps the Node process alive again. Node's ClientHttp2Session#ref. */
  ref(): void {
    for (const handle of this.#handles) handle.ref();
  }

  /** Resolves after close(). Rejects with the error that ended the connection. Go's Conn.Wait. */
  wait(): Promise<void> {
    return this.#ended.wait();
  }

  /** Sends SSH_MSG_DISCONNECT and closes the transport, then the client of each jump host before it. A later call waits for the same close. */
  async close(): Promise<void> {
    if (this.#phase === connected) this.#phase = closedByCaller;
    this.#serverAlive?.stop();
    this.#ended.resolve();
    this.#connection.end();
    await this.#closed.wait();
    await this.#owned?.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

/** A forward that the server accepted, as the client's events name it. */
interface Forward {
  readonly key: string;
  readonly address: string;
  cancel(callback: (error?: Error | null) => void): void;
}

/**
 * Runs a request of ssh2 that answers once. An abort rejects with the
 * signal's reason; an answer that comes after it is undone.
 */
function reply<T>(
  signal: AbortSignal | undefined,
  start: (resolve: (value: T) => void, reject: (error: Error) => void) => void,
  undo: (late: T) => void,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const answered = Promise.withResolvers<T>();
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    answered.reject(signal?.reason);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const settle = (): boolean => {
    signal?.removeEventListener('abort', onAbort);
    return !aborted;
  };
  try {
    start(
      (value) => (settle() ? answered.resolve(value) : undo(value)),
      (error) => settle() && answered.reject(error),
    );
  } catch (error) {
    // ssh2 throws at once on a closed connection.
    settle();
    answered.reject(error);
  }
  return answered.promise;
}

// ssh2 1.17.0 names the server's reason in the message of a channel open
// failure, with a reason code (utils.js:7-26). Other errors, such as the loss
// of the connection, have no code.
function openFailure(error: Error): Error {
  if (!('reason' in error)) return error;
  const description = error.message.replace(
    /^\(SSH\) Channel open failure: /,
    '',
  );
  return new Error(`ssh: the server refused the channel: ${description}`);
}

function listenRefused(address: string, error: Error): Error {
  return new Error(`ssh: the server refused to listen on ${address}`, {
    cause: error,
  });
}

// With agentForwarding, auth-agent-req@openssh.com goes first, with no reply
// wanted (ssh2-agent-forwarding.ts). Then ssh2 1.17.0 sends each env with no
// reply wanted, then pty-req, then exec or shell (client.js:1192-1308).
// shell() with a window of false asks for no pty.
function openSession(
  connection: ssh2.Client,
  start: SessionStart,
  endedBy: () => Error | undefined,
): Promise<SessionChannel> {
  const opened = Promise.withResolvers<SessionChannel>();
  const callback = (error: Error | undefined, channel: ClientChannel): void => {
    if (error) opened.reject(error);
    else opened.resolve(adaptChannel(channel, endedBy));
  };
  const env = { ...start.env };
  const pty = ptyOptions(start.pty);
  if (start.command === undefined) {
    connection.shell(pty ?? false, { env }, callback);
  } else {
    connection.exec(start.command, { env, ...(pty && { pty }) }, callback);
  }
  return opened.promise;
}

function ptyOptions(pty: Pty | undefined): ssh2.PseudoTtyOptions | undefined {
  if (pty === undefined) return undefined;
  return {
    term: pty.term,
    rows: pty.size.rows,
    cols: pty.size.columns,
    width: pty.size.width ?? 0,
    height: pty.size.height ?? 0,
    ...(pty.modes && { modes: pty.modes }),
  };
}

function adaptChannel(
  channel: ClientChannel,
  endedBy: () => Error | undefined,
): SessionChannel {
  let exit: Exit | undefined;
  channel.on(
    'exit',
    (
      code: number | null,
      signal?: string,
      coreDumped?: boolean,
      errorMessage?: string,
    ) => {
      if (code !== null) {
        exit = { kind: 'status', exitStatus: code };
        return;
      }
      // ssh2 adds SIG to the name of exit-signal (client.js:676).
      const name = signal?.replace(/^SIG/, '') ?? '';
      // A name outside RFC 4254 §6.10 with no @ breaks the RFC; its exit is
      // not known, so wait() rejects with ExitMissingError.
      if (!isSignalOrVendorName(name)) return;
      exit = {
        kind: 'signal',
        signal: name,
        coreDumped: coreDumped === true,
        errorMessage: errorMessage ?? '',
      };
    },
  );
  return {
    stream: channel,
    stderr: channel.stderr,
    onClose: (listener) =>
      channel.once('close', () => listener(exit, endedBy())),
    windowChange: (size) =>
      channel.setWindow(
        size.rows,
        size.columns,
        size.height ?? 0,
        size.width ?? 0,
      ),
    signal: (name) => channel.signal(name),
    close: () => channel.close(),
  };
}

// The auth methods in the order of the config, after the "none" request that
// learns the methods of the server, as Go's clientAuthenticate does. A method
// that the server does not list is skipped.
class Authentication {
  readonly #config: ClientConfig;
  readonly #fail: (error: unknown) => void;
  readonly #pending: AuthMethod[];
  readonly #attempted: string[] = [];
  #allowed: readonly string[] = [];

  constructor(config: ClientConfig, fail: (error: unknown) => void) {
    this.#config = config;
    this.#fail = fail;
    this.#pending = [...config.auth];
  }

  next(methodsLeft: readonly string[] | null, next: NextAuthHandler): void {
    const username = this.#config.user;
    if (this.#attempted.length === 0) {
      this.#attempted.push('none');
      next({ type: 'none', username });
      return;
    }
    if (methodsLeft !== null) this.#allowed = methodsLeft;
    let method = this.#pending.shift();
    while (method !== undefined && !this.#allowed.includes(method.type)) {
      method = this.#pending.shift();
    }
    if (method === undefined) {
      this.#fail(new AuthenticationError(this.#attempted, this.#allowed));
      return;
    }
    if (!this.#attempted.includes(method.type)) {
      this.#attempted.push(method.type);
    }
    switch (method.type) {
      case 'publickey':
        method.signers().then(
          (signers) =>
            next({
              type: 'agent',
              username,
              agent: new SignerAgent(signers),
            }),
          this.#fail,
        );
        return;
      case 'password':
        next({ type: 'password', username, password: method.password });
        return;
      case 'keyboard-interactive':
        next({
          type: 'keyboard-interactive',
          username,
          prompt: (_name, _instructions, _lang, prompts, finish) =>
            this.#answer(method.respond, prompts, finish),
        });
    }
  }

  // ssh2 1.17.0 answers a round with zero prompts itself, and calls prompt
  // only for a round that has one (client.js:477-499).
  #answer(
    respond: (prompts: readonly Prompt[]) => Promise<readonly string[]>,
    prompts: readonly ProtocolPrompt[],
    finish: KeyboardInteractiveCallback,
  ): void {
    const asked = prompts.map(({ prompt, echo }) => ({
      prompt,
      echo: echo === true,
    }));
    Promise.try(() => respond(asked)).then((answers) => {
      // As Go's KeyboardInteractiveChallenge.auth, which sends no answers then.
      if (answers.length !== asked.length) {
        this.#fail(
          new Error(
            `ssh: incorrect number of answers from keyboard-interactive callback ${answers.length} (expected ${asked.length})`,
          ),
        );
        return;
      }
      finish([...answers]);
    }, this.#fail);
  }
}

// ssh2 1.17.0 signs a publickey request only with a key that it parsed or
// with an agent; an agent object serves the caller's signers to it.
class SignerAgent extends ssh2.BaseAgent<ParsedKey> {
  readonly #signers: readonly Signer[];

  constructor(signers: readonly Signer[]) {
    super();
    this.#signers = signers;
  }

  getIdentities(callback: IdentityCallback<ParsedKey>): void {
    const keys: ParsedKey[] = [];
    for (const signer of this.#signers) {
      const key = ssh2.utils.parseKey(signer.publicKey.toString());
      if (!Error.isError(key)) keys.push(key);
    }
    callback(undefined, keys);
  }

  sign(
    publicKey: ParsedKey,
    data: Buffer,
    options: SigningRequestOptions | SignCallback,
    callback?: SignCallback,
  ): void {
    const done = typeof options === 'function' ? options : callback;
    const hash = typeof options === 'function' ? undefined : options.hash;
    const wire = publicKey.getPublicSSH();
    const signer = this.#signers.find((each) =>
      Buffer.from(each.publicKey.wire).equals(wire),
    );
    if (signer === undefined) {
      done?.(new Error('ssh: no signer has this public key'));
      return;
    }
    const algorithm =
      signer.publicKey.type === 'ssh-rsa' && hash !== undefined
        ? rsaAlgorithms[hash]
        : undefined;
    signer.sign(data, algorithm).then(
      (signature) => done?.(undefined, Buffer.from(signature)),
      (error: unknown) =>
        done?.(Error.isError(error) ? error : new Error(String(error))),
    );
  }
}

const rsaAlgorithms: Readonly<Record<string, string>> = {
  sha1: 'ssh-rsa',
  sha256: 'rsa-sha2-256',
  sha512: 'rsa-sha2-512',
};

// The first line of the server that starts with "SSH-" (RFC 4253 §4.2; the
// lines before it are a greeting). ssh2 keeps only its software part.
function readServerVersion(transport: Duplex): { value(): string } {
  let received = '';
  let version: string | undefined;
  const onData = (chunk: Buffer): void => {
    received += chunk.toString('latin1');
    for (const line of received.split('\r\n').slice(0, -1)) {
      if (line.startsWith('SSH-')) {
        version = line;
        transport.off('data', onData);
        return;
      }
    }
    if (received.length > 65_536) transport.off('data', onData);
  };
  transport.on('data', onData);
  return { value: () => version ?? '' };
}

// The offer drops the names of the config that ssh2 lacks. ssh2 offers its
// defaults for an empty list, so a config that names none of them fails here.
function offeredHostKeyAlgorithms(
  names: readonly string[] | undefined,
): ServerHostKeyAlgorithm[] | undefined {
  if (names === undefined) return undefined;
  const offered: ServerHostKeyAlgorithm[] = ssh2HostKeyAlgorithms.filter(
    (each) => names.includes(each),
  );
  offered.sort((a, b) => names.indexOf(a) - names.indexOf(b));
  if (offered.length === 0) {
    throw new Error(
      `ssh: the client supports none of the host key algorithms [${names.join(' ')}]`,
    );
  }
  return offered;
}
