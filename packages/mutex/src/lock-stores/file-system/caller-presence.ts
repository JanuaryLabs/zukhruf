import type { Clock } from '@zukhruf/async';
import { Presence } from '@zukhruf/fs';

import { Caller } from './caller.ts';

/**
 * A caller's presence: the `Presence` of `@zukhruf/fs` on a file of its own,
 * held from before the caller's record (a lock file, a ticket, or the holder
 * record of `SqliteStore`) appears until after it is gone. The kernel ends it
 * when the caller's process or thread stops, however it stops, so a waiter
 * that can check the file knows the caller is gone.
 */
export class CallerPresence {
  readonly #presence: Presence;
  readonly #clock: Clock;

  private constructor(presence: Presence, clock: Clock) {
    this.#presence = presence;
    this.#clock = clock;
  }

  /** The length of what `pathOf` adds to a record's path. */
  static readonly suffixLength = CallerPresence.pathOf('', Caller.current())
    .length;

  /** The presence file of `caller`, whose record is at `record`. */
  static pathOf(record: string, caller: Caller): string {
    return `${record}.${caller.id}.presence`;
  }

  /** Claims the presence of `caller`, whose record is at `record`. */
  static claim(record: string, caller: Caller, clock: Clock): CallerPresence {
    const path = CallerPresence.pathOf(record, caller);
    const presence = Presence.tryOpen(path);
    if (!presence) {
      throw new Error(
        `The presence file ${JSON.stringify(path)} is locked already, but it belongs to one caller only. Another program opened it.`,
      );
    }
    return new CallerPresence(presence, clock);
  }

  /**
   * Whether `caller`, whom the record at `record` named, still runs. A caller's
   * record goes before its presence file, so a missing presence file is a
   * fault while `readNamed` still reads the caller from the record, and means
   * the caller `moved` on when it does not.
   */
  static async judge(
    record: string,
    caller: Caller,
    readNamed: () => Promise<Caller | undefined>,
  ): Promise<'present' | 'gone' | 'moved'> {
    const path = CallerPresence.pathOf(record, caller);
    const state = Presence.check(path);
    if (state === 'present') return 'present';
    if (state === 'ended') return 'gone';
    if ((await readNamed())?.id === caller.id) {
      throw CallerPresence.missing(record, path);
    }
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
      const state = await CallerPresence.judge(record, caller, readNamed);
      if (state !== 'moved') return state === 'present';
    }
  }

  /** Deletes the file of a presence that has ended, while it holds its lock (`Presence.removeIfEnded`). */
  static async delete(path: string, clock: Clock): Promise<void> {
    try {
      await Presence.removeIfEnded(path, { clock });
    } catch (error) {
      throw CallerPresence.#undeletable(path, error);
    }
  }

  /** A record names a caller whose presence file does not exist, so nobody can tell whether it runs. */
  static missing(record: string, path: string): Error {
    return new Error(
      `The lock record ${JSON.stringify(record)} names a caller with no presence file ${JSON.stringify(path)}. An older version of @zukhruf/mutex wrote the record, or someone deleted the file. Stop every process that uses this lock directory, then delete the record.`,
    );
  }

  static #undeletable(path: string, cause: unknown): Error {
    return new Error(
      `The presence ${JSON.stringify(path)} has ended, but its file could not be deleted. The file locks nothing; delete it by hand.`,
      { cause },
    );
  }

  /** Lets the kernel lock go. The file stays for whoever removes the caller's record. */
  end(): void {
    this.#presence[Symbol.dispose]();
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
    await this.withdraw();
  }

  /** Ends a presence whose record never appeared, or is gone already. */
  async withdraw(): Promise<void> {
    try {
      await this.#presence.remove({ clock: this.#clock });
    } catch (error) {
      throw CallerPresence.#undeletable(this.#presence.path, error);
    }
  }
}
