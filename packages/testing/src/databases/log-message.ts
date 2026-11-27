import { aborted } from 'node:util';

import { type Clock, timeout as limit } from '@zukhruf/async';
import type { Container } from '@zukhruf/docker';

export interface LogMessageOptions {
  /** The number of lines with the message to wait for: a server that starts twice prints it twice. */
  times?: number;
  /** The time limit of the wait, in milliseconds. */
  timeout: number;
  /** The clock of the time limit: `globalThis` outside a test of the wait. */
  clock: Clock;
  /** Aborts the wait. The testbed aborts it when the container exits first. */
  signal: AbortSignal;
}

/**
 * Resolves when `container` has printed `times` lines that contain
 * `message`, on its standard output or its standard error, as
 * testcontainers' `Wait.forLogMessage(message, times)` does. The logs come
 * from the start of the container and then as the container writes them,
 * so a line that came before the call counts. Each stream is split into
 * lines on its own: a chunk can end in the middle of a line, and the
 * chunks of the two streams can interleave.
 *
 * When the logs end first, the container stopped: the wait ends with
 * `signal`, which the exit of the container aborts, or with the time
 * limit. A time limit rejects with how many of the lines came.
 */
export async function waitForLogMessage(
  container: Container,
  message: string,
  { times = 1, timeout, clock, signal }: LogMessageOptions,
): Promise<void> {
  // ref: a readiness wait keeps the process alive until it settles.
  using deadline = limit(timeout, { clock, ref: true });
  const waiting = AbortSignal.any([signal, deadline.signal]);
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const unended = { stdout: '', stderr: '' };
  let seen = 0;
  try {
    for await (const { stream, data } of container.followLogs({
      signal: waiting,
    })) {
      const lines = (
        unended[stream] + decoders[stream].decode(data, { stream: true })
      ).split('\n');
      unended[stream] = lines.pop() ?? '';
      seen += lines.filter((line) => line.includes(message)).length;
      if (seen >= times) return;
    }
    await aborted(waiting, container);
    waiting.throwIfAborted();
  } catch (error) {
    if (deadline.signal.aborted && error === deadline.signal.reason)
      throw new Error(
        `Container ${container.id} printed ${seen} of ${times} lines with "${message}" in ${timeout} ms`,
        { cause: error },
      );
    throw error;
  }
}
