import { socketElection } from '../lock-stores/socket/socket-election.ts';

/**
 * On disposal, wins the next term of the socket stores in `directory` and
 * resigns it. A leader that a test killed leaves the socket file of its
 * election pipe in the temporary folder of the system. The winner of the next
 * term removes that file, and its resign removes its own (election ADR 0005).
 * Dispose it after each process of the test ended: a live leader keeps the
 * term, and then nothing is removed.
 */
export function succeedLastLeader(directory: string): AsyncDisposable {
  return {
    async [Symbol.asyncDispose]() {
      const term = await socketElection(directory, globalThis).campaign();
      await term?.resign();
    },
  };
}
