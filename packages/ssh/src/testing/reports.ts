import { once } from 'node:events';
import { type Server, type Socket, createServer } from 'node:net';

import { untilAborted } from '@zukhruf/async';
import { isErrno } from '@zukhruf/fs';

/** A TCP port on 127.0.0.1 where a command of a test reports its pid on its first line, and more lines after it. */
export interface Reports extends AsyncDisposable {
  readonly port: number;
  /** The pid that the first command reported. */
  pid(signal: AbortSignal): Promise<number>;
  /** The lines of the first command, once its connection to the report port ended. */
  ended(signal: AbortSignal): Promise<string[]>;
}

/** Starts a report port. Disposal kills the reported command if it still runs, and destroys the connections. */
export async function startReports(): Promise<Reports> {
  const connected = Promise.withResolvers<Socket>();
  const sockets = new Set<Socket>();
  let received = '';
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (received += chunk));
    // The connection of a command that a test kills resets.
    socket.on('error', () => undefined);
    connected.resolve(socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: portOf(server),
    async pid(signal) {
      const socket = await untilAborted(connected.promise, signal);
      while (!received.includes('\n')) await once(socket, 'data', { signal });
      return Number(received.split('\n')[0]);
    },
    async ended(signal) {
      const socket = await untilAborted(connected.promise, signal);
      if (!socket.readableEnded) await once(socket, 'end', { signal });
      return received.split('\n').filter((line) => line !== '');
    },
    async [Symbol.asyncDispose]() {
      if (received.includes('\n')) kill(Number(received.split('\n')[0]));
      for (const socket of sockets) socket.destroy();
      const closed = once(server, 'close');
      server.close();
      await closed;
    },
  };
}

function kill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    // It has exited.
    if (!isErrno(error, 'ESRCH')) throw error;
  }
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server listens on no TCP port.');
  }
  return address.port;
}
