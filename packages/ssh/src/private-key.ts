import ssh2, { type ParsedKey } from 'ssh2';

import { PublicKey } from './public-key.ts';

/** A private key that signs: a parsed key, or a key of the agent. Go's ssh.Signer. */
export interface Signer {
  readonly publicKey: PublicKey;
  /** The signature blob of `algorithm`, such as rsa-sha2-256; without one, the algorithm of the key type. */
  sign(data: Uint8Array, algorithm?: string): Promise<Uint8Array>;
}

export class PassphraseMissingError extends Error {
  readonly publicKey: PublicKey | undefined;

  constructor(publicKey: PublicKey | undefined) {
    super('ssh: this private key is passphrase protected');
    this.name = 'PassphraseMissingError';
    this.publicKey = publicKey;
  }
}

// The hash of each RSA signature algorithm (RFC 8332); the other key types
// have one signature algorithm, which ssh2 picks from the key.
const rsaHashes: Readonly<Record<string, string>> = {
  'ssh-rsa': 'sha1',
  'rsa-sha2-256': 'sha256',
  'rsa-sha2-512': 'sha512',
};

/** Go's ParsePrivateKey and ParsePrivateKeyWithPassphrase. */
export class PrivateKey implements Signer {
  readonly publicKey: PublicKey;
  readonly #key: ParsedKey;

  private constructor(key: ParsedKey) {
    this.#key = key;
    this.publicKey = PublicKey.parse(key.getPublicSSH());
  }

  /** An OpenSSH key, or a PKCS#1, PKCS#8 or SEC1 PEM key. Throws PassphraseMissingError for an encrypted key with no passphrase. */
  static parse(data: Uint8Array, passphrase?: string): PrivateKey {
    const bytes = Buffer.from(data);
    const parsed = ssh2.utils.parseKey(bytes, passphrase);
    if (Error.isError(parsed)) {
      if (
        passphrase === undefined &&
        parsed.message.includes('no passphrase given')
      ) {
        throw new PassphraseMissingError(clearPublicKey(bytes));
      }
      throw new Error(`ssh: cannot parse the private key: ${parsed.message}`, {
        cause: parsed,
      });
    }
    if (!parsed.isPrivateKey()) {
      throw new Error('ssh: the key is not a private key');
    }
    return new PrivateKey(parsed);
  }

  async sign(data: Uint8Array, algorithm?: string): Promise<Uint8Array> {
    const hash = algorithm === undefined ? undefined : rsaHashes[algorithm];
    const signature: Buffer | Error = this.#key.sign(Buffer.from(data), hash);
    if (Error.isError(signature)) {
      throw new Error(`ssh: cannot sign with the ${this.publicKey.type} key`, {
        cause: signature,
      });
    }
    return new Uint8Array(signature);
  }
}

// An OpenSSH private key file holds its public key unencrypted
// (OpenSSH PROTOCOL.key): "openssh-key-v1\0", the cipher name, the KDF name,
// the KDF options, the number of keys, then the first public key.
function clearPublicKey(file: Buffer): PublicKey | undefined {
  const text = file.toString('latin1');
  const body =
    /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(
      text,
    )?.[1];
  if (body === undefined) return undefined;
  const bytes = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  const magic = Buffer.from('openssh-key-v1\0', 'latin1');
  if (!bytes.subarray(0, magic.length).equals(magic)) return undefined;
  let offset = magic.length;
  const readString = (): Buffer | undefined => {
    if (offset + 4 > bytes.length) return undefined;
    const length = bytes.readUInt32BE(offset);
    const end = offset + 4 + length;
    if (end > bytes.length) return undefined;
    const value = bytes.subarray(offset + 4, end);
    offset = end;
    return value;
  };
  for (const _field of ['cipher', 'kdf', 'kdf options']) {
    if (readString() === undefined) return undefined;
  }
  const keyCountLength = 4;
  offset += keyCountLength;
  const wire = readString();
  return wire === undefined ? undefined : PublicKey.parse(wire);
}
