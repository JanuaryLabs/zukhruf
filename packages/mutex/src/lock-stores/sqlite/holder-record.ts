import { readFileSync } from 'node:fs';
import { mkdir, readdir, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { atomicWrite, isErrno, patiently } from '@zukhruf/fs';

import { Caller } from '../file-system/caller.ts';
import { Presence } from '../file-system/presence.ts';

/**
 * Names the holder of a SQLite lock in `<lock>.holder/caller`, beside the
 * holder's presence. A look reads these two files and never the lock that
 * callers wait for, so it never makes one of them busy. Only the holder of
 * the lock writes in the folder, so nobody else ever competes for its files.
 */
export class HolderRecord {
  readonly #folder: string;
  readonly #path: string;

  constructor(lockPath: string) {
    this.#folder = `${lockPath}.holder`;
    this.#path = join(this.#folder, 'caller');
  }

  /**
   * Names this caller as the holder: its presence first, then the record that
   * names it, so a look never finds a record whose presence is still to come.
   */
  async announce(): Promise<AsyncDisposable> {
    const me = Caller.current();
    await mkdir(this.#folder, { recursive: true });
    const presence = Presence.claim(Presence.pathOf(this.#path, me));
    try {
      await atomicWrite(this.#path, me.serialize());
    } catch (error) {
      await presence.withdraw();
      throw error;
    }
    await this.#clearEarlierHolders(me);
    return {
      [Symbol.asyncDispose]: () =>
        presence.releaseAfter(() => patiently(() => unlink(this.#path))),
    };
  }

  /** Whether the holder that the record names still runs. Writes nothing. */
  isPresent(): Promise<boolean> {
    return Presence.isNamedCallerPresent(this.#path, () => this.#read());
  }

  /**
   * Every other file in the folder was left by an earlier holder that stopped
   * before it removed its own. Such a file locks nothing, so a delete that
   * fails leaves it for the next holder and never fails this grant.
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
        .map((name) => unlink(join(this.#folder, name)).catch(() => {})),
    );
  }

  async #read(): Promise<Caller | undefined> {
    let content: string;
    try {
      // A synchronous read opens and closes the file in one call, so Windows
      // can still replace the record while looks read it.
      content = await patiently(async () => readFileSync(this.#path, 'utf8'));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw error;
    }
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
