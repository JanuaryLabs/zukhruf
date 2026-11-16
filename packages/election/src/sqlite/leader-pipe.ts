import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';

import type { Clock } from '@zukhruf/async';
import { PipeEndpoint, type PipeServer } from '@zukhruf/pipes';

/** One byte; a reader finds no meaning in its value. */
const HEARTBEAT = Buffer.of(0);

/**
 * The pipe that a leader serves for its term (ADR 0004). It sends a
 * heartbeat on each connection when it accepts it, and every
 * `heartbeatInterval` until it closes, so the heartbeat lasts as long as the
 * term. Its close is the push that tells each reader that the leader left.
 * It keeps no process alive.
 */
export class LeaderPipe {
  readonly #server: PipeServer;
  readonly #connections: Set<Socket>;
  readonly #heartbeat: Disposable;

  private constructor(
    server: PipeServer,
    connections: Set<Socket>,
    heartbeat: Disposable,
  ) {
    this.#server = server;
    this.#connections = connections;
    this.#heartbeat = heartbeat;
  }

  /**
   * Listens on a pipe with a plain random name in the default folder of the
   * user, so another user cannot connect, and a name is never used again
   * (ADR 0005).
   */
  static async serve(
    heartbeatInterval: number,
    clock: Clock,
  ): Promise<LeaderPipe> {
    const connections = new Set<Socket>();
    const endpoint = new PipeEndpoint(randomBytes(16).toHex(), {
      prefix: 'zukhruf-election',
    });
    const server = await endpoint.listen((socket) => {
      socket.unref();
      // A reader that leaves while a heartbeat is on its way is no failure of the leader.
      socket.on('error', () => {});
      connections.add(socket);
      socket.once('close', () => connections.delete(socket));
      socket.write(HEARTBEAT);
    });
    return new LeaderPipe(
      server.unref(),
      connections,
      heartbeat(connections, heartbeatInterval, clock),
    );
  }

  /** The path that the leader record publishes for the readers. */
  get address(): string {
    return this.#server.endpoint.address.path;
  }

  /** Stops the heartbeat and listening, and ends each connection, because a server keeps open connections open. */
  async close(): Promise<void> {
    this.#heartbeat[Symbol.dispose]();
    const closing = this.#server.close();
    for (const socket of this.#connections) socket.destroy();
    await closing;
  }
}

/** Sends a heartbeat on each connection every `interval` milliseconds, until disposed. */
function heartbeat(
  connections: Set<Socket>,
  interval: number,
  clock: Clock,
): Disposable {
  let timer: unknown;
  const beat = () => {
    for (const socket of connections) socket.write(HEARTBEAT);
    timer = unrefed(clock.setTimeout(beat, interval));
  };
  timer = unrefed(clock.setTimeout(beat, interval));
  return { [Symbol.dispose]: () => clock.clearTimeout(timer) };
}

/** Lets the process exit while the timer waits, when the clock's timer can. */
export function unrefed(timer: unknown): unknown {
  if (
    typeof timer === 'object' &&
    timer !== null &&
    'unref' in timer &&
    typeof timer.unref === 'function'
  ) {
    timer.unref();
  }
  return timer;
}
