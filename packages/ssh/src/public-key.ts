import { hash } from 'node:crypto';

import ssh2 from 'ssh2';

/** Go's ssh.PublicKey. */
export class PublicKey {
  /** Such as ssh-ed25519. */
  readonly type: string;
  /** Go's Marshal. */
  readonly wire: Uint8Array;

  private constructor(type: string, wire: Uint8Array) {
    this.type = type;
    this.wire = wire;
  }

  /** The wire form, RFC 4253 §6.6. Go's ParsePublicKey. */
  static parse(wire: Uint8Array): PublicKey {
    const bytes = Buffer.from(wire);
    const typeLength = bytes.length >= 4 ? bytes.readUInt32BE(0) : -1;
    if (typeLength < 1 || 4 + typeLength > bytes.length) {
      throw new Error('ssh: the public key has no key type');
    }
    const type = bytes.toString('latin1', 4, 4 + typeLength);
    const parsed = ssh2.utils.parseKey(`${type} ${bytes.toString('base64')}`);
    if (Error.isError(parsed)) {
      throw new Error(`ssh: cannot parse the ${type} public key`, {
        cause: parsed,
      });
    }
    if (!parsed.getPublicSSH().equals(bytes)) {
      throw new Error(`ssh: the ${type} public key has trailing data`);
    }
    return new PublicKey(type, new Uint8Array(bytes));
  }

  /** A line of authorized_keys or of a .pub file. Go's ParseAuthorizedKey. */
  static parseAuthorizedKey(line: string): {
    readonly key: PublicKey;
    readonly comment: string;
    readonly options: readonly string[];
  } {
    const text = line.trim();
    const parsed = parseKeyFields(text);
    if (parsed !== undefined) return { ...parsed, options: [] };
    const { options, rest } = splitOptions(text);
    const withOptions = parseKeyFields(rest);
    if (withOptions === undefined) {
      throw new Error('ssh: no key found in the authorized_keys line');
    }
    return { ...withOptions, options };
  }

  /** SHA256:<base64>, as ssh-keygen -l prints it. Go's FingerprintSHA256. */
  fingerprint(): string {
    const digest = hash('sha256', this.wire, 'base64');
    return `SHA256:${digest.replace(/=+$/, '')}`;
  }

  equals(other: PublicKey): boolean {
    return Buffer.from(this.wire).equals(other.wire);
  }

  /** <type> <base64>, as a line of authorized_keys. Go's MarshalAuthorizedKey. */
  toString(): string {
    return `${this.type} ${Buffer.from(this.wire).toString('base64')}`;
  }
}

/** `<type> <base64> [comment]`, or undefined when the text does not start with a key. */
function parseKeyFields(
  text: string,
): { readonly key: PublicKey; readonly comment: string } | undefined {
  const [type, blob, ...comment] = text.split(/[ \t]+/);
  if (type === undefined || blob === undefined) return undefined;
  try {
    const key = PublicKey.parse(Buffer.from(blob, 'base64'));
    if (key.type !== type) return undefined;
    return { key, comment: comment.join(' ') };
  } catch {
    return undefined;
  }
}

/** The options of an authorized_keys line end at the first space or tab outside quotes. */
function splitOptions(text: string): {
  readonly options: string[];
  readonly rest: string;
} {
  const options: string[] = [];
  let option = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '\\' && quoted && text[index + 1] === '"') {
      option += '\\"';
      index++;
    } else if (character === '"') {
      quoted = !quoted;
      option += character;
    } else if (!quoted && character === ',') {
      options.push(option);
      option = '';
    } else if (!quoted && (character === ' ' || character === '\t')) {
      options.push(option);
      return { options, rest: text.slice(index).trim() };
    } else {
      option += character;
    }
  }
  return { options: [], rest: text };
}
