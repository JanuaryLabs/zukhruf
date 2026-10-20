/** One entry for tarArchive(): a regular file or a directory. */
export interface TarWriterEntry {
  /** The name in the archive, relative, with '/' between its parts. */
  path: string;
  type: 'file' | 'directory';
  /** The bytes of a file; empty for a directory. */
  data: Uint8Array;
  mode: number;
  uid: number;
  gid: number;
  /** Seconds since the Unix epoch. */
  mtime: number;
}

const BLOCK = 512;
const NAME_LENGTH = 100;
const PREFIX_LENGTH = 155;
/** The highest value of an octal field of 12 bytes: 11 digits. 8 GiB - 1 for a size. */
const MAX_SIZE = 0o77777777777;
/** The highest value of an octal field of 8 bytes: 7 digits. */
const MAX_ID = 0o7777777;

const encoder = new TextEncoder();

/** The ustar name and prefix of a path, or undefined when the path needs a PAX header. */
function ustarName(path: string): { name: string; prefix: string } | undefined {
  if (encoder.encode(path).byteLength <= NAME_LENGTH) {
    return { name: path, prefix: '' };
  }
  for (let slash = path.indexOf('/'); slash !== -1;) {
    const prefix = path.slice(0, slash);
    const name = path.slice(slash + 1);
    if (encoder.encode(prefix).byteLength > PREFIX_LENGTH) return undefined;
    if (name !== '' && encoder.encode(name).byteLength <= NAME_LENGTH) {
      return { name, prefix };
    }
    slash = path.indexOf('/', slash + 1);
  }
  return undefined;
}

/** One PAX record: "<length> <key>=<value>\n", where the length counts itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyLength = encoder.encode(body).byteLength;
  let length = bodyLength + String(bodyLength).length;
  if (String(length).length !== String(bodyLength).length) {
    length = bodyLength + String(length).length;
  }
  return `${length}${body}`;
}

function writeText(
  header: Uint8Array,
  offset: number,
  length: number,
  text: string,
): void {
  header.set(encoder.encode(text).subarray(0, length), offset);
}

/** An octal number with leading zeros and a NUL, in a field of `length` bytes. */
function writeOctal(
  header: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  writeText(
    header,
    offset,
    length - 1,
    value.toString(8).padStart(length - 1, '0'),
  );
}

interface HeaderFields {
  name: string;
  prefix: string;
  type: string;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
}

function header(fields: HeaderFields): Uint8Array {
  const block = new Uint8Array(BLOCK);
  writeText(block, 0, NAME_LENGTH, fields.name);
  writeOctal(block, 100, 8, fields.mode & 0o7777);
  writeOctal(block, 108, 8, fields.uid);
  writeOctal(block, 116, 8, fields.gid);
  writeOctal(block, 124, 12, fields.size);
  writeOctal(block, 136, 12, fields.mtime);
  writeText(block, 156, 1, fields.type);
  writeText(block, 257, 6, 'ustar\0');
  writeText(block, 263, 2, '00');
  writeText(block, 345, PREFIX_LENGTH, fields.prefix);
  // The checksum counts its own field as eight spaces.
  block.fill(0x20, 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  writeText(block, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

function padding(size: number): Uint8Array {
  return new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);
}

/** The blocks of one entry: a PAX header when a field does not fit ustar, the header, the data and its padding. */
function entryBlocks(entry: TarWriterEntry): Uint8Array[] {
  const path = entry.type === 'directory' ? `${entry.path}/` : entry.path;
  const size = entry.type === 'directory' ? 0 : entry.data.byteLength;
  const fitted = ustarName(path);
  const records = [
    fitted === undefined ? paxRecord('path', path) : '',
    size > MAX_SIZE ? paxRecord('size', String(size)) : '',
    entry.uid > MAX_ID ? paxRecord('uid', String(entry.uid)) : '',
    entry.gid > MAX_ID ? paxRecord('gid', String(entry.gid)) : '',
  ].join('');
  const blocks: Uint8Array[] = [];
  const fields: HeaderFields = {
    // A reader that knows no PAX gets the first bytes of the path.
    name: fitted?.name ?? path.slice(0, NAME_LENGTH),
    prefix: fitted?.prefix ?? '',
    type: entry.type === 'directory' ? '5' : '0',
    size: Math.min(size, MAX_SIZE),
    mode: entry.mode,
    uid: Math.min(entry.uid, MAX_ID),
    gid: Math.min(entry.gid, MAX_ID),
    mtime: entry.mtime,
  };
  if (records !== '') {
    const data = encoder.encode(records);
    blocks.push(
      header({
        ...fields,
        name: `PaxHeaders/${fields.name}`.slice(0, NAME_LENGTH),
        prefix: '',
        type: 'x',
        size: data.byteLength,
        mode: 0o644,
      }),
      data,
      padding(data.byteLength),
    );
  }
  blocks.push(header(fields));
  if (size > 0) blocks.push(entry.data, padding(size));
  return blocks;
}

/** A ustar archive of the entries, with a PAX header for a long path, a large size or a large owner, and two zero blocks at its end. */
export function tarArchive(entries: TarWriterEntry[]): Uint8Array {
  const blocks = [...entries.flatMap(entryBlocks), new Uint8Array(BLOCK * 2)];
  const archive = new Uint8Array(
    blocks.reduce((total, block) => total + block.byteLength, 0),
  );
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.byteLength;
  }
  return archive;
}
