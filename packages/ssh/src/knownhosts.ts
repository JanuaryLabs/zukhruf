import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ssh2HostKeyAlgorithms } from './host-key-algorithms.ts';
import { matchPattern } from './match-pattern.ts';
import { PublicKey } from './public-key.ts';

/** Go's knownhosts.KnownKey. */
export interface KnownKey {
  readonly key: PublicKey;
  readonly file: string;
  readonly line: number;
}

/** Go's knownhosts.KeyError: an empty `want` means an unknown host. */
export class KeyError extends Error {
  readonly want: readonly KnownKey[];

  constructor(name: string, want: readonly KnownKey[]) {
    super(
      want.length === 0
        ? `knownhosts: the host key of ${name} is unknown`
        : `knownhosts: the host key of ${name} does not match the known keys at ${want.map(({ file, line }) => `${file}:${line}`).join(', ')}`,
    );
    this.name = 'KeyError';
    this.want = want;
  }
}

/** Go's knownhosts.RevokedError. */
export class RevokedError extends Error {
  readonly revoked: KnownKey;

  constructor(name: string, revoked: KnownKey) {
    super(
      `knownhosts: the host key of ${name} is revoked at ${revoked.file}:${revoked.line}`,
    );
    this.name = 'RevokedError';
    this.revoked = revoked;
  }
}

// The host key algorithms of ssh2 that OpenSSH still accepts.
const supportedHostKeyAlgorithms = ssh2HostKeyAlgorithms.filter(
  (algorithm) => algorithm !== 'ssh-dss',
);

/** The keys of the known hosts files. Go's ssh/knownhosts. */
export class KnownHosts {
  readonly #files: readonly string[];
  readonly #hostKeys: HostLine[];
  readonly #revoked: readonly HostLine[];

  private constructor(
    files: readonly string[],
    hostKeys: HostLine[],
    revoked: readonly HostLine[],
  ) {
    this.#files = files;
    this.#hostKeys = hostKeys;
    this.#revoked = revoked;
  }

  /** Reads the files in order; a missing file is empty. Go's knownhosts.New. */
  static async read(files: readonly string[]): Promise<KnownHosts> {
    const hostKeys: HostLine[] = [];
    const revoked: HostLine[] = [];
    for (const file of files) {
      const lines = (await readIfPresent(file)).split(/\r?\n/);
      for (const [index, text] of lines.entries()) {
        const parsed = parseLine(text, file, index + 1);
        if (parsed === undefined) continue;
        if (parsed.marker === '@revoked') {
          revoked.push(parsed.line);
        } else {
          hostKeys.push(parsed.line);
        }
      }
    }
    return new KnownHosts([...files], hostKeys, revoked);
  }

  /** Throws KeyError or RevokedError. Looks up [hostname]:port when the port is not 22. */
  check(hostname: string, port: number, key: PublicKey): void {
    const name = lookupName(hostname, port);
    const revoked = this.#revoked.find(
      (line) => line.matches(name) && line.known.key.equals(key),
    );
    if (revoked !== undefined) throw new RevokedError(name, revoked.known);
    const want: KnownKey[] = [];
    for (const line of this.#hostKeys) {
      if (!line.matches(name)) continue;
      if (line.known.key.equals(key)) return;
      want.push(line.known);
    }
    throw new KeyError(name, want);
  }

  /** The algorithms of the known keys of the host first, then the rest of `offered`. Default `offered`: each one that the package supports. */
  hostKeyAlgorithms(
    hostname: string,
    port: number,
    offered: readonly string[] = supportedHostKeyAlgorithms,
  ): string[] {
    const name = lookupName(hostname, port);
    const revoked = this.#revoked.filter((line) => line.matches(name));
    const known = new Set(
      this.#hostKeys
        .filter(
          (line) =>
            line.matches(name) &&
            !revoked.some(({ known }) => known.key.equals(line.known.key)),
        )
        .flatMap(({ known }) => algorithmsOf(known.key.type)),
    );
    return [
      ...offered.filter((algorithm) => known.has(algorithm)),
      ...offered.filter((algorithm) => !known.has(algorithm)),
    ];
  }

  /** Appends a line to the first file, hashed when `hash` is true. Go's knownhosts.Line. */
  async add(
    hostname: string,
    port: number,
    key: PublicKey,
    options: { readonly hash: boolean },
  ): Promise<void> {
    const [file] = this.#files;
    if (file === undefined) {
      throw new Error('knownhosts: no known hosts file to add the key to');
    }
    const name = lookupName(hostname, port);
    const host = options.hash ? HashedName.of(name) : new Patterns(name);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const content = await readIfPresent(file);
    const unterminated = content !== '' && !content.endsWith('\n');
    await appendFile(
      file,
      `${unterminated ? '\n' : ''}${host.toString()} ${key.toString()}\n`,
    );
    const line =
      content === '' ? 1 : content.split('\n').length + (unterminated ? 1 : 0);
    this.#hostKeys.push(new HostLine(host, { key, file, line }));
  }
}

/** The name that OpenSSH writes and looks up: `host`, or `[host]:port` when the port is not 22 (`put_host_port` in misc.c). */
function lookupName(hostname: string, port: number): string {
  const host = hostname.toLowerCase();
  return port === 22 ? host : `[${host}]:${port}`;
}

/** The algorithms that a key of the type signs with: an RSA key signs with SHA-2 too (RFC 8332). */
function algorithmsOf(type: string): readonly string[] {
  return type === 'ssh-rsa'
    ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']
    : [type];
}

async function readIfPresent(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (Error.isError(error) && 'code' in error && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

interface HostMatcher {
  matches(name: string): boolean;
  toString(): string;
}

class HostLine {
  readonly #host: HostMatcher;
  readonly known: KnownKey;

  constructor(host: HostMatcher, known: KnownKey) {
    this.#host = host;
    this.known = known;
  }

  matches(name: string): boolean {
    return this.#host.matches(name);
  }
}

/**
 * A line of SSH_KNOWN_HOSTS FILE FORMAT in sshd(8): `[marker] hosts type
 * base64 [comment]`. A line that cannot be read is skipped, as OpenSSH skips
 * it. An `@cert-authority` line is read and dropped: ssh2 offers no
 * certificate host key algorithm (ADR 0005).
 */
function parseLine(
  text: string,
  file: string,
  line: number,
):
  | { readonly marker: '@revoked' | undefined; readonly line: HostLine }
  | undefined {
  const fields = text.trim().split(/[ \t]+/);
  if (fields[0] === undefined || fields[0] === '' || fields[0].startsWith('#'))
    return undefined;
  let marker: '@revoked' | '@cert-authority' | undefined;
  if (fields[0] === '@revoked' || fields[0] === '@cert-authority') {
    marker = fields[0];
    fields.shift();
  }
  const [hosts, type, blob] = fields;
  if (hosts === undefined || type === undefined || blob === undefined) {
    return undefined;
  }
  if (hosts.startsWith('@') || marker === '@cert-authority') return undefined;
  const key = parseKey(type, blob);
  const host = hosts.startsWith('|')
    ? HashedName.parse(hosts)
    : new Patterns(hosts);
  if (key === undefined || host === undefined) return undefined;
  return { marker, line: new HostLine(host, { key, file, line }) };
}

function parseKey(type: string, blob: string): PublicKey | undefined {
  try {
    const key = PublicKey.parse(Buffer.from(blob, 'base64'));
    return key.type === type ? key : undefined;
  } catch {
    return undefined;
  }
}

/** A comma list of patterns with `*`, `?` and `!`, matched as OpenSSH's `match_hostname` does: without case, on the whole lookup name. */
class Patterns implements HostMatcher {
  readonly #text: string;
  readonly #patterns: readonly {
    readonly negated: boolean;
    readonly glob: string;
  }[];

  constructor(text: string) {
    this.#text = text;
    this.#patterns = text
      .split(',')
      .filter((pattern) => pattern !== '')
      .map((pattern) => {
        const negated = pattern.startsWith('!');
        return {
          negated,
          glob: (negated ? pattern.slice(1) : pattern).toLowerCase(),
        };
      });
  }

  matches(name: string): boolean {
    let matched = false;
    for (const { negated, glob } of this.#patterns) {
      if (!matchPattern(glob, name)) continue;
      if (negated) return false;
      matched = true;
    }
    return matched;
  }

  toString(): string {
    return this.#text;
  }
}

/** `|1|<salt>|<HMAC-SHA1 of the name>`, OpenSSH's HashKnownHosts (`host_hash` in hostfile.c). */
class HashedName implements HostMatcher {
  readonly #salt: Buffer;
  readonly #hash: Buffer;

  private constructor(salt: Buffer, hash: Buffer) {
    this.#salt = salt;
    this.#hash = hash;
  }

  static parse(text: string): HashedName | undefined {
    const [empty, type, salt, hash, ...rest] = text.split('|');
    if (
      empty !== '' ||
      type !== '1' ||
      salt === undefined ||
      hash === undefined ||
      rest.length > 0
    ) {
      return undefined;
    }
    return new HashedName(
      Buffer.from(salt, 'base64'),
      Buffer.from(hash, 'base64'),
    );
  }

  static of(name: string): HashedName {
    const salt = randomBytes(20);
    return new HashedName(salt, hmac(salt, name));
  }

  matches(name: string): boolean {
    const hash = hmac(this.#salt, name);
    return (
      hash.length === this.#hash.length && timingSafeEqual(hash, this.#hash)
    );
  }

  toString(): string {
    return `|1|${this.#salt.toString('base64')}|${this.#hash.toString('base64')}`;
  }
}

function hmac(salt: Buffer, name: string): Buffer {
  return createHmac('sha1', salt).update(name).digest();
}
