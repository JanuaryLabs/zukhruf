import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * How far a pass read the owner's WAL: the salt of the WAL's header, which a
 * reset changes, and the number of frames up to its last commit.
 */
export type WalProgress = { readonly salt: string; readonly frames: number };

/**
 * The pages that the frames after a saved progress wrote, and the newest
 * frame of each page, so a reader can read a page as the commits left it.
 */
export type ChangedPages = {
  readonly pages: ReadonlySet<number>;
  readonly pageSize: number;
  // The file offset of the content of the newest frame of each page.
  readonly newest: ReadonlyMap<number, number>;
};

/**
 * What the owner's WAL tells now. `changed` is null when a reader cannot tell
 * what changed since the saved progress: no WAL, no progress, or a reset
 * since, so it reads every table.
 */
export type WalFrames =
  | { readonly progress: null; readonly changed: null }
  | {
      readonly progress: WalProgress;
      readonly changed: ChangedPages | null;
    };

const headerSize = 32;
const frameHeaderSize = 24;

// The WAL file format (https://www.sqlite.org/fileformat2.html#walformat):
// all numbers are big-endian. A frame is valid when its salts are the
// header's; a frame with a commit size above 0 ends a transaction.
export function walFrames(
  databasePath: string,
  saved: WalProgress | null,
): WalFrames {
  const none = { progress: null, changed: null } as const;
  return withWal(databasePath, none, (fd, size) => {
    const header = readHeader(fd, size);
    if (header === null) return none;
    const frameSize = frameHeaderSize + header.pageSize;
    const frame = Buffer.alloc(frameHeaderSize);
    const pages: number[] = [];
    let committed = 0;
    for (let at = 0; headerSize + (at + 1) * frameSize <= size; at++) {
      readSync(fd, frame, 0, frameHeaderSize, headerSize + at * frameSize);
      if (`${frame.readUInt32BE(8)}:${frame.readUInt32BE(12)}` !== header.salt)
        break;
      pages.push(frame.readUInt32BE(0));
      if (frame.readUInt32BE(4) > 0) committed = at + 1;
    }
    const progress = { salt: header.salt, frames: committed };
    if (
      saved === null ||
      saved.salt !== header.salt ||
      saved.frames > committed
    )
      return { progress, changed: null };
    const newest = new Map<number, number>();
    for (const [at, page] of pages.slice(0, committed).entries())
      newest.set(page, headerSize + at * frameSize + frameHeaderSize);
    return {
      progress,
      changed: {
        pages: new Set(pages.slice(saved.frames, committed)),
        pageSize: header.pageSize,
        newest,
      },
    };
  });
}

/** The salt of the owner's WAL now, or null when it has no header. */
export function walSalt(databasePath: string): string | null {
  return withWal(
    databasePath,
    null,
    (fd, size) => readHeader(fd, size)?.salt ?? null,
  );
}

function readHeader(
  fd: number,
  size: number,
): { readonly pageSize: number; readonly salt: string } | null {
  if (size < headerSize) return null;
  const header = Buffer.alloc(headerSize);
  readSync(fd, header, 0, headerSize, 0);
  return {
    pageSize: header.readUInt32BE(8),
    salt: `${header.readUInt32BE(16)}:${header.readUInt32BE(20)}`,
  };
}

// Reads the owner's WAL, or gives absent when the owner has none.
function withWal<T>(
  databasePath: string,
  absent: T,
  read: (fd: number, size: number) => T,
): T {
  let fd: number;
  try {
    fd = openSync(`${databasePath}-wal`, 'r');
  } catch (error) {
    if (Error.isError(error) && 'code' in error && error.code === 'ENOENT')
      return absent;
    throw error;
  }
  try {
    return read(fd, fstatSync(fd).size);
  } finally {
    closeSync(fd);
  }
}
