import type { FileLock } from '@zukhruf/fs';

import type { LeaderPipe } from './leader-pipe.ts';

/** What an attempt closes besides its lock: nothing while it campaigns, its pipe once it leads. */
interface Phase {
  close(): Promise<void>;
}

class Campaigning implements Phase {
  async close(): Promise<void> {}
}

class Leading implements Phase {
  readonly #pipe: LeaderPipe;

  constructor(pipe: LeaderPipe) {
    this.#pipe = pipe;
  }

  close(): Promise<void> {
    return this.#pipe.close();
  }
}

/** One attempt of a candidate: the file lock, the pipe that it serves after a win, and the count of its back-off waits. */
export class SqliteAttempt {
  readonly lock: FileLock;
  /** The waits of the back-off since the last connect that succeeded. */
  retries = 0;
  #phase: Phase = new Campaigning();

  constructor(lock: FileLock) {
    this.lock = lock;
  }

  /** The claim is won: the attempt serves `pipe` until it closes. */
  lead(pipe: LeaderPipe): void {
    this.#phase = new Leading(pipe);
  }

  /** Frees the lock first, so a reader that the close of the pipe wakes finds the claim free (ADR 0007). */
  async close(): Promise<void> {
    this.lock[Symbol.dispose]();
    await this.#phase.close();
  }
}
