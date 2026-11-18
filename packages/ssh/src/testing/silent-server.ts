import { once } from 'node:events';
import { type Server, type Socket, createServer } from 'node:net';

/** A TCP server on 127.0.0.1 that accepts each connection and never speaks. Disposal destroys the connections and closes the server. */
export async function startSilentServer(): Promise<
  AsyncDisposable & { port: number; accepted: Promise<unknown> }
> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => sockets.add(socket));
  const accepted = once(server, 'connection');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: portOf(server),
    accepted,
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server listens on no TCP port.');
  }
  return address.port;
}
