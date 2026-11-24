import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { Backoff, type Clock, delay } from '@zukhruf/async';
import {
  FileLock,
  assertLocalDirectory,
  atomicWrite,
  durableWrite,
  isErrno,
} from '@zukhruf/fs';

import { LeaderElection } from '../leader-election.ts';
import type { Term } from '../term.ts';
import { LeaderObserver } from './leader-observer.ts';
import { LeaderPipe } from './leader-pipe.ts';
import { readLeader } from './leader-reader.ts';
import { readLeaderRecord, writeLeaderRecord } from './leader-record.ts';
import { SqliteAttempt } from './sqlite-attempt.ts';

export interface SqliteElectionOptions {
  /** The local folder where the candidates meet. */
  directory: string;
  /**
   * The file in `directory` whose file lock is the claim.
   * Never delete it while candidates run: a new file would let a second
   * leader win. A term that resigns clean writes `<claimFile>.clean` beside
   * it, and the next term reads and removes it. Each leader writes its
   * record to `<claimFile>.leader`.
   */
  claimFile: string;
  /** The file in `directory` that records the epoch of the last term, as decimal text. */
  epochFile: string;
  /**
   * The longest silence, in milliseconds, that a candidate or an observer
   * accepts from this election's leader before it ends that leader. The
   * leader record holds it, so a reader uses the leader's value. Defaults to
   * 15000, as Kubernetes' `LeaseDuration`.
   */
  leaseDuration?: number | undefined;
  /**
   * Milliseconds between two heartbeats of a leader. Defaults to a third of
   * `leaseDuration`, as etcd's client sends a keepalive every TTL / 3.
   */
  heartbeatInterval?: number | undefined;
  /** The clock that the campaign waits on, and that times the heartbeats and their deadline: `globalThis` in production, a fake clock in a test. */
  clock: Clock;
}

/**
 * The wait after a connect that found no pipe: etcd's first retry of 25 ms,
 * gRPC's multiplier of 1.6 and jitter of ±20 %, at most 1000 ms (ADR 0007).
 */
const backoff = new Backoff({
  initial: 25,
  multiplier: 1.6,
  max: 1000,
  jitter: { kind: 'ratio', ratio: 0.2 },
});

/**
 * Elects one leader among the processes of one host that share `directory`.
 * The claim is the file lock of `claimFile`, held for the whole term. The
 * kernel keeps that lock until the leader's process dies, so a dead leader
 * frees it at once. A leader serves a pipe and pushes a heartbeat on it; a
 * candidate waits on that pipe, and ends a leader that stays silent past its
 * lease duration (ADR 0004 to 0007). Its name is the path of the claim
 * file, so two elections on one claim file are one election (ADR 0010).
 */
export class SqliteElection extends LeaderElection<SqliteAttempt> {
  readonly #directory: string;
  readonly #claimPath: string;
  readonly #epochPath: string;
  readonly #cleanShutdownPath: string;
  readonly #recordPath: string;
  readonly #leaseDuration: number;
  readonly #heartbeatInterval: number;

  constructor({
    directory,
    claimFile,
    epochFile,
    leaseDuration = 15_000,
    heartbeatInterval = leaseDuration / 3,
    clock,
  }: SqliteElectionOptions) {
    const claimPath = join(directory, claimFile);
    super(claimPath, clock);
    if (!(heartbeatInterval > 0 && heartbeatInterval < leaseDuration)) {
      throw new RangeError(
        `heartbeatInterval (${heartbeatInterval}) must be above 0 and below leaseDuration (${leaseDuration}).`,
      );
    }
    this.#directory = directory;
    this.#claimPath = claimPath;
    this.#epochPath = join(directory, epochFile);
    this.#cleanShutdownPath = `${this.#claimPath}.clean`;
    this.#recordPath = `${this.#claimPath}.leader`;
    this.#leaseDuration = leaseDuration;
    this.#heartbeatInterval = heartbeatInterval;
  }

  /**
   * The epoch of the last term on disk, or 0 when no term was won yet. It
   * only reads the epoch file: it does not campaign, take the claim, or
   * create a file. A new term can begin as soon as it returns, so the answer
   * can already be stale.
   */
  lastEpoch(): Promise<bigint> {
    return readEpoch(this.#epochPath);
  }

  /**
   * Observes the leader of this term without campaigning, after etcd's
   * `Election.Observe`. The observer ends a leader that stays silent past
   * its lease duration, as a waiting candidate does.
   */
  observe(): LeaderObserver {
    return new LeaderObserver(this.#recordPath, this.clock);
  }

  protected async open(): Promise<SqliteAttempt> {
    await assertLocalDirectory(this.#directory);
    await mkdir(this.#directory, { recursive: true });
    return new SqliteAttempt(FileLock.open(this.#claimPath));
  }

  protected async tryClaim(
    attempt: SqliteAttempt,
  ): Promise<Pick<Term, 'epoch' | 'afterCleanShutdown'> | undefined> {
    if (!attempt.lock.tryLock()) return undefined;
    // Safe without further locking: only the holder of the claim gets here.
    const previous = await readEpoch(this.#epochPath);
    // Only a note that names the epoch just before this one tells of a clean
    // shutdown: an older note is from a term that ended long ago.
    const afterCleanShutdown =
      (await readCleanShutdown(this.#cleanShutdownPath)) ===
      previous.toString();
    const epoch = previous + 1n;
    await durableWrite(this.#epochPath, epoch.toString(), {
      clock: this.clock,
    });
    // Read once: if the epochs ever start again, an old note could name one of them.
    await rm(this.#cleanShutdownPath, { force: true });
    await this.#removePreviousPipe();
    // The record names a pipe that listens, or listened (ADR 0005).
    const pipe = await LeaderPipe.serve(this.#heartbeatInterval, this.clock);
    attempt.lead(pipe);
    await writeLeaderRecord(
      this.#recordPath,
      {
        epoch,
        processId: process.pid,
        address: pipe.address,
        leaseDuration: this.#leaseDuration,
      },
      this.clock,
    );
    return { epoch, afterCleanShutdown };
  }

  /**
   * Removes the socket file of the previous term's pipe, which a killed
   * leader leaves behind, as @zukhruf/sqlite-notify's sender removes the file
   * of a dead listener. Only the holder of the claim gets here, so no process
   * serves that pipe any more. On Windows a pipe goes with its process, and
   * there is no file to remove (ADR 0005).
   */
  async #removePreviousPipe(): Promise<void> {
    if (process.platform === 'win32') return;
    const previous = await readLeaderRecord(this.#recordPath);
    if (previous !== undefined) await rm(previous.address, { force: true });
  }

  /**
   * Waits on the leader's pipe: its close, or the deadline of its heartbeat,
   * which ends the leader first. With no pipe to connect to, a new leader is
   * starting or a published one leads, so it waits the back-off (ADR 0007).
   */
  protected async waitForChange(
    attempt: SqliteAttempt,
    signal: AbortSignal,
  ): Promise<void> {
    const left = await readLeader(this.#recordPath, {
      clock: this.clock,
      ref: true,
      signal,
    });
    if (left === 'absent') {
      await delay(backoff.duration(attempt.retries++), {
        clock: this.clock,
        signal,
      });
      return;
    }
    attempt.retries = 0;
  }

  /**
   * The kernel holds the claim for as long as the process lives, so nothing
   * takes it away. The heartbeat is no part of the watch: the term's pipe
   * sends it from the win until the term closes (ADR 0004), also under a
   * subclass that overrides `watch`.
   */
  protected watch(): Disposable {
    return { [Symbol.dispose]() {} };
  }

  /**
   * A lost note costs the next term only its recovery, so the note needs no
   * sync to the disk: an atomic replace is enough, and a reader never sees a
   * part of it.
   */
  protected async recordCleanShutdown(
    _attempt: SqliteAttempt,
    epoch: bigint,
  ): Promise<void> {
    await atomicWrite(this.#cleanShutdownPath, epoch.toString(), {
      clock: this.clock,
    });
  }

  protected async release(attempt: SqliteAttempt): Promise<void> {
    attempt.lock.unlock();
  }

  protected close(attempt: SqliteAttempt): Promise<void> {
    return attempt.close();
  }
}

/** The epoch that the note names, as its text, or `undefined` when there is no note. */
async function readCleanShutdown(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/**
 * The epoch of the last term, or 0 when there is no epoch file. Only decimal
 * digits are an epoch: `BigInt` alone would also read `''` as 0, and the
 * epochs would start again at 1.
 */
async function readEpoch(path: string): Promise<bigint> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 0n;
    throw error;
  }
  if (!/^\d+$/.test(text))
    throw new SyntaxError(
      `The epoch file ${path} holds ${JSON.stringify(text)}, not decimal digits.`,
    );
  return BigInt(text);
}
