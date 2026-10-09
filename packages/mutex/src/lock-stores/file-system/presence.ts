import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import { patiently } from '@zukhruf/fs';

import { isBusy } from '../../shared/sqlite/is-busy.ts';
import { isCantOpen } from '../../shared/sqlite/is-cant-open.ts';
import { Caller } from './caller.ts';

/** Garbage collection closes a connection nobody references, which would end a presence its caller still holds. */
const open = new Set<DatabaseSync>();

/**
 * A caller's presence: an exclusive SQLite transaction on a file of its own,
 * held from before the caller's record (a lock file, a ticket, or the holder
 * record of `SqliteStore`) appears until after it is gone. The kernel ends it
 * when the caller's process or thread stops, however it stops, so a waiter
 * that can read the file knows the caller is gone. Nothing may open the file
 * except through SQLite: closing any other handle to it drops this process's
 * lock without a word.
 */
export class Presence {
  readonly #path: string;
  readonly #database: DatabaseSync;

  private constructor(path: string, database: DatabaseSync) {
    this.#path = path;
    this.#database = database;
  }

  /** The length of what `pathOf` adds to a record's path. */
  static readonly suffixLength = Presence.pathOf('', Caller.current()).length;

  /** The presence file of `caller`, whose record is at `record`. */
  static pathOf(record: string, caller: Caller): string {
    return `${record}.${caller.id}.presence`;
  }

  static claim(path: string): Presence {
    const database = new DatabaseSync(path, { timeout: 0 });
    try {
      // A journal on disk would outlive a caller that dies while present.
      database.exec('PRAGMA journal_mode = MEMORY');
      database.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      database.close();
      throw error;
    }
    open.add(database);
    return new Presence(path, database);
  }

  /**
   * Whether the caller behind `path` still runs. Reading needs a lock that the
   * caller's exclusive transaction refuses, and opening read-only never creates
   * the file.
   */
  static check(path: string): 'present' | 'gone' | 'missing' {
    let database: DatabaseSync;
    try {
      database = new DatabaseSync(path, { readOnly: true, timeout: 0 });
    } catch (error) {
      // A file that exists but cannot be opened is a fault, not a missing presence.
      if (isCantOpen(error) && !existsSync(path)) return 'missing';
      throw error;
    }
    try {
      database.prepare('SELECT count(*) FROM sqlite_schema').get();
      return 'gone';
    } catch (error) {
      if (isBusy(error)) return 'present';
      throw error;
    } finally {
      database.close();
    }
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
    const state = Presence.check(path);
    if (state !== 'missing') return state;
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
    open.delete(this.#database);
    this.#database.exec('ROLLBACK');
    this.#database.close();
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
