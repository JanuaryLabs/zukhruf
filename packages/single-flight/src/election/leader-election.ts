import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

import { assertLocalDirectory } from '../local-directory/local-directory.ts';
import { durableWrite } from '../shared/fs/durable-write.ts';
import { isErrno } from '../shared/fs/errno.ts';
import { isBusy } from '../shared/sqlite/is-busy.ts';
import { Leadership } from './leadership.ts';

export interface LeaderElectionOptions {
  /** Milliseconds between attempts while another process coordinates. */
  pollInterval?: number;
}

export interface CampaignOptions {
  /** Milliseconds to keep trying before conceding to the current coordinator. */
  timeout?: number;
}

/**
 * Elects the coordinator among the processes sharing `directory`. The claim is
 * an exclusive SQLite transaction on `flight.lock`, held for the whole term, so
 * the kernel ends the term if the coordinator dies. Each term gets a higher
 * epoch than every term before it, recorded in `flight.epoch`. Never delete
 * `flight.lock` while campaigners run: a new file would let a second
 * coordinator win.
 */
export class LeaderElection {
  readonly #directory: string;
  readonly #pollInterval: number;

  constructor(
    directory: string,
    { pollInterval = 10 }: LeaderElectionOptions = {},
  ) {
    this.#directory = directory;
    this.#pollInterval = pollInterval;
  }

  /** Resolves with the new term, or `undefined` if another process still coordinates after `timeout`. */
  async campaign({ timeout = 0 }: CampaignOptions = {}): Promise<
    Leadership | undefined
  > {
    await assertLocalDirectory(this.#directory);
    await mkdir(this.#directory, { recursive: true });
    // A busy timeout above zero would block this process's event loop while it
    // waits, so the claim is retried here instead.
    const claim = new DatabaseSync(join(this.#directory, 'flight.lock'), {
      timeout: 0,
    });
    const deadline = performance.now() + timeout;
    try {
      for (;;) {
        if (this.#tryClaim(claim))
          return new Leadership(await this.#nextEpoch(), claim);
        if (performance.now() >= deadline) break;
        await delay(this.#pollInterval);
      }
    } catch (error) {
      claim.close();
      throw error;
    }
    claim.close();
    return undefined;
  }

  #tryClaim(claim: DatabaseSync): boolean {
    try {
      claim.exec('BEGIN EXCLUSIVE');
      return true;
    } catch (error) {
      if (isBusy(error)) return false;
      throw error;
    }
  }

  /** Safe without further locking: only the claim holder gets here. */
  async #nextEpoch(): Promise<bigint> {
    const path = join(this.#directory, 'flight.epoch');
    const epoch = (await readEpoch(path)) + 1n;
    await durableWrite(path, epoch.toString());
    return epoch;
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
