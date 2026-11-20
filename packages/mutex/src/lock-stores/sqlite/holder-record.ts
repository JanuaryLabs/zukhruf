import { mkdir, readdir, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { Clock } from '@zukhruf/async';
import { atomicWrite, isErrno, patiently } from '@zukhruf/fs';

import { Caller } from '../file-system/caller.ts';
import { Presence } from '../file-system/presence.ts';
import { readRecord } from '../file-system/record-file.ts';

/**
 * Names the holder of a SQLite lock in `<lock>.holder/caller`, beside the
 * holder's presence. A look reads these two files and never the lock that
 * callers wait for, so it never makes one of them busy. Only the holder of
 * the lock writes in the folder, so nobody else ever competes for its files.
 */
export class HolderRecord {
  readonly #folder: string;
  readonly #path: string;
  readonly #clock: Clock;

  constructor(lockPath: string, clock: Clock) {
    this.#folder = `${lockPath}.holder`;
    this.#path = join(this.#folder, 'caller');
    this.#clock = clock;
  }

  /**
   * Names this caller as the holder: its presence first, then the record that
   * names it, so a look never finds a record whose presence is still to come.
   */
  async announce(): Promise<AsyncDisposable> {
    const me = Caller.current();
    await mkdir(this.#folder, { recursive: true });
    await using announcing = new AsyncDisposableStack();
    const presence = announcing.adopt(
      Presence.claim(this.#path, me, this.#clock),
      (claimed) => claimed.withdraw(),
    );
    await atomicWrite(this.#path, me.serialize(), { clock: this.#clock });
    announcing.move();
    // A clearing that fails takes this caller's record and presence back, so no look finds a holder that let the lock go.
    await using announced = new AsyncDisposableStack();
    announced.defer(() =>
      presence.releaseAfter(() =>
        patiently(() => unlink(this.#path), { clock: this.#clock }),
      ),
    );
    await this.#clearEarlierHolders(me);
    return announced.move();
  }

  /** Whether the holder that the record names still runs. Writes nothing. */
  isPresent(): Promise<boolean> {
    return Presence.isNamedCallerPresent(this.#path, () => this.#read());
  }

  /**
   * Every other file in the folder was left by an earlier holder that stopped
   * before it removed its own. Such a file locks nothing, so a delete that
   * Windows refuses (ADR 0011), for example while a virus scanner holds the
   * file, leaves it for the next holder and never fails this grant.
   */
  async #clearEarlierHolders(me: Caller) {
    const mine = new Set([
      basename(this.#path),
      basename(Presence.pathOf(this.#path, me)),
    ]);
    const names = await readdir(this.#folder).catch(() => []);
    await Promise.all(
      names
        .filter((name) => !mine.has(name))
        .map(async (name) => {
          try {
            await unlink(join(this.#folder, name));
          } catch (error) {
            if (!isRefusedByWindows(error)) throw error;
          }
        }),
    );
  }

  async #read(): Promise<Caller | undefined> {
    const content = await readRecord(this.#path, this.#clock);
    if (content === undefined) return undefined;
    try {
      return Caller.parse(content);
    } catch (error) {
      // The record is replaced in one step, so only a machine that stopped
      // mid-write leaves one that cannot be read, and it names nobody who runs.
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  }
}

/** The codes of a Windows refusal, as `patiently` of `@zukhruf/fs` reads them (ADR 0011). */
function isRefusedByWindows(error: unknown): boolean {
  return (
    process.platform === 'win32' &&
    ['EPERM', 'EACCES', 'EBUSY'].some((code) => isErrno(error, code))
  );
}
