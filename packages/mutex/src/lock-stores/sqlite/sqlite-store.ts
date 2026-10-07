import { DatabaseSync } from 'node:sqlite';

import type { LockHandle } from '../../mutex/lease.ts';
import type { AcquireOptions } from '../../mutex/lock-store.ts';
import { isBusy } from '../../shared/sqlite/is-busy.ts';
import { FileLockStore } from '../file-system/file-lock-store.ts';
import { MemoryStore } from '../memory/memory-store.ts';
import { HolderRecord } from './holder-record.ts';

/**
 * Holds an exclusive SQLite transaction on the key's database file. SQLite
 * locks through the kernel, which releases them when the holder dies, so a
 * crash never leaves a key locked. Keep the default rollback journal: in WAL
 * mode an exclusive transaction no longer blocks readers.
 *
 * Even a read of that file makes it busy for a caller that tries to take it,
 * so the holder also names itself in a holder record, which a look reads
 * instead.
 *
 * Callers in this process first line up in a queue in memory, so only the
 * first one opens a database connection: one open file per key per process,
 * however many callers wait, and first-come order within the process.
 */
export class SqliteStore extends FileLockStore {
  /**
   * SQLite keeps the rollback journal of a key's database at `<path>-journal`.
   * The holder folder `<path>.holder` is shorter, so a key keeps the file name
   * that versions without the folder gave it.
   */
  protected readonly longestSuffix = '-journal'.length;
  readonly #inProcess = new MemoryStore();

  override async acquire(
    key: string,
    options: AcquireOptions = {},
  ): Promise<LockHandle> {
    // Joining the in-process queue is synchronous, so the order is the order of the calls.
    const turn = await this.#inProcess.acquire(key, options);
    try {
      return withTurn(await super.acquire(key, options), turn);
    } catch (error) {
      await turn[Symbol.asyncDispose]();
      throw error;
    }
  }

  override async tryAcquire(key: string): Promise<LockHandle | undefined> {
    const turn = await this.#inProcess.tryAcquire(key);
    if (!turn) return undefined;
    try {
      const lease = await super.tryAcquire(key);
      if (lease) return withTurn(lease, turn);
    } catch (error) {
      await turn[Symbol.asyncDispose]();
      throw error;
    }
    await turn[Symbol.asyncDispose]();
    return undefined;
  }

  protected async lock(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<AsyncDisposable> {
    const database = new DatabaseSync(path, { timeout: 0 });
    try {
      await this.poll(async () => (begin(database) ? true : undefined), {
        signal,
      });
    } catch (error) {
      database.close();
      throw error;
    }
    return holding(path, database);
  }

  protected async tryLock(path: string): Promise<AsyncDisposable | undefined> {
    const database = new DatabaseSync(path, { timeout: 0 });
    let begun: boolean;
    try {
      begun = begin(database);
    } catch (error) {
      database.close();
      throw error;
    }
    if (begun) return holding(path, database);
    database.close();
    return undefined;
  }

  protected isHeldAt(path: string): Promise<boolean> {
    return new HolderRecord(path).isPresent();
  }
}

/** Starts the exclusive transaction, or reports that another connection holds it. */
function begin(database: DatabaseSync): boolean {
  try {
    database.exec('BEGIN EXCLUSIVE');
    return true;
  } catch (error) {
    if (isBusy(error)) return false;
    throw error;
  }
}

/** Names the holder of the transaction. The transaction ends however that, or the release of the record, goes. */
async function holding(
  path: string,
  database: DatabaseSync,
): Promise<AsyncDisposable> {
  const record = await new HolderRecord(path)
    .announce()
    .catch((error: unknown) => {
      unlock(database);
      throw error;
    });
  return {
    [Symbol.asyncDispose]: async () => {
      try {
        await record[Symbol.asyncDispose]();
      } finally {
        unlock(database);
      }
    },
  };
}

function unlock(database: DatabaseSync) {
  try {
    database.exec('ROLLBACK');
  } finally {
    database.close();
  }
}

/** Releases the database lock first, then lets the next caller in this process try. */
function withTurn(handle: LockHandle, turn: AsyncDisposable): LockHandle {
  return {
    token: handle.token,
    signal: handle.signal,
    [Symbol.asyncDispose]: async () => {
      try {
        await handle[Symbol.asyncDispose]();
      } finally {
        await turn[Symbol.asyncDispose]();
      }
    },
  };
}
