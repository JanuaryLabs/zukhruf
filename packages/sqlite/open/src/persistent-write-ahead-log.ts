import { readdirSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import type { Journal } from './journal.ts';
import { type PageSize, WriteAheadLog } from './write-ahead-log.ts';

// The native libraries are at the package root, so this file finds them from
// src/ in the tests and from dist/ in the package (ADR 0006).
const lib = new URL('../lib/', import.meta.url);
const suffixes: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'dylib',
  linux: 'so',
  win32: 'dll',
};

/**
 * A write-ahead log whose -wal and -shm files stay after the last connection
 * closes, for readers that cannot write the folder (ADR 0003).
 */
export class PersistentWriteAheadLog implements Journal {
  readonly #log: WriteAheadLog;

  constructor(options: { readonly pageSize?: PageSize } = {}) {
    this.#log = new WriteAheadLog(options);
  }

  apply(database: DatabaseSync): void {
    const platform = `${process.platform}-${process.arch}`;
    const library = new URL(
      `${platform}/persist_wal.${suffixes[process.platform]}`,
      lib,
    );
    try {
      database.loadExtension(fileURLToPath(library));
    } catch (cause) {
      if (
        !(cause instanceof Error) ||
        !('code' in cause) ||
        cause.code !== 'ERR_LOAD_SQLITE_EXTENSION'
      )
        throw cause;
      throw new Error(
        `@zukhruf/sqlite-open has no native library for ${platform}. It has one for ${readdirSync(lib).join(', ')}.`,
        { cause },
      );
    }
    this.#log.apply(database);
  }
}
