import { DatabaseSync, type StatementSync } from 'node:sqlite';

// The error the caller throws when the file is missing or the system denies
// access, naming what the caller needs to read it.
export type UnavailableError = new (path: string, cause: unknown) => Error;

// SQLite's CANTOPEN, for a missing file or one the system denies, and AUTH.
// Any other failure is not one that access can fix.
const unavailableCodes = new Set([14, 23]);

function open(path: string, unavailable: UnavailableError): DatabaseSync {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (cause) {
    if (
      cause instanceof Error &&
      'errcode' in cause &&
      unavailableCodes.has(Number(cause.errcode))
    )
      throw new unavailable(path, cause);
    throw cause;
  }
}

// The owner commits through a WAL it keeps open, and file-change events
// report a write only when the file closes. SQLite's data_version changes on
// every commit by another connection, so polling current sees each one.
export class DataVersion implements Disposable {
  readonly #database: DatabaseSync;
  readonly #version: StatementSync;

  constructor(path: string, unavailable: UnavailableError) {
    this.#database = open(path, unavailable);
    this.#version = this.#database.prepare('PRAGMA data_version');
  }

  get current(): number {
    return Number(this.#version.get()?.data_version);
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}
