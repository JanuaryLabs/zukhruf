import { DockerError } from './errors.ts';

/** One entry of a tar archive, with its bytes. */
export interface TarEntry {
  /** The name in the archive, without a trailing '/'. */
  path: string;
  /** 'link' is a hard link; 'other' is a device, a FIFO or another kind. */
  type: 'file' | 'directory' | 'symlink' | 'link' | 'other';
  mode: number;
  uid: number;
  gid: number;
  /** Seconds since the Unix epoch. */
  mtime: number;
  /** The target of a symlink or of a hard link; '' for each other entry. */
  linkTarget: string;
  data: Uint8Array;
}

const BLOCK = 512;
const decoder = new TextDecoder();

/** Reads blocks of a given length from a stream of chunks of each length. */
class ByteReader {
  readonly #chunks: AsyncIterator<Uint8Array>;
  #pending: Uint8Array[] = [];
  #length = 0;

  constructor(chunks: AsyncIterable<Uint8Array>) {
    this.#chunks = chunks[Symbol.asyncIterator]();
  }

  /** The next `length` bytes, or undefined when the stream ends first. */
  async read(length: number): Promise<Uint8Array | undefined> {
    while (this.#length < length) {
      const next = await this.#chunks.next();
      if (next.done === true) return undefined;
      this.#pending.push(next.value);
      this.#length += next.value.byteLength;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const [first, ...rest] = this.#pending;
      if (first === undefined) break;
      const part = first.subarray(0, length - offset);
      bytes.set(part, offset);
      offset += part.byteLength;
      this.#pending =
        part.byteLength === first.byteLength
          ? rest
          : [first.subarray(part.byteLength), ...rest];
    }
    this.#length -= length;
    return bytes;
  }

  /** Stops the stream of chunks. */
  async close(): Promise<void> {
    await this.#chunks.return?.();
  }
}

function text(block: Uint8Array, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

/** An octal field, or a base-256 field (GNU) when its first byte has the high bit. */
function number(block: Uint8Array, offset: number, length: number): number {
  const field = block.subarray(offset, offset + length);
  if (((field[0] ?? 0) & 0x80) !== 0) {
    return field
      .subarray(1)
      .reduce((value, byte) => value * 256 + byte, (field[0] ?? 0) & 0x7f);
  }
  const digits = text(block, offset, length).trim();
  return digits === '' ? 0 : Number.parseInt(digits, 8);
}

function checksumHolds(block: Uint8Array): boolean {
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  }
  return sum === number(block, 148, 8);
}

/** The records of a PAX header: "<length> <key>=<value>\n" each. */
function paxRecords(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.byteLength) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(
      decoder.decode(data.subarray(offset, space)),
      10,
    );
    if (!Number.isInteger(length) || length <= 0) break;
    const record = decoder.decode(
      data.subarray(space + 1, offset + length - 1),
    );
    const equals = record.indexOf('=');
    if (equals !== -1) {
      records.set(record.slice(0, equals), record.slice(equals + 1));
    }
    offset += length;
  }
  return records;
}

function typeOf(flag: string): TarEntry['type'] {
  if (flag === '0' || flag === '' || flag === '7') return 'file';
  if (flag === '5') return 'directory';
  if (flag === '2') return 'symlink';
  if (flag === '1') return 'link';
  return 'other';
}

/**
 * The entries of a tar archive, as the chunks come. It takes ustar, PAX
 * headers for one entry ('x'), and the GNU long name ('L') and long link
 * ('K'). It skips a global PAX header ('g'). Each entry comes with its bytes.
 */
export async function* tarEntries(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<TarEntry> {
  const reader = new ByteReader(chunks);
  try {
    let pax = new Map<string, string>();
    let longName: string | undefined;
    let longLink: string | undefined;
    for (;;) {
      const block = await reader.read(BLOCK);
      if (block === undefined || block.every((byte) => byte === 0)) return;
      if (!checksumHolds(block)) {
        throw new DockerError(
          'The tar archive has a header with a bad checksum.',
        );
      }
      const flag = text(block, 156, 1);
      const paxSize = pax.get('size');
      const size =
        paxSize === undefined ? number(block, 124, 12) : Number(paxSize);
      const data = await reader.read(size + ((BLOCK - (size % BLOCK)) % BLOCK));
      if (data === undefined) {
        throw new DockerError('The tar archive ends inside an entry.');
      }
      const body = data.subarray(0, size);
      if (flag === 'x') {
        pax = paxRecords(body);
        continue;
      }
      if (flag === 'g') continue;
      if (flag === 'L' || flag === 'K') {
        const value = text(body, 0, body.byteLength);
        if (flag === 'L') longName = value;
        else longLink = value;
        continue;
      }
      const prefix =
        text(block, 257, 5) === 'ustar' ? text(block, 345, 155) : '';
      const name = text(block, 0, 100);
      const path =
        pax.get('path') ?? longName ?? (prefix ? `${prefix}/${name}` : name);
      const paxNumber = (key: string, fallback: number) => {
        const value = pax.get(key);
        return value === undefined ? fallback : Number(value);
      };
      yield {
        path: path.endsWith('/') ? path.slice(0, -1) : path,
        type: typeOf(flag),
        mode: number(block, 100, 8),
        uid: paxNumber('uid', number(block, 108, 8)),
        gid: paxNumber('gid', number(block, 116, 8)),
        mtime: Math.floor(paxNumber('mtime', number(block, 136, 12))),
        linkTarget: pax.get('linkpath') ?? longLink ?? text(block, 157, 100),
        data: body,
      };
      pax = new Map();
      longName = undefined;
      longLink = undefined;
    }
  } finally {
    await reader.close();
  }
}
