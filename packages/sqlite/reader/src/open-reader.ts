import { DatabaseSync } from 'node:sqlite';

import { UnavailableError } from './unavailable-error.ts';

// A read-only connection to a database that another process owns.
export function openReader(path: string): DatabaseSync {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (cause) {
    if (
      cause instanceof Error &&
      'errcode' in cause &&
      // SQLite's CANTOPEN (14). A missing or denied file fails the open()
      // syscall, and SQLite reports that as CANTOPEN, a privacy denial too.
      // SQLite gives AUTH only for an authorizer, and this private connection
      // has none. Any other failure is not one that access can fix.
      cause.errcode === 14
    )
      throw new UnavailableError(path, cause);
    throw cause;
  }
}
