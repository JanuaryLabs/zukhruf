import { FileStamp } from './file-stamp.ts';

/**
 * The stamps of several files that change together, such as a database and
 * its journal, or the files of one store. A write of any of them changes the
 * whole. A missing file is a part of it, so its return is a change too.
 */
export class FileStamps {
  readonly stamps: readonly FileStamp[];

  private constructor(stamps: readonly FileStamp[]) {
    this.stamps = stamps;
  }

  static async read(paths: readonly string[]): Promise<FileStamps> {
    return new FileStamps(await Promise.all(paths.map(FileStamp.read)));
  }

  static readSync(paths: readonly string[]): FileStamps {
    return new FileStamps(paths.map(FileStamp.readSync));
  }

  /** When the newest of the files was written; undefined when none is present. */
  get modifiedAt(): Date | undefined {
    const times = this.stamps.flatMap(({ modifiedAt }) =>
      modifiedAt === undefined ? [] : [modifiedAt.getTime()],
    );
    return times.length === 0 ? undefined : new Date(Math.max(...times));
  }

  equals(other: FileStamps): boolean {
    return this.toString() === other.toString();
  }

  toString(): string {
    return this.stamps.map((stamp) => `${stamp.path}=${stamp}`).join('\n');
  }
}
