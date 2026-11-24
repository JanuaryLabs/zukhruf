import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';

import type { Clock } from '@zukhruf/async';
import { Presence, atomicWrite, isErrno, patiently } from '@zukhruf/fs';

import { isRecord } from '../../shared/is-record.ts';

/** How long a new session tries to open its presence while a recovery holds the file for a moment, as long as `patiently` of `@zukhruf/fs` tries. */
const PRESENCE_PATIENCE = 1000;

/** What a session writes in its record. No step of the lock store reads `processId`: it is for a person who reads the directory. */
interface SessionRecordContent {
  leaseDuration: number;
  processId: number;
}

/**
 * The folder `sessions` of a socket store's directory: one record and one
 * presence for each live store (ADR 0033). A session takes its presence, a
 * kernel lock on `<id>.presence`, before its record `<id>.json` appears, and
 * frees it only after the record is gone. So a record whose presence is free
 * belongs to a session that stopped, and that session never comes back: its
 * id is new for each store.
 */
export class SessionDirectory {
  readonly #path: string;
  readonly #clock: Clock;

  constructor(directory: string, clock: Clock) {
    this.#path = join(directory, 'sessions');
    this.#clock = clock;
  }

  /** Takes the presence of `session`, then writes its record. Disposing the result deletes the record, then removes the presence. */
  async record(session: string, leaseDuration: number): Promise<SessionRecord> {
    await mkdir(this.#path, { recursive: true });
    const presence = await this.#takePresence(session);
    try {
      const content: SessionRecordContent = {
        leaseDuration,
        processId: process.pid,
      };
      await atomicWrite(this.#recordPath(session), JSON.stringify(content), {
        clock: this.#clock,
      });
    } catch (error) {
      await presence.remove({ clock: this.#clock });
      throw error;
    }
    return new SessionRecord(this.#recordPath(session), presence, this.#clock);
  }

  /**
   * The listing of a recovery: each recorded session that still runs, with
   * its lease duration. `own` is the session of the lock server, which lives,
   * so its presence is not checked. It deletes the files of each session that
   * stopped, and each presence file that has no record and no lock.
   */
  async recover(own: string): Promise<Map<string, number>> {
    const recovering = new Map<string, number>();
    for (const [session, files] of await this.#list()) {
      if (files.record) {
        if (session !== own && (await this.endIfStopped(session))) continue;
        const leaseDuration = await this.#leaseDuration(session);
        if (leaseDuration !== undefined) {
          recovering.set(session, leaseDuration);
        }
      } else if (files.presence) {
        await Presence.removeIfEnded(this.#presencePath(session), {
          clock: this.#clock,
        });
      }
    }
    return recovering;
  }

  /**
   * Whether `session` stopped: its presence is free. Then its record and its
   * presence file are deleted. A frozen session still holds its presence.
   */
  async endIfStopped(session: string): Promise<boolean> {
    const presence = this.#presencePath(session);
    if (Presence.check(presence) === 'present') return false;
    await deleteFile(this.#recordPath(session), this.#clock);
    await Presence.removeIfEnded(presence, { clock: this.#clock });
    return true;
  }

  #recordPath(session: string) {
    return join(this.#path, `${session}.json`);
  }

  #presencePath(session: string) {
    return join(this.#path, `${session}.presence`);
  }

  /**
   * Takes a new presence. A recovery that found the file before the lock
   * holds it for a moment while it checks or deletes it, so the open is
   * tried again on each turn, for at most 1 second on the clock, as
   * `patiently` of `@zukhruf/fs` allows Windows.
   */
  async #takePresence(session: string): Promise<Presence> {
    const path = this.#presencePath(session);
    const started = this.#clock.performance.now();
    for (;;) {
      const presence = Presence.tryOpen(path);
      if (presence) return presence;
      if (this.#clock.performance.now() - started > PRESENCE_PATIENCE) {
        throw new Error(
          `The presence file ${JSON.stringify(path)} stayed locked for 1 second, but it belongs to one session only. Another program opened it.`,
        );
      }
      await nextTurn();
    }
  }

  /** Each session id with the files it has. Drafts of `atomicWrite` are no files of a session. */
  async #list(): Promise<Map<string, { record: boolean; presence: boolean }>> {
    let names: string[];
    try {
      names = await readdir(this.#path);
    } catch (error) {
      // No store recorded a session in this directory yet.
      if (isErrno(error, 'ENOENT')) return new Map();
      throw error;
    }
    const sessions = new Map<string, { record: boolean; presence: boolean }>();
    for (const name of names) {
      const [session, kind, ...rest] = name.split('.');
      if (!session || rest.length > 0) continue;
      const files = sessions.get(session) ?? { record: false, presence: false };
      if (kind === 'json') files.record = true;
      else if (kind === 'presence') files.presence = true;
      else continue;
      sessions.set(session, files);
    }
    return sessions;
  }

  /** `undefined` when the record is gone: its session was disposed since the listing, and holds no key. */
  async #leaseDuration(session: string): Promise<number | undefined> {
    const path = this.#recordPath(session);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw error;
    }
    const content: unknown = JSON.parse(text);
    if (
      !isRecord(content) ||
      typeof content.leaseDuration !== 'number' ||
      !(content.leaseDuration > 0)
    ) {
      throw new Error(
        `The session record ${JSON.stringify(path)} has no lease duration. Another program wrote it. Stop every process that uses this lock directory, then delete the folder "sessions".`,
      );
    }
    return content.leaseDuration;
  }
}

/** Deletes `path`, trying again for a limited time while Windows refuses. A file that is gone already is no fault: a recovery deletes the files of a session that it found stopped. */
async function deleteFile(path: string, clock: Clock): Promise<void> {
  try {
    await patiently(() => unlink(path), { clock });
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
}

/** The record and the presence of one session. */
export class SessionRecord implements AsyncDisposable {
  readonly #ending = new AsyncDisposableStack();

  constructor(recordPath: string, presence: Presence, clock: Clock) {
    this.#ending.defer(async () => {
      try {
        await deleteFile(recordPath, clock);
      } catch (error) {
        presence[Symbol.dispose]();
        throw error;
      }
      await presence.remove({ clock });
    });
  }

  /** Deletes the record first and removes the presence second, so the presence outlasts the record. A record that cannot be deleted still ends the presence. A second disposal does nothing. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.#ending.disposeAsync();
  }
}
