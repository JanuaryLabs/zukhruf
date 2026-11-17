import { connect } from 'node:net';
import type { Duplex } from 'node:stream';

import ssh2, {
  type IdentityCallback,
  type NextAuthHandler,
  type ParsedKey,
  type ServerHostKeyAlgorithm,
  type SignCallback,
  type SigningRequestOptions,
} from 'ssh2';

import { type Clock, Future, Latch, timeout } from '@zukhruf/async';

import type { Signer } from './private-key.ts';
import { PublicKey } from './public-key.ts';

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
}

export type HostKeyCallback = (
  hostname: string,
  port: number,
  key: PublicKey,
) => void | Promise<void>;

/** Go's ssh.AuthMethod: PublicKeysCallback. */
export type AuthMethod = {
  readonly type: 'publickey';
  readonly signers: () => Promise<readonly Signer[]>;
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

/** One SSH connection and its channels. Go's ssh.Client. */
export class Client implements AsyncDisposable {
  readonly user: string;
  /** The version line of the server, such as SSH-2.0-OpenSSH_10.3. Go's ServerVersion. */
  readonly serverVersion: string;
  readonly #connection: ssh2.Client;
  readonly #closed = new Latch();
  readonly #ended = new Future<void>();

  private constructor(
    connection: ssh2.Client,
    user: string,
    serverVersion: string,
  ) {
    this.#connection = connection;
    this.user = user;
    this.serverVersion = serverVersion;
    connection.on('error', (error: Error) => this.#ended.reject(error));
    connection.once('close', () => {
      this.#ended.reject(new Error('ssh: the server closed the connection'));
      this.#closed.open();
    });
  }

  /** Opens a TCP connection to `address` (host:port) with node:net, and runs the handshake on it. Go's ssh.Dial. */
  static async dial(
    address: string,
    config: ClientConfig,
    options: { readonly family?: 4 | 6; readonly signal?: AbortSignal } = {},
  ): Promise<Client> {
    const { host, port } = splitAddress(address);
    return Client.#start(address, config, options.signal, () =>
      connect({
        host,
        port,
        ...(options.family && { family: options.family }),
      }),
    );
  }

  /** Runs the handshake on a stream that the caller opened: a channel of a jump host, the pipes of a ProxyCommand. Go's ssh.NewClientConn with ssh.NewClient. */
  static async handshake(
    transport: Duplex,
    address: string,
    config: ClientConfig,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Client> {
    return Client.#start(address, config, options.signal, () => transport);
  }

  static async #start(
    address: string,
    config: ClientConfig,
    signal: AbortSignal | undefined,
    open: () => Duplex,
  ): Promise<Client> {
    signal?.throwIfAborted();
    const { host, port } = splitAddress(address);
    const serverHostKey = offeredHostKeyAlgorithms(config.hostKeyAlgorithms);
    const limit =
      config.connectTimeout === undefined
        ? undefined
        : timeout(config.connectTimeout, { clock: config.clock });
    const signals = [signal, limit?.signal].filter(
      (each) => each !== undefined,
    );
    const abort = signals.length === 0 ? undefined : AbortSignal.any(signals);

    const transport = open();
    const connection = new ssh2.Client();
    const started = Promise.withResolvers<Client>();
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
        new Client(connection, config.user, serverVersion.value()),
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
      ...(config.keepalive === undefined
        ? {}
        : {
            keepaliveInterval: config.keepalive.interval,
            keepaliveCountMax: config.keepalive.countMax,
          }),
    });
    return started.promise;
  }

  /** Resolves after close(). Rejects with the error that ended the connection. Go's Conn.Wait. */
  wait(): Promise<void> {
    return this.#ended.wait();
  }

  /** Sends SSH_MSG_DISCONNECT and closes the transport. A later call waits for the same close. */
  close(): Promise<void> {
    this.#ended.resolve();
    this.#connection.end();
    return this.#closed.wait();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
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
    method
      .signers()
      .then(
        (signers) =>
          next({ type: 'agent', username, agent: new SignerAgent(signers) }),
        this.#fail,
      );
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

// The host key algorithms of ssh2 1.17.0 (lib/protocol/constants.js:64-76).
// It has no *-cert-v01@openssh.com algorithm, so the offer drops those names
// of the config. ssh2 offers its defaults for an empty list, so a config
// that names none of them fails here.
const ssh2HostKeyAlgorithms: readonly ServerHostKeyAlgorithm[] = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
  'ssh-dss',
];

function offeredHostKeyAlgorithms(
  names: readonly string[] | undefined,
): ServerHostKeyAlgorithm[] | undefined {
  if (names === undefined) return undefined;
  const offered = ssh2HostKeyAlgorithms.filter((each) => names.includes(each));
  offered.sort((a, b) => names.indexOf(a) - names.indexOf(b));
  if (offered.length === 0) {
    throw new Error(
      `ssh: the client supports none of the host key algorithms [${names.join(' ')}]`,
    );
  }
  return offered;
}

function splitAddress(address: string): { host: string; port: number } {
  const colon = address.lastIndexOf(':');
  const port = Number(address.slice(colon + 1));
  if (colon < 0 || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError(`ssh: the address ${address} is not host:port`);
  }
  const host = address.slice(0, colon).replace(/^\[(.*)\]$/, '$1');
  return { host, port };
}
