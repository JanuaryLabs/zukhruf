import { mkdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type { Clock } from '@zukhruf/async';
import { Presence } from '@zukhruf/fs';

/**
 * A caller's presence: the `Presence` of `@zukhruf/fs` on its own file beside
 * the store, held from before its Pool serves its pipe until after the pipe
 * closes. The kernel frees the lock when the caller's process stops, however
 * it stops. So an owner whose connect is refused knows from the presence
 * whether the caller is gone or only accepts nothing now (#5424). A recorded
 * copy of the ListenerPresence of `@zukhruf/sqlite-notify`
 * (docs/copied-code.md).
 */
export class CallerPresence {
  readonly #presence: Presence;
  readonly #clock: Clock;

  private constructor(presence: Presence, clock: Clock) {
    this.#presence = presence;
    this.#clock = clock;
  }

  /** The presence file of the caller at `address` on the store at `store`: `<store>.callers/<last part of the address>.presence`. */
  static #pathOf(store: string, address: string): string {
    return `${store}.callers/${basename(address)}.presence`;
  }

  /** Takes the presence of a new caller. Its address is new, so no other program knows the file yet. */
  static async take(
    store: string,
    address: string,
    clock: Clock,
  ): Promise<CallerPresence> {
    const path = CallerPresence.#pathOf(store, address);
    await mkdir(dirname(path), { recursive: true });
    const presence = Presence.tryOpen(path);
    if (!presence) {
      throw new Error(
        `The presence file ${JSON.stringify(path)} is locked already, but it belongs to one caller only. Another program opened it.`,
      );
    }
    return new CallerPresence(presence, clock);
  }

  /** Whether the caller at `address` lives. A caller of an older release has no file, and counts as gone. */
  static lives(store: string, address: string): boolean {
    return Presence.check(CallerPresence.#pathOf(store, address)) === 'present';
  }

  /** Deletes the presence file of a gone caller, while it holds its lock. A caller of an older release has no file, and maybe no folder. */
  static async removeIfEnded(
    store: string,
    address: string,
    clock: Clock,
  ): Promise<void> {
    await Presence.removeIfEnded(CallerPresence.#pathOf(store, address), {
      clock,
    });
  }

  /** Ends the presence and deletes its file (`Presence.remove`). */
  async end(): Promise<void> {
    await this.#presence.remove({ clock: this.#clock });
  }
}
