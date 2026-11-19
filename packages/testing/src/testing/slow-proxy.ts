import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type Socket, createServer, connect as dial } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * A TCP proxy to `target`. After `slowDown(ms)`, it forwards what a client
 * sends, and its end, `ms` later, so a client's goodbye reaches the server
 * late. A client's socket closes only once the server closed its side.
 */
export async function slowProxy(target: { host: string; port: number }) {
  let delay = 0;
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (client) => {
    connections++;
    const upstream = dial(target.port, target.host);
    sockets.add(client).add(upstream);
    const later = (send: () => void) =>
      delay === 0 ? send() : void sleep(delay).then(send);
    client.on('data', (chunk) => later(() => upstream.write(chunk)));
    client.on('end', () => later(() => upstream.end()));
    upstream.pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    host: '127.0.0.1',
    port: address.port,
    connections: () => connections,
    slowDown: (ms: number) => {
      delay = ms;
    },
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}
