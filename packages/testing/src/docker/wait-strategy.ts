import type { Container } from '@zukhruf/docker';

/**
 * Resolves when the service of a container is ready, and rejects when it
 * cannot become ready. The testbed aborts `signal` at the startup time limit
 * and when the container stops.
 */
export type WaitStrategy<Target> = (
  target: Target,
  signal: AbortSignal,
) => Promise<void>;

/** How an acquisition waits until its container is ready: a strategy and its startup time limit, in milliseconds. */
export interface Wait<Target> {
  until: WaitStrategy<Target>;
  timeout: number;
}

/**
 * Waits for the `times`-th line, since the container started, that contains
 * `message` or matches it, on standard output or standard error, as
 * testcontainers' `Wait.forLogMessage(message, times)` does. A line that came
 * before the call counts; a line of an earlier run of a restarted container
 * does not. Each stream is split into lines on its own: the engine sends a line
 * of more than 16 KiB as more than one frame, and a frame of the other stream
 * can come between them. When the logs end before the line, the container
 * stopped, and the wait rejects.
 */
export function forLogMessage(
  message: string | RegExp,
  { times = 1 }: { times?: number } = {},
): WaitStrategy<{ container: Container }> {
  const matches =
    typeof message === 'string'
      ? (line: string) => line.includes(message)
      : (line: string) => {
          message.lastIndex = 0;
          return message.test(line);
        };
  return async ({ container }, signal) => {
    const { State } = await container.inspect({ signal });
    const since = Date.parse(State?.StartedAt ?? '') / 1000;
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    const unended = { stdout: '', stderr: '' };
    let seen = 0;
    for await (const { stream, data } of container.followLogs({
      since,
      signal,
    })) {
      const lines = (
        unended[stream] + decoders[stream].decode(data, { stream: true })
      ).split('\n');
      unended[stream] = lines.pop() ?? '';
      seen += lines.filter(matches).length;
      if (seen >= times) return;
    }
    throw new Error(
      `The logs of container ${container.id} ended after ${seen} of ${times} lines with ${String(message)}`,
    );
  };
}
