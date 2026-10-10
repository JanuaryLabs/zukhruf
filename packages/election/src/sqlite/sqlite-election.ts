import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  FileLock,
  assertLocalDirectory,
  durableWrite,
  isErrno,
} from '@zukhruf/fs';

import { LeaderElection } from '../leader-election.ts';

export interface SqliteElectionOptions {
  /** The local folder where the candidates meet. */
  directory: string;
  /**
   * The file in `directory` whose file lock is the claim.
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
 * The claim is the file lock of `claimFile`, held for the whole term. The
 * kernel keeps that lock until the leader's process dies, so a living leader
 * never loses its term, and a dead one frees it at once.
 */
export class SqliteElection extends LeaderElection<FileLock> {
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

  protected async open(): Promise<FileLock> {
    await assertLocalDirectory(this.#directory);
    await mkdir(this.#directory, { recursive: true });
    return FileLock.open(this.#claimPath);
  }

  protected async tryClaim(claim: FileLock): Promise<bigint | undefined> {
    if (!claim.tryLock()) return undefined;
    // Safe without further locking: only the holder of the claim gets here.
    const epoch = (await readEpoch(this.#epochPath)) + 1n;
    await durableWrite(this.#epochPath, epoch.toString());
    return epoch;
  }

  /** The kernel holds the claim for as long as the process lives, so there is nothing to watch. */
  protected watch(): Disposable {
    return { [Symbol.dispose]() {} };
  }

  protected async release(claim: FileLock): Promise<void> {
    claim.unlock();
  }

  protected async close(claim: FileLock): Promise<void> {
    claim[Symbol.dispose]();
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
