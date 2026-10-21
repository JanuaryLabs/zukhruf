import { statSync } from 'node:fs';

import type { UnavailableError } from './data-version.ts';

// A missing file, or one in a folder whose mode denies this process. macOS
// privacy controls do not deny it: they stop a read of the file and a list of
// its folder with EPERM, but not stat of the file.
const unreadable = new Set(['ENOENT', 'EACCES']);

// The owner writes a database through its file and its WAL, so the later of
// their times is when it last wrote. A reader writes the shared-memory index
// (-shm) too, so its time does not count. The owner may remove the WAL when
// it closes; the file stays.
export function lastWrite(path: string, unavailable: UnavailableError): Date {
  try {
    const file = statSync(path).mtimeMs;
    const wal =
      statSync(`${path}-wal`, { throwIfNoEntry: false })?.mtimeMs ?? file;
    return new Date(Math.max(file, wal));
  } catch (cause) {
    if (
      cause instanceof Error &&
      'code' in cause &&
      unreadable.has(String(cause.code))
    )
      throw new unavailable(path, cause);
    throw cause;
  }
}
