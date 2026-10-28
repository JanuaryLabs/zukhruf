import { statSync } from 'node:fs';

import { UnavailableError } from './unavailable-error.ts';

// A missing file, or one in a folder whose mode denies this process. macOS
// privacy controls do not deny it: they stop a read of the file and a list of
// its folder with EPERM, but not stat of the file.
const unreadable = new Set(['ENOENT', 'EACCES']);

// The owner writes a database through its file and its WAL, so the later of
// their times is when it last wrote. A reader writes the shared-memory index
// (-shm) too, so its time does not count. The owner may remove the WAL when
// it closes, and a reader that opens the database then makes an empty one,
// timed as it reads; an empty WAL holds nothing the file does not, so only a
// WAL with frames counts.
export function lastWrite(path: string): Date {
  try {
    const file = statSync(path).mtimeMs;
    const wal = statSync(`${path}-wal`, { throwIfNoEntry: false });
    return new Date(
      wal !== undefined && wal.size > 0 ? Math.max(file, wal.mtimeMs) : file,
    );
  } catch (cause) {
    if (
      cause instanceof Error &&
      'code' in cause &&
      unreadable.has(String(cause.code))
    )
      throw new UnavailableError(path, { cause });
    throw cause;
  }
}
