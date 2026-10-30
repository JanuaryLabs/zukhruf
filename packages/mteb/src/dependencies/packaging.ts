import { compareStrings } from './python.ts';

// packaging 26.3 (packaging.version): the PEP 440 versions that MTEB reads in
// result files.

type KeyPart = number | string | readonly KeyPart[];

function compareKeys(left: KeyPart, right: KeyPart): number {
  if (Array.isArray(left) && Array.isArray(right)) {
    for (const [index, item] of left.entries()) {
      const other: KeyPart | undefined = right[index];
      if (other === undefined) break;
      const order = compareKeys(item, other);
      if (order !== 0) return order;
    }
    return left.length - right.length;
  }
  if (typeof left === 'string' && typeof right === 'string')
    return compareStrings(left, right);
  // A sentinel (an infinity) against a tuple compares as a number.
  const a = typeof left === 'number' ? left : 0;
  const b = typeof right === 'number' ? right : 0;
  return a === b ? 0 : a < b ? -1 : 1;
}

const PRE_LETTERS: Readonly<Record<string, string>> = {
  alpha: 'a',
  a: 'a',
  beta: 'b',
  b: 'b',
  c: 'rc',
  pre: 'rc',
  preview: 'rc',
  rc: 'rc',
};

const VERSION_PATTERN =
  /^\s*v?(?:(?:(?<epoch>[0-9]+)!)?(?<release>[0-9]+(?:\.[0-9]+)*)(?<pre>[-_.]?(?<pre_l>alpha|a|beta|b|preview|pre|c|rc)[-_.]?(?<pre_n>[0-9]+)?)?(?<post>(?:-(?<post_n1>[0-9]+))|(?:[-_.]?(?<post_l>post|rev|r)[-_.]?(?<post_n2>[0-9]+)?))?(?<dev>[-_.]?(?<dev_l>dev)[-_.]?(?<dev_n>[0-9]+)?)?)(?:\+(?<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/iu;

// packaging.version.Version of Python: a PEP 440 version, its normal form
// and its order.
export class Version {
  readonly epoch: number;
  readonly release: readonly number[];
  readonly pre: readonly [string, number] | null;
  readonly post: number | null;
  readonly dev: number | null;
  readonly local: string | null;

  private constructor(fields: {
    epoch: number;
    release: number[];
    pre: [string, number] | null;
    post: number | null;
    dev: number | null;
    local: string | null;
  }) {
    this.epoch = fields.epoch;
    this.release = fields.release;
    this.pre = fields.pre;
    this.post = fields.post;
    this.dev = fields.dev;
    this.local = fields.local;
  }

  static parse(text: string): Version {
    const version = Version.tryParse(text);
    if (version === null) throw new Error(`Invalid version: '${text}'`);
    return version;
  }

  static tryParse(text: string): Version | null {
    const match = VERSION_PATTERN.exec(text);
    if (match?.groups === undefined) return null;
    const groups = match.groups;
    const number = (value: string | undefined): number =>
      value === undefined ? 0 : Number(value);
    const preLetter = groups['pre_l']?.toLowerCase();
    return new Version({
      epoch: number(groups['epoch']),
      release: (groups['release'] ?? '').split('.').map(Number),
      pre:
        preLetter === undefined
          ? null
          : [PRE_LETTERS[preLetter] ?? preLetter, number(groups['pre_n'])],
      post:
        groups['post'] === undefined
          ? null
          : number(groups['post_n1'] ?? groups['post_n2']),
      dev: groups['dev'] === undefined ? null : number(groups['dev_n']),
      local: groups['local']?.toLowerCase().replaceAll(/[-_.]/gu, '.') ?? null,
    });
  }

  toString(): string {
    return [
      this.epoch === 0 ? '' : `${this.epoch}!`,
      this.release.join('.'),
      this.pre === null ? '' : `${this.pre[0]}${this.pre[1]}`,
      this.post === null ? '' : `.post${this.post}`,
      this.dev === null ? '' : `.dev${this.dev}`,
      this.local === null ? '' : `+${this.local}`,
    ].join('');
  }

  // Negative when this version is lower than other, 0 when equal.
  compare(other: Version): number {
    return compareKeys(this.#key(), other.#key());
  }

  // packaging's _cmpkey: the release without its trailing zeros, a version
  // with only a dev part before its pre-releases, and a missing pre, post or
  // dev part at the side that sorts a final release after its pre-releases.
  #key(): KeyPart[] {
    const release = [...this.release];
    while (release.length > 0 && release.at(-1) === 0) release.pop();
    const pre: KeyPart =
      this.pre === null && this.post === null && this.dev !== null
        ? -Infinity
        : this.pre === null
          ? Infinity
          : [this.pre[0], this.pre[1]];
    return [
      this.epoch,
      release,
      pre,
      this.post ?? -Infinity,
      this.dev ?? Infinity,
      this.local === null
        ? -Infinity
        : this.local
            .split('.')
            .map((part) =>
              /^\d+$/u.test(part) ? [Number(part), ''] : [-Infinity, part],
            ),
    ];
  }
}
