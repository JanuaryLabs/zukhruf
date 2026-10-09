import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { assertLocalDirectory, durableWrite, isErrno } from '@zukhruf/fs';

import { LeaderElection } from '../leader-election.ts';
import { isBusy } from './is-busy.ts';

export interface SqliteElectionOptions {
  /** The local folder where the candidates meet. */
  directory: string;
  /**
   * The SQLite file in `directory` whose exclusive transaction is the claim.
   * Never delete it while candidates run: a new file would let a second
   * leader win.
   */
  claimFile: string;
  /** The file in `directory` that records the epoch of the last term, as decimal text. */
  epochFile: string;
  /** Milliseconds between two tries while another process leads. Defaults to 10. */
  pollInterval?: number | undefined;
}

/**
 * Elects one leader among the processes of one host that share `directory`.
 * The claim is an exclusive SQLite transaction on `claimFile`, held for the
 * whole term. The kernel keeps that lock until the leader's process dies, so
 * a living leader never loses its term, and a dead one frees it at once.
 */
export class SqliteElection extends LeaderElection<DatabaseSync> {
  readonly #directory: string;
  readonly #claimPath: string;
  readonly #epochPath: string;

  constructor({
    directory,
    claimFile,
    epochFile,
    pollInterval = 10,
  }: SqliteElectionOptions) {
    super(pollInterval);
    this.#directory = directory;
    this.#claimPath = join(directory, claimFile);
    this.#epochPath = join(directory, epochFile);
  }

  protected async open(): Promise<DatabaseSync> {
    await assertLocalDirectory(this.#directory);
    await mkdir(this.#directory, { recursive: true });
    // A busy timeout above zero would block this process's event loop while it
    // waits, so the campaign tries the claim again instead.
    return new DatabaseSync(this.#claimPath, { timeout: 0 });
  }

  protected async tryClaim(claim: DatabaseSync): Promise<bigint | undefined> {
    try {
      claim.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      if (isBusy(error)) return undefined;
      throw error;
    }
    // Safe without further locking: only the holder of the claim gets here.
    const epoch = (await readEpoch(this.#epochPath)) + 1n;
    await durableWrite(this.#epochPath, epoch.toString());
    return epoch;
  }

  /** The kernel holds the claim for as long as the process lives, so there is nothing to watch. */
  protected watch(): Disposable {
    return { [Symbol.dispose]() {} };
  }

  protected async release(claim: DatabaseSync): Promise<void> {
    claim.exec('ROLLBACK');
  }

  protected async close(claim: DatabaseSync): Promise<void> {
    claim.close();
  }
}

async function readEpoch(path: string): Promise<bigint> {
  try {
    return BigInt(await readFile(path, 'utf8'));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 0n;
    throw error;
  }
}
