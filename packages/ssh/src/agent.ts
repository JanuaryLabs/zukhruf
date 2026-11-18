/** @zukhruf/ssh/agent: a client of an SSH agent. */
import { createPrivateKey } from 'node:crypto';
import type { Duplex } from 'node:stream';

import { type PrivateKey, type Signer, protocolKeyOf } from './private-key.ts';
import { PublicKey } from './public-key.ts';

export interface AgentKey {
  readonly key: PublicKey;
  readonly comment: string;
}

// The message numbers of draft-ietf-sshm-ssh-agent §6.1.
const SSH_AGENT_FAILURE = 5;
const SSH_AGENT_SUCCESS = 6;
const SSH_AGENTC_REQUEST_IDENTITIES = 11;
const SSH_AGENT_IDENTITIES_ANSWER = 12;
const SSH_AGENTC_SIGN_REQUEST = 13;
const SSH_AGENT_SIGN_RESPONSE = 14;
const SSH_AGENTC_ADD_IDENTITY = 17;
const SSH_AGENTC_REMOVE_IDENTITY = 18;
const SSH_AGENTC_REMOVE_ALL_IDENTITIES = 19;
const SSH_AGENTC_LOCK = 22;
const SSH_AGENTC_UNLOCK = 23;
const SSH_AGENTC_ADD_ID_CONSTRAINED = 25;
const SSH_AGENT_CONSTRAIN_LIFETIME = 1;
const SSH_AGENT_CONSTRAIN_CONFIRM = 2;

const signatureFlags: Readonly<Record<string, number>> = {
  'rsa-sha2-256': 2,
  'rsa-sha2-512': 4,
};

// OpenSSH's AGENT_MAX_LEN (authfd.h).
const maxMessageLength = 256 * 1024;

interface Pending {
  readonly resolve: (message: Buffer) => void;
  readonly reject: (error: Error) => void;
}

/** The connection to the agent: open, or closed with the error that each request rejects with. */
interface Phase {
  request(frame: Buffer): Promise<Buffer>;
  close(cause: Error | undefined): Phase;
}

// The agent answers the requests of one connection in their order, so the
// requests go out at once and each answer settles the oldest one.
class Open implements Phase {
  readonly #socket: Duplex;
  readonly #pending: Pending[];

  constructor(socket: Duplex, pending: Pending[]) {
    this.#socket = socket;
    this.#pending = pending;
  }

  request(frame: Buffer): Promise<Buffer> {
    const answered = Promise.withResolvers<Buffer>();
    this.#pending.push(answered);
    this.#socket.write(frame);
    return answered.promise;
  }

  close(cause: Error | undefined): Phase {
    const error = new Error('ssh: the connection to the agent closed', {
      ...(cause && { cause }),
    });
    for (const pending of this.#pending.splice(0)) pending.reject(error);
    return new Closed(error);
  }
}

class Closed implements Phase {
  readonly #error: Error;

  constructor(error: Error) {
    this.#error = error;
  }

  request(): Promise<Buffer> {
    return Promise.reject(this.#error);
  }

  close(): Phase {
    return this;
  }
}

/** A client of an agent over a socket that the caller connected. Go's agent.NewClient. draft-ietf-sshm-ssh-agent. */
export class AgentClient {
  readonly #socket: Duplex;
  readonly #pending: Pending[] = [];
  #received = Buffer.alloc(0);
  #phase: Phase;

  constructor(socket: Duplex) {
    this.#socket = socket;
    this.#phase = new Open(socket, this.#pending);
    socket.on('data', (chunk: Buffer) => this.#receive(chunk));
    socket.on('error', (error: Error) => this.#close(error));
    socket.once('end', () => this.#close(undefined));
    socket.once('close', () => this.#close(undefined));
  }

  /** The keys of the agent, in its order. A key that the package cannot parse, such as a certificate, is left out. Go's List. */
  async list(): Promise<AgentKey[]> {
    const answer = await this.#request(SSH_AGENTC_REQUEST_IDENTITIES, []);
    const reader = new Reader(answer, 'the list of keys');
    if (reader.byte() !== SSH_AGENT_IDENTITIES_ANSWER) {
      throw new Error('ssh: the agent refused to list its keys');
    }
    const keys: AgentKey[] = [];
    for (let count = reader.uint32(); count > 0; count--) {
      const wire = reader.string();
      const comment = reader.string().toString('utf8');
      const key = parseOrUndefined(wire);
      if (key !== undefined) keys.push({ key, comment });
    }
    return keys;
  }

  /** One signer for each key; each signature is a request to the agent. Go's Signers. */
  async signers(): Promise<Signer[]> {
    return (await this.list()).map(({ key }) => ({
      publicKey: key,
      sign: (data, algorithm) =>
        this.sign(key, data, {
          ...(algorithm === 'rsa-sha2-256' || algorithm === 'rsa-sha2-512'
            ? { algorithm }
            : {}),
        }),
    }));
  }

  /** The signature blob. Without `algorithm`, an RSA key signs with ssh-rsa. Go's SignWithFlags. */
  async sign(
    key: PublicKey,
    data: Uint8Array,
    options: { readonly algorithm?: 'rsa-sha2-256' | 'rsa-sha2-512' } = {},
  ): Promise<Uint8Array> {
    const flags =
      options.algorithm === undefined ? 0 : signatureFlags[options.algorithm];
    const answer = await this.#request(SSH_AGENTC_SIGN_REQUEST, [
      string(key.wire),
      string(data),
      uint32(flags ?? 0),
    ]);
    const reader = new Reader(answer, 'the signature');
    if (reader.byte() !== SSH_AGENT_SIGN_RESPONSE) {
      throw new Error(`ssh: the agent refused to sign with ${key.type} key`);
    }
    const signature = new Reader(reader.string(), 'the signature');
    signature.string();
    return new Uint8Array(signature.string());
  }

  /** lifetime in ms, as ssh-add -t (rounded up to whole seconds); confirm, as ssh-add -c. Go's Add. */
  async add(
    key: PrivateKey,
    options: {
      readonly comment?: string;
      readonly lifetime?: number;
      readonly confirm?: boolean;
    } = {},
  ): Promise<void> {
    const constraints: Buffer[] = [];
    if (options.lifetime !== undefined) {
      constraints.push(
        byte(SSH_AGENT_CONSTRAIN_LIFETIME),
        uint32(Math.ceil(options.lifetime / 1000)),
      );
    }
    if (options.confirm === true) {
      constraints.push(byte(SSH_AGENT_CONSTRAIN_CONFIRM));
    }
    await this.#expectSuccess(
      constraints.length === 0
        ? SSH_AGENTC_ADD_IDENTITY
        : SSH_AGENTC_ADD_ID_CONSTRAINED,
      [
        ...privateKeyFields(key),
        string(Buffer.from(options.comment ?? '', 'utf8')),
        ...constraints,
      ],
      `add the ${key.publicKey.type} key`,
    );
  }

  /** Go's Remove. */
  async remove(key: PublicKey): Promise<void> {
    await this.#expectSuccess(
      SSH_AGENTC_REMOVE_IDENTITY,
      [string(key.wire)],
      `remove the ${key.type} key ${key.fingerprint()}`,
    );
  }

  /** Go's RemoveAll. */
  async removeAll(): Promise<void> {
    await this.#expectSuccess(
      SSH_AGENTC_REMOVE_ALL_IDENTITIES,
      [],
      'remove its keys',
    );
  }

  /** The agent lists no key and signs nothing until unlock with the same passphrase. Go's Lock. */
  async lock(passphrase: string): Promise<void> {
    await this.#expectSuccess(
      SSH_AGENTC_LOCK,
      [string(Buffer.from(passphrase, 'utf8'))],
      'lock',
    );
  }

  /** Go's Unlock. */
  async unlock(passphrase: string): Promise<void> {
    await this.#expectSuccess(
      SSH_AGENTC_UNLOCK,
      [string(Buffer.from(passphrase, 'utf8'))],
      'unlock',
    );
  }

  async #expectSuccess(
    type: number,
    fields: readonly Buffer[],
    action: string,
  ): Promise<void> {
    const answer = await this.#request(type, fields);
    if (answer[0] === SSH_AGENT_SUCCESS) return;
    const reason = answer[0] === SSH_AGENT_FAILURE ? '' : ` (${answer[0]})`;
    throw new Error(`ssh: the agent refused to ${action}${reason}`);
  }

  #request(type: number, fields: readonly Buffer[]): Promise<Buffer> {
    const body = Buffer.concat([byte(type), ...fields]);
    return this.#phase.request(Buffer.concat([uint32(body.length), body]));
  }

  #receive(chunk: Buffer): void {
    this.#received = Buffer.concat([this.#received, chunk]);
    while (this.#received.length >= 4) {
      const length = this.#received.readUInt32BE(0);
      if (length === 0 || length > maxMessageLength) {
        this.#socket.destroy(
          new Error(`ssh: the agent sent a message of ${length} bytes`),
        );
        return;
      }
      if (this.#received.length < 4 + length) return;
      const message = this.#received.subarray(4, 4 + length);
      this.#received = this.#received.subarray(4 + length);
      const pending = this.#pending.shift();
      if (pending === undefined) {
        this.#socket.destroy(
          new Error('ssh: the agent sent an unasked answer'),
        );
        return;
      }
      pending.resolve(message);
    }
  }

  #close(cause: Error | undefined): void {
    this.#phase = this.#phase.close(cause);
  }
}

function parseOrUndefined(wire: Buffer): PublicKey | undefined {
  try {
    return PublicKey.parse(wire);
  } catch {
    return undefined;
  }
}

// The key fields of SSH_AGENTC_ADD_IDENTITY, draft-ietf-sshm-ssh-agent §4.2.
function privateKeyFields(key: PrivateKey): Buffer[] {
  const type = key.publicKey.type;
  const jwk = createPrivateKey(protocolKeyOf(key).getPrivatePEM()).export({
    format: 'jwk',
  });
  const field = (name: 'n' | 'e' | 'd' | 'p' | 'q' | 'qi' | 'x' | 'y') => {
    const value = jwk[name];
    if (value === undefined) {
      throw new Error(`ssh: the ${type} key has no ${name}`);
    }
    return Buffer.from(value, 'base64url');
  };
  switch (type) {
    case 'ssh-ed25519': {
      const publicPart = field('x');
      return [
        string(Buffer.from(type)),
        string(publicPart),
        string(Buffer.concat([field('d'), publicPart])),
      ];
    }
    case 'ssh-rsa':
      return [
        string(Buffer.from(type)),
        mpint(field('n')),
        mpint(field('e')),
        mpint(field('d')),
        mpint(field('qi')),
        mpint(field('p')),
        mpint(field('q')),
      ];
    case 'ecdsa-sha2-nistp256':
    case 'ecdsa-sha2-nistp384':
    case 'ecdsa-sha2-nistp521':
      return [
        string(Buffer.from(type)),
        string(Buffer.from(type.slice('ecdsa-sha2-'.length))),
        string(Buffer.concat([Buffer.of(4), field('x'), field('y')])),
        mpint(field('d')),
      ];
    default:
      throw new Error(`ssh: the agent client cannot add a ${type} key`);
  }
}

function byte(value: number): Buffer {
  return Buffer.of(value);
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function string(value: Uint8Array): Buffer {
  return Buffer.concat([uint32(value.length), value]);
}

// RFC 4251 §5: an unsigned big-endian value, with no leading zero byte unless
// the high bit is set.
function mpint(unsigned: Buffer): Buffer {
  let start = 0;
  while (start < unsigned.length && unsigned[start] === 0) start++;
  const value = unsigned.subarray(start);
  const high = value.length > 0 && (value[0] ?? 0) & 0x80;
  return string(high ? Buffer.concat([Buffer.of(0), value]) : value);
}

class Reader {
  readonly #buffer: Buffer;
  readonly #what: string;
  #offset = 0;

  constructor(buffer: Buffer, what: string) {
    this.#buffer = buffer;
    this.#what = what;
  }

  byte(): number {
    return this.#take(1).readUInt8(0);
  }

  uint32(): number {
    return this.#take(4).readUInt32BE(0);
  }

  string(): Buffer {
    return this.#take(this.uint32());
  }

  #take(length: number): Buffer {
    if (this.#offset + length > this.#buffer.length) {
      throw new Error(`ssh: the agent sent a short message for ${this.#what}`);
    }
    const value = this.#buffer.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }
}
