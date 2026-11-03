import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type Socket, connect, createServer } from 'node:net';

/** Where a server listens. */
export interface Endpoint {
  host: string;
  port: number;
}

/**
 * A TCP proxy in front of `target`. `partition()` stops forwarding in both
 * directions and closes no socket: the network stopped without a reset.
 */
export async function proxyTo(target: Endpoint) {
  const partitioned = new AbortController();
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(target.port, target.host);
    for (const [from, to] of [
      [client, upstream],
      [upstream, client],
    ] as const) {
      sockets.add(from);
      from.on('error', () => {});
      from.on('close', () => to.destroy());
      from.on('data', (chunk) => {
        if (!partitioned.signal.aborted) to.write(chunk);
      });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    host: '127.0.0.1',
    port: address.port,
    partition: () => partitioned.abort(),
    [Symbol.asyncDispose]: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
