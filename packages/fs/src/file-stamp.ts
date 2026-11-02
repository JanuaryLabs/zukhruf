import { type BigIntStats, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';

import { isErrno } from './errno.ts';

// Absence: no file at the path, or a part of the path that is a file and not
// a folder. A folder that the process may not search is not absence: stat
// fails with EACCES, and that error reaches the caller.
const absent = (error: unknown) =>
  isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR');

/**
 * What the file system says about the file at a path: its device, inode,
 * size, and the times of its last write and its last change, to the
 * nanosecond. A write of the file changes its stamp, also when the writer
 * gives back the old write time, because the kernel sets the change time. A
 * new file at the path changes it too. A missing file has a stamp of its own.
 * Git compares the same stat data to know that a file is unchanged without a
 * read of its content.
 */
export class FileStamp {
  readonly path: string;
  /** When the file was last written; undefined when no file is at the path. */
  readonly modifiedAt: Date | undefined;
  readonly #value: string;

  private constructor(path: string, stats: BigIntStats | undefined) {
    this.path = path;
    this.modifiedAt =
      stats === undefined
        ? undefined
        : new Date(Number(stats.mtimeNs / 1_000_000n));
    this.#value =
      stats === undefined
        ? 'missing'
        : `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
  }

  static async read(path: string): Promise<FileStamp> {
    try {
      return new FileStamp(path, await stat(path, { bigint: true }));
    } catch (error) {
      if (absent(error)) return new FileStamp(path, undefined);
      throw error;
    }
  }

  static readSync(path: string): FileStamp {
    try {
      return new FileStamp(path, statSync(path, { bigint: true }));
    } catch (error) {
      if (absent(error)) return new FileStamp(path, undefined);
      throw error;
    }
  }

  equals(other: FileStamp): boolean {
    return this.path === other.path && this.#value === other.#value;
  }

  toString(): string {
    return this.#value;
  }
}
