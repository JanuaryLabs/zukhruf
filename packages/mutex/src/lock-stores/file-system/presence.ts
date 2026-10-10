import { unlink } from 'node:fs/promises';

import { FileLock, patiently } from '@zukhruf/fs';

import { Caller } from './caller.ts';

/**
 * A caller's presence: the file lock of a file of its own, held from before
 * the caller's record (a lock file, a ticket, or the holder record of
 * `SqliteStore`) appears until after it is gone. The kernel ends it when the
 * caller's process or thread stops, however it stops, so a waiter that can
 * check the file knows the caller is gone.
 */
export class Presence {
  readonly #path: string;
  readonly #lock: FileLock;

  private constructor(path: string, lock: FileLock) {
    this.#path = path;
    this.#lock = lock;
  }

  /** The length of what `pathOf` adds to a record's path. */
  static readonly suffixLength = Presence.pathOf('', Caller.current()).length;

  /** The presence file of `caller`, whose record is at `record`. */
  static pathOf(record: string, caller: Caller): string {
    return `${record}.${caller.id}.presence`;
  }

  static claim(path: string): Presence {
    using opened = new DisposableStack();
    const lock = opened.use(FileLock.open(path));
    if (!lock.tryLock()) {
      throw new Error(
        `The presence file ${JSON.stringify(path)} is locked already, but it belongs to one caller only. Another program opened it.`,
      );
    }
    opened.move();
    return new Presence(path, lock);
  }

  /**
   * Whether `caller`, whom the record at `record` named, still runs. A caller's
   * record goes before its presence file, so a missing presence file is a
   * fault while `stillNamed` says the record names the caller, and means the
   * caller `moved` on when it does not.
   */
  static async judge(
    record: string,
    caller: Caller,
    stillNamed: () => Promise<boolean>,
  ): Promise<'present' | 'gone' | 'moved'> {
    const path = Presence.pathOf(record, caller);
    const state = FileLock.check(path);
    if (state === 'locked') return 'present';
    if (state === 'unlocked') return 'gone';
    if (await stillNamed()) throw Presence.missing(record, path);
    return 'moved';
  }

  /** Whether the caller that `readNamed` reads from the record at `record` still runs. Writes nothing. */
  static async isNamedCallerPresent(
    record: string,
    readNamed: () => Promise<Caller | undefined>,
  ): Promise<boolean> {
    for (;;) {
      const caller = await readNamed();
      if (!caller) return false;
      const state = await Presence.judge(
        record,
        caller,
        async () => (await readNamed())?.id === caller.id,
      );
      if (state !== 'moved') return state === 'present';
    }
  }

  /** Deletes the file of a presence that has ended. */
  static async delete(path: string): Promise<void> {
    try {
      await patiently(() => unlink(path));
    } catch (error) {
      throw new Error(
        `The presence ${JSON.stringify(path)} has ended, but its file could not be deleted. The file locks nothing; delete it by hand.`,
        { cause: error },
      );
    }
  }

  /** A record names a caller whose presence file does not exist, so nobody can tell whether it runs. */
  static missing(record: string, path: string): Error {
    return new Error(
      `The lock record ${JSON.stringify(record)} names a caller with no presence file ${JSON.stringify(path)}. An older version of @zukhruf/mutex wrote the record, or someone deleted the file. Stop every process that uses this lock directory, then delete the record.`,
    );
  }

  /** Lets the kernel lock go. The file stays for whoever removes the caller's record. */
  end(): void {
    this.#lock[Symbol.dispose]();
  }

  /**
   * Removes the caller's record, then ends this presence and deletes its file.
   * A record that cannot be removed stays, but this presence ends anyway, so
   * the record reads as gone and a waiter evicts it.
   */
  async releaseAfter(removeRecord: () => Promise<void>): Promise<void> {
    try {
      await removeRecord();
    } catch (error) {
      this.end();
      throw error;
    }
    this.end();
    await Presence.delete(this.#path);
  }

  /** Ends a presence whose record never appeared, or is gone already. */
  async withdraw(): Promise<void> {
    this.end();
    await Presence.delete(this.#path);
  }
}
