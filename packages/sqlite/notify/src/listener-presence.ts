import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Clock } from '@zukhruf/async';
import { Presence } from '@zukhruf/fs';

/**
 * A listener's presence: the `Presence` of `@zukhruf/fs` on its own file
 * beside the database, held from before its row is inserted until after its
 * row is removed (ADR 0011). The kernel frees the lock when the listener's
 * process stops, however it stops. So a sender whose connect is refused knows
 * from the presence whether the listener is dead or only accepts nothing now.
 */
export class ListenerPresence {
  readonly #presence: Presence;
  readonly #clock: Clock;

  private constructor(presence: Presence, clock: Clock) {
    this.#presence = presence;
    this.#clock = clock;
  }

  /** The presence file of the listener `id` of the database at `database`: `<database>.listeners/<id>.presence`. */
  static #pathOf(database: string, id: string): string {
    return `${database}.listeners/${id}.presence`;
  }

  /** Takes the presence of a new listener. Its id is new, so no other program knows the file yet. */
  static async take(
    database: string,
    id: string,
    clock: Clock,
  ): Promise<ListenerPresence> {
    const path = ListenerPresence.#pathOf(database, id);
    await mkdir(dirname(path), { recursive: true });
    const presence = Presence.tryOpen(path);
    if (!presence) {
      throw new Error(
        `The presence file ${JSON.stringify(path)} is locked already, but it belongs to one listener only. Another program opened it.`,
      );
    }
    return new ListenerPresence(presence, clock);
  }

  /** Whether the listener `id` lives. A listener of an older release has no file, and counts as dead. */
  static lives(database: string, id: string): boolean {
    return Presence.check(ListenerPresence.#pathOf(database, id)) === 'present';
  }

  /** Deletes the presence file of a dead listener, while it holds its lock. A listener of an older release has no file, and maybe no folder. */
  static async removeIfEnded(
    database: string,
    id: string,
    clock: Clock,
  ): Promise<void> {
    await Presence.removeIfEnded(ListenerPresence.#pathOf(database, id), {
      clock,
    });
  }

  /** Ends the presence and deletes its file (`Presence.remove`). */
  async end(): Promise<void> {
    await this.#presence.remove({ clock: this.#clock });
  }
}
